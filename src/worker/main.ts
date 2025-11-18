import { FakePltEventSource, PltEventSource } from "./pltSource";

/**
 * Core configuration for the CRP stream worker.
 *
 * For now, we support a simple demo mode:
 * - Fake PLT events
 * - Dry-run only (log "would process" instead of writing to DB)
 */
export interface CrpStreamWorkerConfig {
  pollIntervalMs: number;
  network: string;
  tokenId: string;
  dryRun: boolean;

  /**
   * Last finalized PLT event height we've processed.
   * This will later come from / persist to the database or a checkpoint table.
   */
  lastHeight: number;

  /**
   * Optional guard so demos don't run forever.
   * If set, the worker will stop after this many polling iterations.
   */
  maxTicks?: number;
}

/**
 * Small helper to sleep between polling iterations.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * For now, we parse a "demo config" from environment variables with
 * safe defaults, matching what we've used in earlier steps.
 */
function parseDemoConfigFromEnv(): CrpStreamWorkerConfig {
  const pollIntervalMs = Number(process.env.CRP_STREAM_POLL_INTERVAL_MS ?? "2000");
  const network = process.env.CRP_STREAM_NETWORK ?? "concordium:testnet";
  const tokenId = process.env.CRP_STREAM_TOKEN_ID ?? "usd:test";

  // Default to dry-run=true unless explicitly set to "false"
  const dryRunEnv = process.env.CRP_STREAM_DRY_RUN ?? "true";
  const dryRun = dryRunEnv.toLowerCase() !== "false";

  // For demos, limit to 3 ticks unless overridden
  const maxTicksEnv = process.env.CRP_STREAM_MAX_TICKS ?? "3";
  const maxTicks = Number(maxTicksEnv);

  return {
    pollIntervalMs,
    network,
    tokenId,
    dryRun,
    lastHeight: 0,
    maxTicks,
  };
}

/**
 * One polling iteration:
 * - fetch events above lastHeight from the PLT event source
 * - process them (for now, just log)
 * - return the new lastHeight
 */
async function runWorkerTick(
  source: PltEventSource,
  cfg: CrpStreamWorkerConfig
): Promise<number> {
  const { lastHeight } = cfg;

  const events = await source.fetchEventsAboveHeight(lastHeight);

  if (events.length === 0) {
    // Nothing new; no change in lastHeight.
    return lastHeight;
  }

  console.log(
    `[CRP-STREAM] fetched ${events.length} fake event(s) above height ${lastHeight}`
  );

  let newLastHeight = lastHeight;

  for (const ev of events) {
    if (cfg.dryRun) {
      console.log(
        "[CRP-STREAM] (dry-run) would process event:",
        { height: ev.height, txHash: ev.txHash }
      );
    } else {
      // Later: real processing -> DB updates, PLT decoding, etc.
      console.log(
        "[CRP-STREAM] processing event (TODO implement real handler):",
        { height: ev.height, txHash: ev.txHash }
      );
    }

    if (ev.height > newLastHeight) {
      newLastHeight = ev.height;
    }
  }

  return newLastHeight;
}

/**
 * Main worker loop: repeatedly call runWorkerTick with a sleep in between.
 */
export async function runCrpStreamWorker(
  cfg: CrpStreamWorkerConfig,
  source: PltEventSource
): Promise<void> {
  console.log("[CRP-STREAM] starting worker with config:", cfg);

  let lastHeight = cfg.lastHeight;
  let ticks = 0;

  while (true) {
    ticks += 1;

    lastHeight = await runWorkerTick(source, { ...cfg, lastHeight });

    // For demos, stop after maxTicks if provided
    if (cfg.maxTicks && ticks >= cfg.maxTicks) {
      console.log(
        `[CRP-STREAM] maxTicks (${cfg.maxTicks}) reached, stopping loop.`
      );
      break;
    }

    await sleep(cfg.pollIntervalMs);
  }

  console.log("[CRP-STREAM] worker stopped.");
}

/**
 * Entry point for the demo script (npm run crp:worker:demo).
 *
 * For now, we always construct a FakePltEventSource, but the structure
 * is set up so we can later:
 * - Switch to a RealPltEventSource (Concordium gRPC) based on env flags
 * - Inject mocks for tests
 */
async function main(): Promise<void> {
  const cfg = parseDemoConfigFromEnv();

  console.log("[CRP-STREAM] demo runner starting with config:", {
    pollIntervalMs: cfg.pollIntervalMs,
    network: cfg.network,
    tokenId: cfg.tokenId,
    dryRun: cfg.dryRun,
    maxTicks: cfg.maxTicks,
  });

  const source = new FakePltEventSource({
    network: cfg.network,
    tokenId: cfg.tokenId,
  });

  await runCrpStreamWorker(cfg, source);

  console.log("[CRP-STREAM] demo runner finished.");
}

// Allow ts-node direct execution
if (require.main === module) {
  // eslint-disable-next-line no-console
  main().catch((err) => {
    console.error("[CRP-STREAM] fatal error in demo runner:", err);
    process.exitCode = 1;
  });
}
