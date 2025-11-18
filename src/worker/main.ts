import 'dotenv/config';

type WorkerConfig = {
  pollIntervalMs: number;
  network: string;
  tokenId: string;
  dryRun: boolean;
  lastHeight: number;
  maxTicks?: number;
};

type DemoRunnerConfig = {
  pollIntervalMs: number;
  network: string;
  tokenId: string;
  dryRun: boolean;
  maxTicks: number;
};

type FakeEvent = {
  height: number;
  txHash: string;
};

function log(...args: unknown[]) {
  // Prefix logs so they are easy to grep in mixed logs
  console.log('[CRP-STREAM]', ...args);
}

/**
 * Read demo runner config from environment variables with safe defaults.
 *
 * Env vars:
 *  - CRP_STREAM_POLL_INTERVAL_MS (default: 2000)
 *  - CRP_STREAM_NETWORK           (default: "concordium:testnet")
 *  - CRP_STREAM_TOKEN_ID          (default: "usd:test")
 *  - CRP_STREAM_DRY_RUN           ("true" or "false", default: "true")
 *  - CRP_STREAM_MAX_TICKS         (default: 3)
 */
function getDemoRunnerConfigFromEnv(): DemoRunnerConfig {
  const pollIntervalMs =
    parseInt(process.env.CRP_STREAM_POLL_INTERVAL_MS ?? '', 10) || 2000;

  const network =
    process.env.CRP_STREAM_NETWORK || 'concordium:testnet';

  const tokenId =
    process.env.CRP_STREAM_TOKEN_ID || 'usd:test';

  const dryRun =
    (process.env.CRP_STREAM_DRY_RUN ?? 'true').toLowerCase() === 'true';

  const maxTicks =
    parseInt(process.env.CRP_STREAM_MAX_TICKS ?? '', 10) || 3;

  return {
    pollIntervalMs,
    network,
    tokenId,
    dryRun,
    maxTicks,
  };
}

/**
 * In a future step this will be backed by real Concordium PLT events.
 * For now it just simulates one new event per poll.
 */
async function fetchFakeEventsSince(
  lastHeight: number,
  _network: string,
  _tokenId: string
): Promise<FakeEvent[]> {
  // Simulate "one new event per poll"
  const nextHeight = lastHeight + 1;
  return [
    {
      height: nextHeight,
      txHash: `fake-tx-${nextHeight.toString().padStart(4, '0')}`,
    },
  ];
}

/**
 * In a future step, this function will:
 *  - Decode PLT events
 *  - Resolve decimals/registry
 *  - Upsert CRP records in the DB
 *
 * For now, we just log the events (or "would process" in dry-run mode).
 */
async function processFakeEvent(event: FakeEvent, dryRun: boolean): Promise<void> {
  if (dryRun) {
    log('(dry-run) would process event:', event);
  } else {
    log('processing event:', event);
    // TODO: real CRP integration will go here.
  }
}

/**
 * Core worker loop.
 *
 * This stays deliberately simple and side-effect-lite while we iterate
 * toward real Concordium integration.
 */
async function runWorker(config: WorkerConfig): Promise<void> {
  log('starting worker with config:', config);

  let currentHeight = config.lastHeight;
  let tick = 0;
  const maxTicks = config.maxTicks ?? Infinity;

  while (tick < maxTicks) {
    tick += 1;

    const events = await fetchFakeEventsSince(
      currentHeight,
      config.network,
      config.tokenId
    );

    if (events.length > 0) {
      log(
        `fetched ${events.length} fake event(s) above height ${currentHeight}`
      );
      for (const ev of events) {
        await processFakeEvent(ev, config.dryRun);
        currentHeight = ev.height;
      }
    } else {
      log(`no events above height ${currentHeight}`);
    }

    if (tick >= maxTicks) {
      log(`maxTicks (${maxTicks}) reached, stopping loop.`);
      break;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, config.pollIntervalMs)
    );
  }

  log('worker stopped.');
}

/**
 * Entry point for the demo runner.
 *
 * For now this just:
 *  - reads env + CLI flags
 *  - builds a WorkerConfig
 *  - runs the worker loop once
 */
async function main(): Promise<void> {
  const runnerConfig = getDemoRunnerConfigFromEnv();

  // Simple CLI override: --no-dry-run
  // Example:
  //   npm run crp:worker:demo -- --no-dry-run
  const args = process.argv.slice(2);
  if (args.includes('--no-dry-run')) {
    runnerConfig.dryRun = false;
  }

  log('demo runner starting with config:', runnerConfig);

  const workerConfig: WorkerConfig = {
    pollIntervalMs: runnerConfig.pollIntervalMs,
    network: runnerConfig.network,
    tokenId: runnerConfig.tokenId,
    dryRun: runnerConfig.dryRun,
    lastHeight: 0,
    maxTicks: runnerConfig.maxTicks,
  };

  await runWorker(workerConfig);

  log('demo runner finished.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[CRP-STREAM] demo runner failed:', err);
    process.exit(1);
  });
}
