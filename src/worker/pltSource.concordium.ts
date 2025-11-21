// src/worker/pltSource.concordium.ts
//
// Skeleton for a real Concordium-backed PLT event source.
// This is wired behind CRP_STREAM_SOURCE=concordium, but the actual
// on-chain integration still needs to be implemented.
//
// The intent is that this file will eventually wrap a client built
// on top of `@concordium/web-sdk/nodejs` (gRPC v2 / JSON-RPC),
// and expose a simple `fetchPltEventsSince` method.
//
// For now, the default client returns an empty array and logs a
// clear TODO so we don't accidentally think we're on real chain data.

import type { PltEvent, PltEventSource } from "./pltSource";

/**
 * Minimal config for the Concordium PLT source.
 */
export interface ConcordiumPltEventSourceConfig {
  /** Logical network identifier, e.g. "concordium:testnet". */
  network: string;
  /** Logical PLT token identifier, e.g. "usd:test". */
  tokenId: string;
  /** Number of decimals for this PLT (used for logging / sanity). */
  decimals: number;
}

/**
 * Client interface that the PLT source depends on.
 *
 * In the real implementation, this will be backed by a Concordium
 * JS SDK client created from `@concordium/web-sdk/nodejs`.
 */
export interface ConcordiumPltEventClient {
  /**
   * Fetch PLT transfer events strictly above the given height.
   *
   * The returned heights must be monotonically increasing.
   */
  fetchPltEventsSince(
    lastHeight: number,
    cfg: ConcordiumPltEventSourceConfig
  ): Promise<PltEvent[]>;
}

/**
 * Default stub implementation of the Concordium PLT client.
 *
 * This is where we will later:
 *   - Construct a Concordium gRPC / JSON-RPC client using
 *     `@concordium/web-sdk/nodejs`.
 *   - Filter PLT transfer events for (network, tokenId).
 *   - Map them into the shared PltEvent shape.
 *
 * Pseudocode for the real client (commented out on purpose):
 *
 *   import { JsonRpcClient, HttpProvider } from "@concordium/web-sdk/nodejs";
 *
 *   const provider = new HttpProvider(process.env.CONCORDIUM_NODE_URL!);
 *   const client = new JsonRpcClient(provider);
 *
 *   // Then use client.getBlockInfo / getBlockSummary / getInstanceInfo
 *   // and PLT-specific helpers to decode transfers.
 */
class DefaultConcordiumPltEventClient implements ConcordiumPltEventClient {
  constructor(private readonly nodeUrl: string) {}

  async fetchPltEventsSince(
    lastHeight: number,
    cfg: ConcordiumPltEventSourceConfig
  ): Promise<PltEvent[]> {
    // eslint-disable-next-line no-console
    console.warn(
      "[CRP-STREAM][concordium] DefaultConcordiumPltEventClient is a stub. " +
        "No real chain data is being read yet.",
      {
        nodeUrl: this.nodeUrl,
        network: cfg.network,
        tokenId: cfg.tokenId,
        lastHeight,
      }
    );

    // TODO (M3+): Implement real PLT scanning using @concordium/web-sdk/nodejs
    // and return a list of PltEvent objects mapped from on-chain transfers.
    return [];
  }
}

/**
 * Concordium-backed implementation of PltEventSource.
 *
 * It delegates to a ConcordiumPltEventClient to do the actual chain I/O,
 * and only enforces the PltEventSource contract (monotone heights, etc.).
 */
export class ConcordiumPltEventSource implements PltEventSource {
  constructor(
    private readonly cfg: ConcordiumPltEventSourceConfig,
    private readonly client: ConcordiumPltEventClient
  ) {}

  async fetchSince(lastHeight: number): Promise<PltEvent[]> {
    const events = await this.client.fetchPltEventsSince(lastHeight, this.cfg);

    // Basic sanity: sort by height ascending and drop any <= lastHeight.
    const filtered = events
      .filter((ev) => ev.height > lastHeight)
      .sort((a, b) => a.height - b.height);

    return filtered;
  }
}

/**
 * Helper to construct a default ConcordiumPltEventClient from environment.
 *
 * Env vars (proposal):
 *   - CONCORDIUM_NODE_URL   -> e.g. "http://localhost:9095"
 *
 * We keep this intentionally minimal; additional tuning (timeouts,
 * retries, etc.) can be added later without changing call sites.
 */
export function createConcordiumPltEventClientFromEnv(): ConcordiumPltEventClient {
  const nodeUrl =
    process.env.CONCORDIUM_NODE_URL ?? "http://localhost:9095";

  return new DefaultConcordiumPltEventClient(nodeUrl);
}
