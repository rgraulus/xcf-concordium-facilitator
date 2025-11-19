// src/worker/main.ts

import { getPltDecimals, PltAssetKey } from './pltDecimals';
import {
  PltEvent,
  PltEventSource,
  makeDemoPltEventSource,
} from './pltSource';

export interface WorkerConfig {
  /** How often to poll for new events (ms). */
  pollIntervalMs: number;

  /** Network identifier, e.g. "concordium:testnet". */
  network: string;

  /** PLT token identifier, e.g. "usd:test". */
  tokenId: string;

  /** If true, do not persist or emit anything; just log. */
  dryRun: boolean;

  /** Last processed height (inclusive). */
  lastHeight: number;

  /** Optional safety cap on the number of polling ticks. */
  maxTicks?: number;
}

/**
 * Core worker loop: polls a PLT event source and processes events.
 *
 * For now this is wired to the demo source only; later we can swap in
 * a real Concordium PLT event source while keeping the loop unchanged.
 */
export async function runWorker(config: WorkerConfig): Promise<void> {
  const {
    pollIntervalMs,
    network,
    tokenId,
    dryRun,
    maxTicks,
  } = config;

  let { lastHeight } = config;

  // Build the asset key expected by the decimals registry.
  const assetKey: PltAssetKey = { network, tokenId };
  const decimals = getPltDecimals(assetKey) ?? 0;

  // For now we always use the demo source. Later we can switch on an
  // environment variable or config flag to choose a real gRPC source.
  const source: PltEventSource = makeDemoPltEventSource({ network, tokenId });

  // eslint-disable-next-line no-console
  console.log(
    '[CRP-STREAM] starting worker with config:',
    JSON.stringify(
      {
        pollIntervalMs,
        network,
        tokenId,
        dryRun,
        lastHeight,
        maxTicks,
      },
      null,
      2
    )
  );

  let ticks = 0;
  let running = true;

  while (running) {
    ticks += 1;

    const events: PltEvent[] = await source.fetchSince(lastHeight);

    // eslint-disable-next-line no-console
    console.log(
      `[CRP-STREAM] fetched ${events.length} PLT event(s) above height ${lastHeight}`
    );

    for (const ev of events) {
      // Update lastHeight to the highest height we've seen so far.
      if (ev.height > lastHeight) {
        lastHeight = ev.height;
      }

      // This is where real processing would happen:
      // - decode PLT event payload
      // - match against CRP payments
      // - persist offsets, etc.
      //
      // For now we just log a dry-run line that demonstrates usage of
      // the decimals registry and basic event metadata.
      const fmt =
        `height=${ev.height}, txHash=${ev.txHash}, ` +
        `tokenId=${tokenId}, decimals=${decimals}`;

      // eslint-disable-next-line no-console
      console.log(
        dryRun
          ? `[CRP-STREAM] (dry-run) would process PLT event: ${fmt}`
          : `[CRP-STREAM] processing PLT event: ${fmt}`
      );
    }

    if (typeof maxTicks === 'number' && ticks >= maxTicks) {
      // eslint-disable-next-line no-console
      console.log(
        `[CRP-STREAM] maxTicks (${maxTicks}) reached, stopping loop.`
      );
      running = false;
      break;
    }

    if (!running) {
      break;
    }

    if (pollIntervalMs > 0 && running) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  // eslint-disable-next-line no-console
  console.log('[CRP-STREAM] worker stopped.');
}

/**
 * Demo runner that constructs a WorkerConfig with sensible defaults
 * and runs the worker once (used by npm run crp:worker:demo).
 */
export async function runDemo(): Promise<void> {
  const demoConfig: WorkerConfig = {
    pollIntervalMs: 2000,
    network: 'concordium:testnet',
    tokenId: 'usd:test',
    dryRun: true,
    lastHeight: 0,
    maxTicks: 3,
  };

  // eslint-disable-next-line no-console
  console.log(
    '[CRP-STREAM] demo runner starting with config:',
    JSON.stringify(demoConfig, null, 2)
  );

  try {
    await runWorker(demoConfig);
    // eslint-disable-next-line no-console
    console.log('[CRP-STREAM] demo runner finished.');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[CRP-STREAM] demo runner failed:', err);
  }
}

// Allow `ts-node src/worker/main.ts` to run the demo directly.
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  runDemo();
}
