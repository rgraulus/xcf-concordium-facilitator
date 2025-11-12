// src/crp/plt.ts

// We intentionally do NOT import pino types here anymore,
// because Fastify's logger type and pino's Logger type don't match 1:1.
// We'll accept anything that quacks like a logger and call .info() on it.

export type PltSearchFilters = {
  /** Optional: filter by specific PLT token id, e.g. "usd:test" */
  tokenId?: string;
  /** Page size / cap for traversal. Route should default this (e.g., 25). */
  limit: number;
  /** Optional: inclusive start block height for scanning */
  fromHeight?: number;
  /** Optional: inclusive end block height for scanning */
  toHeight?: number;
};

type SearchOpts = {
  /** Fastify req.log, pino logger, etc. */
  log?: any;
};

/**
 * Placeholder implementation for Step 3. Keeps the API & response shape stable
 * while we wire real Concordium traversal behind it.
 *
 * - Always resolves quickly.
 * - Logs filters so we can verify shape and pacing in the server logs.
 * - Returns an empty "matches" array with basic stats.
 */
export async function searchPltPayments(
  filters: PltSearchFilters,
  opts: SearchOpts = {}
): Promise<{
  matches: Array<{
    // reserved for future fields (blockHash, txHash, event, amount, etc.)
    [k: string]: any;
  }>;
  stats: {
    scannedBlocks: number;
    scannedEvents: number;
    attempts?: number;
    backoffsMsTotal?: number;
  };
}> {
  const { log } = opts;
  if (log && typeof log.info === "function") {
    log.info({ filters }, "searchPltPayments() invoked");
  }

  return {
    matches: [],
    stats: {
      scannedBlocks: 0,
      scannedEvents: 0,
    },
  };
}
