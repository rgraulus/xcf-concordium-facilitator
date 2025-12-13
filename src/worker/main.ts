// src/worker/main.ts
//
// M3 CRP stream worker (PLT-focused).
//
// Polls a PLT source (wallet-proxy-backed Concordium source) and writes
// canonical PLT events into Postgres via crp_plt_events.

import "dotenv/config";

import {
  createConcordiumNodeConfigFromEnv,
  ConcordiumPltSource,
} from "./pltSource.concordium";

import {
  insertPltTransfers,
  PltEventInsertInput,
} from "../store/plt.pg";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_TICKS = 3;

type SourceKind = "concordium";

interface WorkerConfig {
  pollIntervalMs: number;
  dryRun: boolean;
  lastHeight: number;
  maxTicks: number;
  sourceKind: SourceKind;
}

function loadWorkerConfigFromEnv(): WorkerConfig {
  const pollIntervalMs = Number(
    process.env.CRP_STREAM_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS
  );
  const maxTicks = Number(process.env.CRP_STREAM_MAX_TICKS ?? DEFAULT_MAX_TICKS);
  const dryRun =
    process.env.CRP_STREAM_DRY_RUN === "1" ||
    process.env.CRP_STREAM_DRY_RUN === "true";
  const lastHeight = Number(process.env.CRP_STREAM_LAST_HEIGHT ?? 0);
  const sourceKind: SourceKind =
    (process.env.CRP_STREAM_SOURCE as SourceKind) ?? "concordium";

  return { pollIntervalMs, dryRun, lastHeight, maxTicks, sourceKind };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorker(
  source: ConcordiumPltSource,
  cfg: WorkerConfig,
  state: { lastHeightExclusive: number }
): Promise<void> {
  console.log("[CRP-STREAM] starting worker with config:", {
    pollIntervalMs: cfg.pollIntervalMs,
    dryRun: cfg.dryRun,
    lastHeight: state.lastHeightExclusive,
    maxTicks: cfg.maxTicks,
    sourceKind: cfg.sourceKind,
  });

  let tick = 0;

  while (true) {
    tick += 1;
    if (cfg.maxTicks > 0 && tick > cfg.maxTicks) {
      console.log("[CRP-STREAM] maxTicks (%d) reached, stopping loop.", cfg.maxTicks);
      break;
    }

    const { events, bestHeight } = await source.fetchSince(state.lastHeightExclusive);

    console.log(
      "[CRP-STREAM] fetched %d PLT event(s) above cursor %d (best=%d)",
      events.length,
      state.lastHeightExclusive,
      bestHeight
    );

    if (events.length > 0) {
      const rows: PltEventInsertInput[] = events.map((ev) => ({
        block_hash: ev.blockHash,
        block_height: ev.blockHeight,
        transaction_hash: ev.transactionHash,
        event_index: ev.eventIndex,

        network: ev.network,
        network_genesis_index: ev.networkGenesisIndex,
        finalized: ev.finalized,

        event_type: ev.eventType,
        from_address: ev.fromAddress,
        to_address: ev.toAddress,

        amount_raw: ev.amountRaw,
        asset_id: ev.assetId,

        occurred_at: ev.occurredAt,
      }));

      if (!cfg.dryRun) {
        const { inserted } = await insertPltTransfers(rows);

        const last = rows[rows.length - 1];
        console.log("[CRP-STREAM] inserted PLT events:", {
          inserted,
          last: {
            block_height: last.block_height,
            transaction_hash: last.transaction_hash,
            asset_id: last.asset_id,
            amount_raw: last.amount_raw,
          },
        });
      } else {
        console.log("[CRP-STREAM] dryRun=1, would insert rows:", rows.length);
      }
    }

    state.lastHeightExclusive = bestHeight;

    if (cfg.pollIntervalMs > 0) {
      await sleep(cfg.pollIntervalMs);
    }
  }
}

export async function runDemo(): Promise<void> {
  const cfg = loadWorkerConfigFromEnv();

  console.log("[CRP-STREAM] demo runner starting with config:", {
    pollIntervalMs: cfg.pollIntervalMs,
    dryRun: cfg.dryRun,
    lastHeight: cfg.lastHeight,
    maxTicks: cfg.maxTicks,
    sourceKind: cfg.sourceKind,
  });

  if (cfg.sourceKind !== "concordium") {
    throw new Error(
      `Unsupported CRP_STREAM_SOURCE="${cfg.sourceKind}". Expected "concordium".`
    );
  }

  const nodeConfig = createConcordiumNodeConfigFromEnv();
  const source = new ConcordiumPltSource(nodeConfig);

  const state = { lastHeightExclusive: cfg.lastHeight };

  await runWorker(source, cfg, state);
}

if (require.main === module) {
  runDemo().catch((err) => {
    console.error("[CRP-STREAM] demo runner failed:", err);
    process.exitCode = 1;
  });
}
