// src/worker/main.ts

import "dotenv/config";
import { upsertFinalizedBlock, insertPltTransfers } from "../store/plt.pg";
import { getPltDecimals, type PltAssetKey } from "./pltDecimals";
import { FakePltEventSource, type PltEventSource } from "./pltSource";

export interface WorkerConfig {
  /** How often to poll for new events (ms). */
  pollIntervalMs: number;

  /** Network identifier, e.g. "concordium:testnet". */
  network: string;

  /** PLT token identifier, e.g. "usd:test". */
  tokenId: string;

  /** If true, do not persist anything; just log. */
  dryRun: boolean;

  /** Last processed height (inclusive). */
  lastHeight: number;

  /** Optional safety cap on the number of polling ticks. */
  maxTicks?: number;
}

/**
 * Convert a human-readable decimal amount (e.g. "25.00")
 * into integer minor units as a string (e.g. "2500" for 2 decimals).
 */
function humanToMinor(amount: string, decimals: number): string {
  const negative = amount.startsWith("-");
  const stripped = negative ? amount.slice(1) : amount;
  const [rawInt, rawFrac = ""] = stripped.split(".");

  const intPart = rawInt.replace(/^0+/, "") || "0";
  const fracPadded = rawFrac.padEnd(decimals, "0").slice(0, decimals);

  const combined = (intPart + fracPadded).replace(/^0+/, "") || "0";
  return negative ? `-${combined}` : combined;
}

/**
 * Core worker loop: polls a PLT event source and persists
 * finalized blocks + PLT transfers into the M3 tables.
 */
export async function runWorker(config: WorkerConfig): Promise<void> {
  const { pollIntervalMs, network, tokenId, dryRun, maxTicks } = config;
  let { lastHeight } = config;

  const assetKey: PltAssetKey = { network, tokenId };
  const decimals = getPltDecimals(assetKey) ?? 0;

  const source: PltEventSource = new FakePltEventSource({ network, tokenId });

  // eslint-disable-next-line no-console
  console.log(
    "[CRP-STREAM] starting worker with config:",
    {
      pollIntervalMs,
      network,
      tokenId,
      dryRun,
      lastHeight,
      maxTicks,
      decimals,
    }
  );

  let ticks = 0;
  let running = true;

  while (running) {
    ticks += 1;

    const events = await source.fetchSince(lastHeight);

    // eslint-disable-next-line no-console
    console.log(
      `[CRP-STREAM] fetched ${events.length} PLT event(s) above height ${lastHeight}`
    );

    for (const ev of events) {
      if (ev.height > lastHeight) {
        lastHeight = ev.height;
      }

      const blockHash = `demo-block-${String(ev.height).padStart(8, "0")}`;
      const finalizedAt = new Date();

      if (dryRun) {
        const minor = humanToMinor(ev.amount, decimals);
        // eslint-disable-next-line no-console
        console.log("[CRP-STREAM] (dry-run) would process PLT event:", {
          height: ev.height,
          txHash: ev.txHash,
          blockHash,
          network,
          tokenId,
          amountHuman: ev.amount,
          amountMinor: minor,
          from: ev.from ?? null,
          to: ev.to ?? "unknown",
        });
        continue;
      }

      // 1) Upsert the finalized block
      const block = await upsertFinalizedBlock({
        block_hash: blockHash,
        network,
        height: ev.height,
        finalized_at: finalizedAt,
      });

      // 2) Insert the PLT transfer in minor units
      const amountMinor = humanToMinor(ev.amount, decimals);

      const { inserted } = await insertPltTransfers([
        {
          tx_hash: ev.txHash,
          event_index: 0,
          block_hash: block.block_hash,
          network,
          token_id: tokenId,
          from_addr: ev.from ?? null,
          to_addr: ev.to ?? "unknown",
          amount_minor: amountMinor,
          decimals,
          occurred_at: finalizedAt,
        },
      ]);

      // eslint-disable-next-line no-console
      console.log(
        "[CRP-STREAM] processed PLT event:",
        {
          height: ev.height,
          txHash: ev.txHash,
          blockHash: block.block_hash,
          amountMinor,
          inserted,
        }
      );
    }

    if (typeof maxTicks === "number" && ticks >= maxTicks) {
      // eslint-disable-next-line no-console
      console.log(
        `[CRP-STREAM] maxTicks (${maxTicks}) reached, stopping loop.`
      );
      running = false;
      break;
    }

    if (!running) break;

    if (pollIntervalMs > 0 && running) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  // eslint-disable-next-line no-console
  console.log("[CRP-STREAM] worker stopped.");
}

/**
 * Demo runner that constructs a WorkerConfig with sensible defaults
 * and runs the worker for a few ticks.
 */
export async function runDemo(): Promise<void> {
  const demoConfig: WorkerConfig = {
    pollIntervalMs: 1000,
    network: "concordium:testnet",
    tokenId: "usd:test",
    dryRun: false, // set to true if you want logs-only
    lastHeight: 0,
    maxTicks: 3,
  };

  // eslint-disable-next-line no-console
  console.log(
    "[CRP-STREAM] demo runner starting with config:",
    demoConfig
  );

  try {
    await runWorker(demoConfig);
    // eslint-disable-next-line no-console
    console.log("[CRP-STREAM] demo runner finished.");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[CRP-STREAM] demo runner failed:", err);
    process.exitCode = 1;
  }
}

// Allow `ts-node src/worker/main.ts` to run the demo directly.
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  runDemo();
}
