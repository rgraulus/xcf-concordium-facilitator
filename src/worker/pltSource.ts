/**
 * PLT event streaming abstractions for the CRP worker.
 *
 * Step 1: we provide a FakePltEventSource that generates deterministic
 * in-memory events so we can exercise the worker loop without depending
 * on Concordium gRPC.
 *
 * Step 2 (later): we can add a RealPltEventSource that talks to the
 * Concordium node / PLT contracts and implement this same interface.
 */

export interface PltEvent {
  height: number;
  txHash: string;
  // Later we can add more fields: contract address, tokenId, amount, etc.
}

export interface PltEventSourceConfig {
  network: string;
  tokenId: string;
}

/**
 * Abstract interface for "something that can fetch PLT events
 * above a given finalized height".
 */
export interface PltEventSource {
  /**
   * Fetch events strictly above the given height.
   *
   * Implementations should:
   * - Only return finalized / safe events.
   * - Be idempotent: calling with the same height twice should
   *   return the same events.
   */
  fetchEventsAboveHeight(lastHeight: number): Promise<PltEvent[]>;
}

/**
 * Very small in-memory fake event source for development / testing.
 *
 * It will:
 * - Start at height 1
 * - Emit a single event per tick up to MAX_FAKE_HEIGHT
 * - Then return an empty array
 */
export class FakePltEventSource implements PltEventSource {
  private readonly maxFakeHeight = 3;

  constructor(private readonly cfg: PltEventSourceConfig) {}

  async fetchEventsAboveHeight(lastHeight: number): Promise<PltEvent[]> {
    const nextHeight = lastHeight + 1;

    if (nextHeight > this.maxFakeHeight) {
      return [];
    }

    const txHash = `fake-tx-${String(nextHeight).padStart(4, "0")}`;

    return [
      {
        height: nextHeight,
        txHash,
      },
    ];
  }
}
