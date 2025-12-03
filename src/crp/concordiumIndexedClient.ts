// src/crp/concordiumIndexedClient.ts
//
// Skeleton for an index-backed ConcordiumNodeClient that reads from
// the facilitator's Postgres tables (finalized blocks, PLT events, etc.).
//
// IMPORTANT: This is *not* wired into runtime yet. It's a scaffold that
// makes it easy to:
//   - stay compatible with Boosty's ConcordiumNodeClient semantics;
//   - later plug x402 verification on top of the indexed view instead of
//     talking directly to the node.

import type { Pool } from "pg";
import type {
  ConcordiumNodeClient,
  ConcordiumTransactionInfo,
} from "./concordiumTypes";

export interface IndexedConcordiumClientConfig {
  /** Logical network identifier, e.g. "concordium:testnet". */
  network: string;
}

/**
 * Postgres-backed implementation of ConcordiumNodeClient.
 *
 * NOTE: At this stage, methods are intentionally left as TODO stubs that
 * throw if invoked. Once the PLT indexer is fully verified, we will:
 *
 *   - SELECT from finalized block + PLT / token tables;
 *   - aggregate the rows into ConcordiumTransactionInfo;
 *   - optionally fold in CCD legs (if we index those later);
 *   - implement waitForFinalization via polling.
 */
export class IndexedConcordiumNodeClient implements ConcordiumNodeClient {
  private readonly network: string;

  constructor(
    private readonly db: Pool,
    cfg: IndexedConcordiumClientConfig
  ) {
    this.network = cfg.network;
  }

  /**
   * TODO: Implement using facilitator DB schema.
   *
   * Conceptual logic (for future implementation):
   *   1. Look up the finalized block that contains this tx hash.
   *   2. Gather PLT / CIS-2 rows from e.g. crp_plt_events (and future tables)
   *      where:
   *         - network = this.network
   *         - tx_hash = given txHash
   *   3. Aggregate those rows into tokenTransfers[].
   *   4. Derive status:
   *         - "finalized" if block is finalized and no explicit failure;
   *         - "failed"    if an error flag is present in the index;
   *         - "pending"   / "committed" if we add such states later.
   */
  async getTransactionStatus(
    txHash: string
  ): Promise<ConcordiumTransactionInfo | null> {
    // For now, we fail loudly if someone wires this in too early.
    throw new Error(
      "[IndexedConcordiumNodeClient] getTransactionStatus() not implemented yet"
    );
  }

  /**
   * TODO: Implement using a simple polling loop against getTransactionStatus().
   *
   * Conceptual logic:
   *   - Poll every N ms until:
   *       status is "finalized" or "failed", or
   *       timeoutMs is exceeded.
   */
  async waitForFinalization(
    txHash: string,
    timeoutMs = 60_000
  ): Promise<ConcordiumTransactionInfo | null> {
    // For now, we fail loudly if someone wires this in too early.
    throw new Error(
      "[IndexedConcordiumNodeClient] waitForFinalization() not implemented yet"
    );
  }
}
