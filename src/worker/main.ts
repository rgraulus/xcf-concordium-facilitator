// src/worker/main.ts
//
// M3 CRP stream worker (PLT-focused).
//
// This worker polls a PLT source (currently a stubbed Concordium source)
// and writes normalized PLT transfer events into Postgres via the
// crp_plt_events table (using src/store/plt.pg.ts).
//
// The Concordium integration is intentionally stubbed right now to unblock
// CI/build without relying on @concordium/web-sdk gRPC wiring. The public
// interface and logging are designed so we can swap in a real node-backed
// implementation later without touching callers.

import { createConcordiumNodeConfigFromEnv, ConcordiumPltSource } from "./pltSource.concordium";
import { insertPltTransfers, PltTransferInsertInput } from "../store/plt.pg";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_TICKS = 3;
const DEFAULT_DECIMALS = 6;

type SourceKind = "concordium";

interface WorkerConfig {
  pollIntervalMs: number;
  network: string;
  tokenId: string;
  dryRun: boolean;
  lastHeight: number;
  maxTicks: number;
  decimals: number;
  sourceKind: SourceKind;
}

/**
 * Read worker configuration from environment variables, with sensible defaults.
 */
function loadWorkerConfigFromEnv(): WorkerConfig {
  const pollIntervalMs = Number(process.env.CRP_STREAM_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  const maxTicks = Number(process.env.CRP_STREAM_MAX_TICKS ?? DEFAULT_MAX_TICKS);
  const tokenId = process.env.CRP_STREAM_TOKEN_ID ?? process.env.CONCORDIUM_PLT_TOKEN_ID ?? "EUDemo";
  const decimals = Number(process.env.CONCORDIUM_PLT_DECIMALS ?? DEFAULT_DECIMALS);
  const network = process.env.CRP_STREAM_NETWORK ?? "concordium:testnet";
  const dryRun = process.env.CRP_STREAM_DRY_RUN === "1" || process.env.CRP_STREAM_DRY_RUN === "true";
  const lastHeight = Number(process.env.CRP_STREAM_LAST_HEIGHT ?? 0);
  const sourceKind: SourceKind = (process.env.CRP_STREAM_SOURCE as SourceKind) ?? "concordium";

  return {
    pollIntervalMs,
    network,
    tokenId,
    dryRun,
    lastHeight,
    maxTicks,
    decimals,
    sourceKind,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core worker loop. Given a PLT source, continuously polls for new events
 * strictly above `state.lastHeightExclusive`, writes them to Postgres, and
 * advances the height.
 */
async function runWorker(
  source: ConcordiumPltSource,
  cfg: WorkerConfig,
  state: { lastHeightExclusive: number }
): Promise<void> {
  console.log("[CRP-STREAM] starting worker with config:", {
    pollIntervalMs: cfg.pollIntervalMs,
    network: cfg.network,
    tokenId: cfg.tokenId,
    dryRun: cfg.dryRun,
    lastHeight: state.lastHeightExclusive,
    maxTicks: cfg.maxTicks,
    decimals: cfg.decimals,
    sourceKind: cfg.sourceKind,
  });

  let tick = 0;

  while (true) {
    tick += 1;
    if (cfg.maxTicks > 0 && tick > cfg.maxTicks) {
      console.log("[CRP-STREAM] maxTicks (%d) reached, stopping loop.", cfg.maxTicks);
      break;
    }

    // Ask the source for any events above the last seen height.
    const { events, bestHeight } = await source.fetchSince(state.lastHeightExclusive);

    // Log a short summary similar to what you had before.
    console.log("[CRP-STREAM] fetched %d PLT event(s) above height %d", events.length, state.lastHeightExclusive);

    if (events.length > 0) {
      // Map into DB insert rows.
      const rows: PltTransferInsertInput[] = events.map((ev) => ({
        tx_hash: ev.txHash,
        event_index: ev.eventIndex,
        block_hash: ev.blockHash,
        block_height: ev.blockHeight,
        network: ev.network,
        token_id: ev.tokenId,
        from_addr: ev.from,
        to_addr: ev.to,
        amount_minor: ev.amountMinor,
        decimals: cfg.decimals,
        occurred_at: ev.occurredAt,
      }));

      if (!cfg.dryRun) {
        const inserted = await insertPltTransfers(rows);

        // Log at least one processed event (using the last one as a representative).
        const last = rows[rows.length - 1];
        console.log("[CRP-STREAM] processed PLT event:", {
          height: last.block_height,
          txHash: last.tx_hash,
          blockHash: last.block_hash,
          amountMinor: last.amount_minor,
          inserted,
        });
      } else {
        console.log("[CRP-STREAM] dryRun=1, would insert rows:", rows.length);
      }
    }

    // Advance last height to whatever the source reports as "best".
    state.lastHeightExclusive = bestHeight;

    // Simple polling delay.
    if (cfg.pollIntervalMs > 0) {
      await sleep(cfg.pollIntervalMs);
    }
  }
}

/**
 * Demo entrypoint used by `npm run crp:worker:demo`.
 */
export async function runDemo(): Promise<void> {
  const cfg = loadWorkerConfigFromEnv();

  console.log("[CRP-STREAM] demo runner starting with config:", {
    pollIntervalMs: cfg.pollIntervalMs,
    network: cfg.network,
    tokenId: cfg.tokenId,
    dryRun: cfg.dryRun,
    lastHeight: cfg.lastHeight,
    maxTicks: cfg.maxTicks,
  });

  if (cfg.sourceKind !== "concordium") {
    throw new Error(`Unsupported CRP_STREAM_SOURCE="${cfg.sourceKind}". Expected "concordium".`);
  }

  const nodeConfig = createConcordiumNodeConfigFromEnv();
  const source = new ConcordiumPltSource(nodeConfig);

  const state = { lastHeightExclusive: cfg.lastHeight };

  await runWorker(source, cfg, state);
}

// If this file is executed directly, run the demo worker.
if (require.main === module) {
  runDemo().catch((err) => {
    console.error("[CRP-STREAM] demo runner failed:", err);
    process.exitCode = 1;
  });
}
