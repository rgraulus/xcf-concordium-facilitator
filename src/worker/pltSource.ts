// src/worker/pltSource.ts

/**
 * Minimal PLT event shape used by the CRP stream worker.
 * In the real implementation this will be backed by Concordium gRPC
 * and contain the full decoded PLT event payload.
 */
export interface PltEvent {
  /** Monotonic block / event height on the rail. */
  height: number;

  /** Transaction hash or event identifier. */
  txHash: string;

  /** PLT token identifier for this event (e.g. "usd:test"). */
  tokenId: string;

  /** Amount in human-readable units (for demo purposes). */
  amount: string;

  /** Optional from/to fields to hint at transfer direction. */
  from?: string;
  to?: string;
}

/**
 * Abstract source of PLT events.
 *
 * The stream worker only depends on this interface; concrete
 * implementations can be:
 * - A demo / fake source (in-memory events).
 * - A real Concordium gRPC v2 PLT event stream.
 */
export interface PltEventSource {
  /**
   * Fetch all PLT events strictly above the given height.
   *
   * Implementations should:
   * - Return events ordered by ascending height.
   * - Never return events with height <= lastHeight.
   */
  fetchSince(lastHeight: number): Promise<PltEvent[]>;
}

/**
 * Configuration for the demo / fake PLT event source.
 */
export interface DemoPltSourceConfig {
  /** Network identifier, e.g. "concordium:testnet". */
  network: string;

  /** PLT token identifier, e.g. "usd:test". */
  tokenId: string;
}

/**
 * Simple in-memory demo implementation of PltEventSource.
 *
 * This is only used for local development and CI — it does NOT
 * talk to Concordium. It returns a fixed sequence of fake events
 * and logs what it is doing.
 */
export class FakePltEventSource implements PltEventSource {
  private readonly cfg: DemoPltSourceConfig;
  private readonly events: PltEvent[];

  constructor(cfg: DemoPltSourceConfig) {
    this.cfg = cfg;

    // For now we hard-code three fake events. The worker’s job is to
    // prove it can iterate, update lastHeight, and log with decimals.
    this.events = [
      {
        height: 1,
        txHash: 'fake-tx-0001',
        tokenId: cfg.tokenId,
        amount: '10.00',
        from: 'demo-from-1',
        to: 'demo-to-1',
      },
      {
        height: 2,
        txHash: 'fake-tx-0002',
        tokenId: cfg.tokenId,
        amount: '5.00',
        from: 'demo-from-2',
        to: 'demo-to-2',
      },
      {
        height: 3,
        txHash: 'fake-tx-0003',
        tokenId: cfg.tokenId,
        amount: '25.00',
        from: 'demo-from-3',
        to: 'demo-to-3',
      },
    ];
  }

  async fetchSince(lastHeight: number): Promise<PltEvent[]> {
    const result = this.events.filter((ev) => ev.height > lastHeight);

    // eslint-disable-next-line no-console
    console.log(
      `[CRP-STREAM][demo-source] fetchSince(lastHeight=${lastHeight}) -> ${result.length} event(s)`
    );

    return result;
  }
}

/**
 * Small factory helper kept for compatibility and readability.
 * The worker can either call this or construct FakePltEventSource
 * directly; both are equivalent.
 */
export function makeDemoPltEventSource(
  cfg: DemoPltSourceConfig
): PltEventSource {
  return new FakePltEventSource(cfg);
}
