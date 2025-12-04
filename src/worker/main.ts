// src/worker/main.ts
//
// CRP PLT stream worker.
//
// - Polls a PLT event source (demo or Concordium-backed).
// - Normalizes amounts into minor units.
// - Writes PLT transfers into Postgres (crp_plt_events).
//
// Env knobs:
//
//   DATABASE_URL                   -> Postgres connection string
//
//   CRP_STREAM_SOURCE              -> "demo" | "concordium" (default: "demo")
//   CRP_STREAM_NETWORK             -> logical network id (default: "concordium:testnet")
//   CRP_STREAM_TOKEN_ID            -> logical token id for CRP (e.g. "usd:test", "EUDemo")
//   CRP_STREAM_POLL_MS             -> poll interval in ms (default: 1000)
//   CRP_STREAM_MAX_TICKS           -> max loop iterations before stopping (default: 3)
//   CRP_STREAM_START_HEIGHT        -> initial lastHeight (default: 0)
//   CRP_STREAM_DRY_RUN             -> "1" to disable DB writes
//
//   CONCORDIUM_PLT_DECIMALS        -> decimals for PLT (default: 2)
//   CONCORDIUM_NODE_URL            -> Concordium node URL (grpc host:port, default in client helper)
//   CONCORDIUM_PLT_TOKEN_ID        -> on-chain PLT token id (e.g. "EUDemo"), optional;
//                                     falls back to CRP_STREAM_TOKEN_ID if not set.
//

import { makeDemoPltEventSource, PltEventSource } from "./pltSource";
import {
  ConcordiumPltEventSource,
  ConcordiumPltEventSourceConfig,
  createConcordiumPltEventClientFromEnv,
} from "./pltSource.concordium";

import {
  insertPltTransfers,
  upsertFinalizedBlock,
} from "../store/plt.pg";

interface WorkerConfig {
  pollIntervalMs: number;
  network: string;
  tokenId: string;
  dryRun: boolean;
  lastHeight: number;
  maxTicks: number;
  decimals: number;
  sourceKind: "demo" | "concordium";
}

/**
 * Read worker configuration from environment variables.
 */
function readWorkerConfigFromEnv(): WorkerConfig {
  const pollIntervalMs = Number(process.env.CRP_STREAM_POLL_MS ?? "1000");
  const network = process.env.CRP_STREAM_NETWORK ?? "concordium:testnet";
  const tokenId = process.env.CRP_STREAM_TOKEN_ID ?? "usd:test";
  const dryRun = process.env.CRP_STREAM_DRY_RUN === "1";
  const lastHeight = Number(process.env.CRP_STREAM_START_HEIGHT ?? "0");
  const maxTicks = Number(process.env.CRP_STREAM_MAX_TICKS ?? "3");

  const decimalsEnv = process.env.CONCORDIUM_PLT_DECIMALS;
  const decimals = decimalsEnv ? Number(decimalsEnv) : 2;

  const sourceRaw = (process.env.CRP_STREAM_SOURCE ?? "demo").toLowerCase();
  const sourceKind: "demo" | "concordium" =
    sourceRaw === "concordium" ? "concordium" : "demo";

  const cfg: WorkerConfig = {
    pollIntervalMs: Number.isFinite(pollIntervalMs) ? pollIntervalMs : 1000,
    network,
    tokenId,
    dryRun,
    lastHeight: Number.isFinite(lastHeight) ? lastHeight : 0,
    maxTicks: Number.isFinite(maxTicks) ? maxTicks : 3,
    decimals: Number.isFinite(decimals) ? decimals : 2,
    sourceKind,
  };

  // eslint-disable-next-line no-console
  console.log("[CRP-STREAM] demo runner starting with config:", cfg);

  return cfg;
}

/**
 * Choose the PLT event source based on the worker config.
 */
function choosePltSource(cfg: WorkerConfig): PltEventSource {
  if (cfg.sourceKind === "concordium") {
    const client = createConcordiumPltEventClientFromEnv();
    const srcCfg: ConcordiumPltEventSourceConfig = {
      network: cfg.network,
      tokenId: cfg.tokenId,
      decimals: cfg.decimals,
    };

    // eslint-disable-next-line no-console
    console.log("[CRP-STREAM] starting worker with config:", {
      ...cfg,
      sourceKind: "concordium",
    });

    return new ConcordiumPltEventSource(srcCfg, client);
  }

  // Demo / fake source.
  // eslint-disable-next-line no-console
  console.log("[CRP-STREAM] starting worker with config:", {
    ...cfg,
    sourceKind: "demo",
  });

  return makeDemoPltEventSource({
    network: cfg.network,
    tokenId: cfg.tokenId,
  });
}

