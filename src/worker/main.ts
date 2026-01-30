import "dotenv/config";

import { Pool } from "pg";

import {
  createConcordiumNodeConfigFromEnv,
  ConcordiumPltSource,
} from "./pltSource.concordium";
import { createFixtureSourceFromEnv } from "./pltSource.fixture";
import { PltSource } from "./pltSource.types";

import { insertPltTransfers, PltEventInsertInput } from "../store/plt.pg";
import { getLatestAccountTransactionId } from "../services/walletProxyClient";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_TICKS = 0; // 0 = run forever

type SourceKind = "concordium" | "fixture";

interface WorkerConfig {
  pollIntervalMs: number;
  dryRun: boolean;

  // If present in env, overrides DB cursor on startup.
  // 0 means "from now" unless CRP_STREAM_ZERO_IS_GENESIS=1.
  startHeightOverride?: number;

  maxTicks: number; // 0 = forever
  sourceKind: SourceKind;

  // Cursor hygiene
  zeroIsGenesis: boolean;
  maxAheadGuard: number;
  rewindOnClamp: number;
  persistCursorInDryRun: boolean;

  // Logging hygiene
  quietWhenNoProgress: boolean; // default true
  heartbeatEveryTicks: number;  // default 10
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return defaultValue;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) ? v : defaultValue;
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return defaultValue;
}

function loadWorkerConfigFromEnv(): WorkerConfig {
  const pollIntervalMs = parseIntEnv("CRP_STREAM_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
  const maxTicks = parseIntEnv("CRP_STREAM_MAX_TICKS", DEFAULT_MAX_TICKS);
  const dryRun = parseBoolEnv("CRP_STREAM_DRY_RUN", false);

  // Persistent safety: ignore CRP_STREAM_LAST_HEIGHT unless explicitly enabled.
  const useLastHeightOverride = parseBoolEnv("CRP_STREAM_USE_LAST_HEIGHT_OVERRIDE", false);

  if (!useLastHeightOverride && Object.prototype.hasOwnProperty.call(process.env, "CRP_STREAM_LAST_HEIGHT")) {
    const raw = process.env.CRP_STREAM_LAST_HEIGHT;
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      console.log(
        "[CRP-STREAM] NOTE: CRP_STREAM_LAST_HEIGHT is set but will be ignored (set CRP_STREAM_USE_LAST_HEIGHT_OVERRIDE=true to enable it)."
      );
    }
  }

  let startHeightOverride: number | undefined = undefined;
  if (useLastHeightOverride && Object.prototype.hasOwnProperty.call(process.env, "CRP_STREAM_LAST_HEIGHT")) {
    const raw = process.env.CRP_STREAM_LAST_HEIGHT;
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      const parsed = Number.parseInt(String(raw), 10);
      startHeightOverride = Number.isFinite(parsed) ? parsed : 0;
    }
  }

  const sourceKindRaw = process.env.CRP_STREAM_SOURCE;
  const sourceKind: SourceKind = (sourceKindRaw === "fixture" ? "fixture" : "concordium");

  const zeroIsGenesis = parseBoolEnv("CRP_STREAM_ZERO_IS_GENESIS", false);
  const maxAheadGuard = parseIntEnv("CRP_STREAM_CURSOR_MAX_AHEAD", 1000);
  const rewindOnClamp = parseIntEnv("CRP_STREAM_CURSOR_REWIND", 5);
  const persistCursorInDryRun = parseBoolEnv("CRP_STREAM_PERSIST_CURSOR_IN_DRY_RUN", false);

  // Logging hygiene defaults
  const quietWhenNoProgress = parseBoolEnv("CRP_STREAM_QUIET_NO_PROGRESS", true);
  const heartbeatEveryTicks = parseIntEnv("CRP_STREAM_HEARTBEAT_TICKS", 10);

  return {
    pollIntervalMs,
    dryRun,
    startHeightOverride,
    maxTicks,
    sourceKind,
    zeroIsGenesis,
    maxAheadGuard,
    rewindOnClamp,
    persistCursorInDryRun,
    quietWhenNoProgress,
    heartbeatEveryTicks,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDatabaseUrlOrThrow(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error("DATABASE_URL is required for cursor persistence.");
  }
  return url;
}

