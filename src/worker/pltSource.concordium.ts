// src/worker/pltSource.concordium.ts
//
// NOTE: This is a **stubbed** Concordium PLT event source used by the M3 worker.
// It is intentionally minimal and does NOT yet talk to a real Concordium node.
// Instead, it returns zero events while keeping the logging shape and types
// stable so the rest of the system (worker + DB + HTTP routes) can compile,
// run, and pass CI.
//
// Later, we can replace the internals of `ConcordiumPltSource.fetchSince`
// with a real @concordium/web-sdk-based implementation without changing the
// worker or DB layer.

export interface ConcordiumNodeConfig {
  /** Raw node URL, e.g. "grpc.testnet.concordium.com:20000". */
  nodeUrl: string;
  /** Logical network name, e.g. "concordium:testnet". */
  network: string;
  /** Logical tokenId filter, e.g. "EUDemo". */
  logicalTokenId: string;
}

/**
 * Normalized PLT transfer event as seen by the worker.
 */
export interface ExtractedPltEvent {
  network: string;
  blockHash: string;
  blockHeight: number;
  txHash: string;
  tokenId: string;
  amountMinor: string;
  from: string | null;
  to: string;
  occurredAt: Date;
  eventIndex: number;
}

/**
 * Summary of a single scan step, mimicking the logging you’ve already seen
 * (`latest-block sample { ... }`, etc.).
 */
export interface ConcordiumPltScanSummary {
  network: string;
  tokenIdFilter: string;
  blockHash: string | null;
  blockHeight: number | null;
  totalSummaries: number;
  matchedEvents: number;
  sampleSummaries: unknown[];
  sampleEvents: Array<{
    network: string;
    blockHash: string;
    blockHeight: number;
    txHash: string;
    tokenId: string;
    amount: string;
    from: string | null;
    to: string;
  }>;
}

/**
 * Result of a scan step.
 */
export interface ConcordiumPltSourceResult {
  events: ExtractedPltEvent[];
  bestHeight: number;
  summary: ConcordiumPltScanSummary;
}

/**
 * Stub PLT event source. In this version it does NOT query a real node;
 * it just logs a "latest-block sample" with no events and returns an
 * empty set. This keeps the worker + DB happy and is CI-safe.
 */
export class ConcordiumPltSource {
  constructor(public readonly config: ConcordiumNodeConfig) {}

  /**
   * Fetch PLT events strictly above `lastHeightExclusive`.
   * For now, this is a stub that returns no events and reports the
   * same height back.
   */
  async fetchSince(lastHeightExclusive: number): Promise<ConcordiumPltSourceResult> {
    const bestHeight = lastHeightExclusive;

    const summary: ConcordiumPltScanSummary = {
      network: this.config.network,
      tokenIdFilter: this.config.logicalTokenId,
      blockHash: null,
      blockHeight: bestHeight,
      totalSummaries: 0,
      matchedEvents: 0,
      sampleSummaries: [],
      sampleEvents: [],
    };

    console.log("[CRP-STREAM][concordium] latest-block sample", {
      network: summary.network,
      tokenIdFilter: summary.tokenIdFilter,
      blockHash: summary.blockHash,
      blockHeight: summary.blockHeight,
      totalSummaries: summary.totalSummaries,
      matchedEvents: summary.matchedEvents,
      sampleSummaries: summary.sampleSummaries,
      sampleEvents: summary.sampleEvents,
    });

    return {
      events: [],
      bestHeight,
      summary,
    };
  }
}

/**
 * Helper to build a node config from environment variables.
 */
export function createConcordiumNodeConfigFromEnv(): ConcordiumNodeConfig {
  const nodeUrl = process.env.CONCORDIUM_NODE_URL;
  if (!nodeUrl || nodeUrl.trim() === "") {
    throw new Error(
      "CONCORDIUM_NODE_URL is required for concordium PLT source (e.g. grpc.testnet.concordium.com:20000)"
    );
  }

  const network = process.env.CRP_STREAM_NETWORK ?? "concordium:testnet";
  const logicalTokenId = process.env.CONCORDIUM_PLT_TOKEN_ID ?? process.env.CRP_STREAM_TOKEN_ID ?? "EUDemo";

  const config: ConcordiumNodeConfig = {
    nodeUrl,
    network,
    logicalTokenId,
  };

  console.log("[CRP-STREAM][concordium] Using node connection", {
    nodeUrl: config.nodeUrl,
    network: config.network,
    logicalTokenId: config.logicalTokenId,
  });

  return config;
}