/**
 * Convert a human-readable PLT amount string (e.g. "1.000000")
 * into minor units as a decimal string (e.g. "1000000" for 6 decimals).
 *
 * This avoids floating-point arithmetic by doing string manipulation.
 */
function toMinorUnits(amountStr: string, decimals: number): string {
  const trimmed = amountStr.trim();
  if (!trimmed) return "0";

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;

  const [intPartRaw, fracPartRaw = ""] = unsigned.split(".");
  const intPart = intPartRaw.replace(/^0+/, "") || "0";

  // Pad/truncate fractional part to exactly `decimals` digits.
  const fracPadded = (fracPartRaw + "0".repeat(decimals)).slice(0, decimals);

  const combined = (intPart === "0" && fracPadded === "")
    ? "0"
    : intPart + fracPadded;

  const combinedTrimmed = combined.replace(/^0+/, "") || "0";
  return negative ? "-" + combinedTrimmed : combinedTrimmed;
}

/**
 * Sleep helper for the poll loop.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core worker loop:
 *   - fetchSince(lastHeight) from the PLT source,
 *   - optionally write events to DB,
 *   - advance lastHeight,
 *   - repeat until maxTicks.
 */
async function runWorker(
  cfg: WorkerConfig,
  source: PltEventSource
): Promise<void> {
  let tick = 0;
  let lastHeight = cfg.lastHeight;

  while (tick < cfg.maxTicks) {
    tick += 1;

    const events = await source.fetchSince(lastHeight);

    // eslint-disable-next-line no-console
    console.log(
      "[CRP-STREAM] fetched",
      events.length,
      "PLT event(s) above height",
      lastHeight
    );

    if (!cfg.dryRun && events.length > 0) {
      const now = new Date();

      const dbEvents = events.map((ev, idx) => {
        const syntheticBlockHash = `demo-block-${ev.height}`;
        const amountMinor = toMinorUnits(ev.amount, cfg.decimals);

        return {
          network: cfg.network,
          token_id: cfg.tokenId,
          tx_hash: ev.txHash,
          event_index: idx,
          block_hash: syntheticBlockHash,
          block_height: ev.height,
          from_addr: ev.from ?? null,
          to_addr: ev.to ?? null,
          amount_minor: amountMinor,
          decimals: cfg.decimals,
          occurred_at: now,
        };
      });

      // Optionally upsert a "finalized block" record keyed by the last event height.
      const maxEventHeight = events.reduce(
        (max, ev) => (ev.height > max ? ev.height : max),
        lastHeight
      );
      const syntheticFinalBlockHash = `demo-block-${maxEventHeight}`;

      try {
        await upsertFinalizedBlock({
          block_hash: syntheticFinalBlockHash,
          network: cfg.network,
          height: maxEventHeight,
          finalized_at: now,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[CRP-STREAM] upsertFinalizedBlock failed (non-fatal):",
          err
        );
      }

      const res = await insertPltTransfers(dbEvents);

      events.forEach((ev) => {
        const syntheticBlockHash = `demo-block-${ev.height}`;
        const amountMinor = toMinorUnits(ev.amount, cfg.decimals);

        // eslint-disable-next-line no-console
        console.log("[CRP-STREAM] processed PLT event:", {
          height: ev.height,
          txHash: ev.txHash,
          blockHash: syntheticBlockHash,
          amountMinor,
          inserted: res.inserted,
        });
      });
    }

    // Advance lastHeight based on events we just saw.
    if (events.length > 0) {
      const maxHeight = events.reduce(
        (max, ev) => (ev.height > max ? ev.height : max),
        lastHeight
      );
      lastHeight = maxHeight;
    }

    await sleep(cfg.pollIntervalMs);
  }

  // eslint-disable-next-line no-console
  console.log("[CRP-STREAM] worker stopped.");
}

/**
 * Entry point wrapper: set up config, source, and run the worker.
 */
async function runDemo(): Promise<void> {
  const cfg = readWorkerConfigFromEnv();
  const source = choosePltSource(cfg);

  try {
    await runWorker(cfg, source);
    // eslint-disable-next-line no-console
    console.log("[CRP-STREAM] demo runner finished.");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[CRP-STREAM] demo runner failed:", err);
    process.exitCode = 1;
  }
}

void runDemo();