const pool = new Pool({
  connectionString: getDatabaseUrlOrThrow(),
});

async function ensureCursorTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.crp_stream_cursors (
      cursor_key  text PRIMARY KEY,
      last_height bigint NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function readCursor(cursorKey: string): Promise<number | null> {
  const res = await pool.query(
    `SELECT last_height FROM public.crp_stream_cursors WHERE cursor_key = $1 LIMIT 1`,
    [cursorKey]
  );
  if (!res.rows || res.rows.length === 0) return null;

  const raw = res.rows[0]?.last_height;
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function upsertCursor(cursorKey: string, lastHeight: number): Promise<void> {
  await pool.query(
    `
    INSERT INTO public.crp_stream_cursors (cursor_key, last_height, updated_at)
    VALUES ($1, $2, now())
    ON CONFLICT (cursor_key) DO UPDATE
      SET last_height = GREATEST(public.crp_stream_cursors.last_height, EXCLUDED.last_height),
          updated_at  = now()
    `,
    [cursorKey, String(lastHeight)]
  );
}

function buildCursorKeyForConcordium(cfg: ReturnType<typeof createConcordiumNodeConfigFromEnv>): string {
  return `plt:concordium:${cfg.network}:${cfg.networkGenesisIndex}:${cfg.assetId}:${cfg.accountAddress}`;
}

async function resolveStartCursor(
  workerCfg: WorkerConfig,
  sourceKind: SourceKind,
  cursorKey: string,
  accountForLatestId?: string
): Promise<number> {
  await ensureCursorTable();

  const dbCursor = await readCursor(cursorKey);

  let start = 0;
  let startSource = "implicit(0)";

  if (typeof workerCfg.startHeightOverride === "number" && Number.isFinite(workerCfg.startHeightOverride)) {
    start = workerCfg.startHeightOverride;
    startSource = "env(CRP_STREAM_LAST_HEIGHT)+gate(CRP_STREAM_USE_LAST_HEIGHT_OVERRIDE)";
  } else if (typeof dbCursor === "number" && Number.isFinite(dbCursor)) {
    start = dbCursor;
    startSource = "db(crp_stream_cursors)";
  }

  if (sourceKind === "concordium" && accountForLatestId) {
    const latestId = await getLatestAccountTransactionId(accountForLatestId);

    if (latestId > 0) {
      if (start > latestId + workerCfg.maxAheadGuard) {
        const clamped = Math.max(0, latestId - workerCfg.rewindOnClamp);
        console.log(
          "[CRP-STREAM] WARNING: cursor looks out-of-universe; clamping. cursor=%d latest=%d guard=%d => start=%d (source=%s)",
          start,
          latestId,
          workerCfg.maxAheadGuard,
          clamped,
          startSource
        );
        start = clamped;
        startSource = "clamped(latest-rewind)";
        await upsertCursor(cursorKey, start);
      }

      if (start === 0 && !workerCfg.zeroIsGenesis) {
        console.log(
          "[CRP-STREAM] start cursor=0 treated as 'from now' (latestId=%d). Setting cursor to latestId.",
          latestId
        );
        start = latestId;
        startSource = "from_now(latestId)";
        await upsertCursor(cursorKey, start);
      }
    }
  }

  console.log("[CRP-STREAM] resolved start cursor:", { cursorKey, start, source: startSource });
  return start;
}

async function runWorker(
  source: PltSource,
  cfg: WorkerConfig,
  cursorKey: string,
  state: { lastHeightExclusive: number }
): Promise<void> {
  console.log("[CRP-STREAM] starting worker with config:", {
    pollIntervalMs: cfg.pollIntervalMs,
    dryRun: cfg.dryRun,
    lastHeight: state.lastHeightExclusive,
    maxTicks: cfg.maxTicks,
    sourceKind: cfg.sourceKind,
    cursorKey,
    quietWhenNoProgress: cfg.quietWhenNoProgress,
    heartbeatEveryTicks: cfg.heartbeatEveryTicks,
  });

  let tick = 0;
  let stopRequested = false;

  const requestStop = (sig: string) => {
    stopRequested = true;
    console.log("[CRP-STREAM] %s received; will stop after this tick.", sig);
  };

  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  while (true) {
    if (stopRequested) {
      console.log("[CRP-STREAM] stopping loop (stop requested).");
      break;
    }

    tick += 1;
    if (cfg.maxTicks > 0 && tick > cfg.maxTicks) {
      console.log("[CRP-STREAM] maxTicks (%d) reached, stopping loop.", cfg.maxTicks);
      break;
    }

    const prevCursor = state.lastHeightExclusive;

    // Fetch (source may internally apply overlap/backfill; that's fine)
    const { events, bestHeight } = await source.fetchSince(prevCursor);

    // Cursor advance decision: ONLY treat as progress if bestHeight > prevCursor
    const advanced = Number.isFinite(bestHeight) && bestHeight > prevCursor;

    // If no progress, don't spam logs every tick.
    if (!advanced && cfg.quietWhenNoProgress) {
      if (cfg.heartbeatEveryTicks > 0 && tick % cfg.heartbeatEveryTicks === 0) {
        console.log("[CRP-STREAM] heartbeat: no new PLT txs. cursor=%d (events_seen_in_overlap=%d)", prevCursor, events.length);
      }
    } else {
      console.log(
        "[CRP-STREAM] fetched %d PLT event(s) (cursor=%d best=%d advanced=%s)",
        events.length,
        prevCursor,
        bestHeight,
        advanced ? "yes" : "no"
      );
    }

    // Insert (only log details if we are making progress or there are actual events)
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

        occurred_at: new Date(ev.occurredAt as any).toISOString(),
      }));

      if (!cfg.dryRun) {
        const { inserted } = await insertPltTransfers(rows);

        // Only print the detailed “inserted/last” line when:
        // - we actually inserted something OR
        // - we advanced the cursor (i.e., something new happened)
        if (inserted > 0 || advanced || !cfg.quietWhenNoProgress) {
          const last = rows[rows.length - 1];
          console.log("[CRP-STREAM] insert result:", {
            inserted,
            last: {
              block_height: last.block_height,
              transaction_hash: last.transaction_hash,
              asset_id: last.asset_id,
              amount_raw: last.amount_raw,
            },
          });
        }
      } else if (!cfg.quietWhenNoProgress) {
        console.log("[CRP-STREAM] dryRun=true, would insert rows:", rows.length);
      }
    }

    // Advance cursor only if bestHeight indicates progress.
    if (advanced) {
      state.lastHeightExclusive = bestHeight;

      // Persist cursor (monotonic)
      if (!cfg.dryRun || cfg.persistCursorInDryRun) {
        await upsertCursor(cursorKey, bestHeight);
      }
    }

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
    startHeightOverride: cfg.startHeightOverride,
    maxTicks: cfg.maxTicks,
    sourceKind: cfg.sourceKind,
    quietWhenNoProgress: cfg.quietWhenNoProgress,
    heartbeatEveryTicks: cfg.heartbeatEveryTicks,
  });

  let source: PltSource;
  let cursorKey = "plt:unknown";
  let startCursor = 0;

  if (cfg.sourceKind === "fixture") {
    source = createFixtureSourceFromEnv();
    cursorKey = "plt:fixture";
    startCursor = await resolveStartCursor(cfg, "fixture", cursorKey);
  } else {
    const nodeCfg = createConcordiumNodeConfigFromEnv();
    source = new ConcordiumPltSource(nodeCfg);

    cursorKey = buildCursorKeyForConcordium(nodeCfg);
    startCursor = await resolveStartCursor(cfg, "concordium", cursorKey, nodeCfg.accountAddress);
  }

  const state = { lastHeightExclusive: startCursor };
  await runWorker(source, cfg, cursorKey, state);
}

if (require.main === module) {
  runDemo()
    .catch((err) => {
      console.error("[CRP-STREAM] demo runner failed:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await pool.end();
      } catch {
        // ignore
      }
    });
}
