import { setTimeout as delay } from "timers/promises";

export interface CrpStreamWorkerConfig {
  /**
   * How often to poll for new events, in milliseconds.
   * (Demo default: 5000ms)
   */
  pollIntervalMs: number;

  /**
   * Concordium network identifier, e.g. "concordium:testnet".
   * Used here just for logging in the skeleton.
   */
  network: string;

  /**
   * PLT token identifier, e.g. "usd:test".
   * Used here just for logging in the skeleton.
   */
  tokenId: string;

  /**
   * When true, the worker will only log what it *would* do
   * without writing to any database or calling external services.
   */
  dryRun: boolean;
}

/**
 * Minimal placeholder for a PLT / payment event.
 * In later phases this will be hydrated from real Concordium events.
 */
export interface CrpStreamFakeEvent {
  height: number;
  txHash: string;
}

/**
 * CRP stream worker skeleton:
 * - Keeps track of the last processed "height"
 * - On each tick, fetches fake events above that height
 * - Logs how it would process them (dry-run friendly)
 *
 * No Concordium SDK, no database writes yet.
 */
export class CrpStreamWorker {
  private stopped = false;
  private lastHeight: number;

  constructor(
    private readonly config: CrpStreamWorkerConfig,
    startHeight: number = 0
  ) {
    this.lastHeight = startHeight;
  }

  /**
   * Start the polling loop.
   *
   * For safety in this initial skeleton, you can pass maxTicks to
   * limit how many iterations we run before stopping.
   */
  async start(maxTicks?: number): Promise<void> {
    let ticks = 0;

    console.log("[CRP-STREAM] starting worker with config:", {
      ...this.config,
      lastHeight: this.lastHeight,
    });

    while (!this.stopped) {
      ticks += 1;

      try {
        const events = await this.fetchNewEvents(this.lastHeight);

        if (events.length > 0) {
          console.log(
            `[CRP-STREAM] fetched ${events.length} fake event(s) above height ${this.lastHeight}`
          );

          for (const ev of events) {
            await this.handleEvent(ev);
          }

          // Advance the cursor to the highest height we saw
          this.lastHeight = events[events.length - 1].height;
        } else {
          console.log(
            `[CRP-STREAM] no new events after height ${this.lastHeight}`
          );
        }
      } catch (err) {
        console.error("[CRP-STREAM] error in poll loop:", err);
      }

      if (maxTicks && ticks >= maxTicks) {
        console.log(
          `[CRP-STREAM] maxTicks (${maxTicks}) reached, stopping loop.`
        );
        break;
      }

      // Small delay before the next poll
      await delay(this.config.pollIntervalMs);
    }

    console.log("[CRP-STREAM] worker stopped.");
  }

  /**
   * Signal the loop to stop after the current iteration.
   * (We’ll hook this up to process signals later if useful.)
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Placeholder "event source".
   *
   * For now this just synthesizes at most one fake event
   * at heights 1, 2, 3 and then becomes idle.
   */
  private async fetchNewEvents(
    fromHeight: number
  ): Promise<CrpStreamFakeEvent[]> {
    // In a later phase, this will:
    // - Use the Concordium SDK / gRPC client
    // - Read PLT transfer / mint / burn events
    // - Filter by the configured token / address
    // - Return a batch of chain events to upsert into CRP
    if (fromHeight >= 3) {
      return [];
    }

    const nextHeight = fromHeight + 1;

    return [
      {
        height: nextHeight,
        txHash: `fake-tx-${String(nextHeight).padStart(4, "0")}`,
      },
    ];
  }

  /**
   * Placeholder "event handler".
   *
   * In a later phase this will:
   * - Map PLT events to CRP payments rows
   * - Upsert into the CRP DB
   * - Optionally trigger webhooks / downstream processing
   */
  private async handleEvent(ev: CrpStreamFakeEvent): Promise<void> {
    if (this.config.dryRun) {
      console.log("[CRP-STREAM] (dry-run) would process event:", ev);
    } else {
      console.log("[CRP-STREAM] processing event:", ev);
    }
  }
}
