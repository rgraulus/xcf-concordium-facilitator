// src/crp/concordiumTypes.ts
//
// Shared Concordium abstractions aligned with the x402 / Boosty Labs
// semantics, extended to cleanly support PLT and CIS-2 tokens.
//
// This layer is intentionally independent from how we *fetch* data
// (direct node gRPC vs. indexed Postgres), so both approaches can
// implement the same interface.

export type ConcordiumTxStatus =
  | "pending"
  | "committed"
  | "finalized"
  | "failed";

/**
 * Describes a single token transfer leg (PLT or CIS-2) observed
 * in a Concordium transaction.
 *
 * - For PLT:
 *     standard = "PLT"
 *     tokenId  = on-chain PLT symbol, e.g. "EUDemo" or "XCFUSD"
 *
 * - For CIS-2:
 *     standard = "CIS-2"
 *     tokenId  = "index:subindex:tokenId" (string form)
 */
export interface ConcordiumTokenTransfer {
  /** Token standard / family ("PLT" or "CIS-2"). */
  standard: "PLT" | "CIS-2";

  /**
   * Token identifier.
   * - PLT:   human-readable symbol, e.g. "EUDemo", "XCFUSD".
   * - CIS-2: "index:subindex:tokenId", e.g. "2059:0:wCCD".
   */
  tokenId: string;

  /** Sender account address (Base58 string). */
  from: string;

  /** Recipient account address (Base58 string). */
  to: string;

  /**
   * Amount in raw minor units, as a string.
   * For example with 6 decimals, "1000000" = 1.000000.
   */
  amount: string;

  /**
   * Optional decimals for convenience when interpreting amounts.
   * (Not required; callers can look this up via a registry if preferred.)
   */
  decimals?: number;

  /** Optional memo / data in hex (if applicable). */
  memoHex?: string;
}

/**
 * Canonical view of a Concordium transaction for x402 verification.
 *
 * The idea is:
 *   - Boosty Labs can construct this directly from node gRPC.
 *   - The XCF facilitator can construct this from its own indexer
 *     (finalized blocks + PLT / CIS-2 event tables).
 */
export interface ConcordiumTransactionInfo {
  /** Transaction hash (CCD Base16 string, lowercase). */
  txHash: string;

  /** Block hash that currently anchors this transaction, if known. */
  blockHash?: string;

  /** High-level status of the transaction. */
  status: ConcordiumTxStatus;

  /** Sender account address (Base58). */
  sender: string;

  // ---------------------------------------------------------------------------
  // CCD leg (if any)
  // ---------------------------------------------------------------------------

  /**
   * CCD amount in minor units as a string (optional).
   * For CCD with 6 decimals, "1000000" = 1.000000 CCD.
   */
  amountCCD?: string;

  /** CCD recipient account address (Base58), if applicable. */
  recipientCCD?: string;

  // ---------------------------------------------------------------------------
  // Token legs (PLT / CIS-2)
  // ---------------------------------------------------------------------------

  /**
   * Token transfer legs observed in this transaction.
   *
   * For x402, verification code will look for at least one entry
   * with:
   *   - matching standard ("PLT" or "CIS-2")
   *   - matching tokenId
   *   - matching recipient ("to")
   *   - matching amount
   */
  tokenTransfers?: ConcordiumTokenTransfer[];

  // ---------------------------------------------------------------------------
  // Diagnostics / raw payload
  // ---------------------------------------------------------------------------

  /**
   * Optional raw / opaque payload for debugging or logging.
   * This might be a node summary, DB row aggregate, etc.
   */
  raw?: unknown;

  /** Optional high-level error message if the transaction failed. */
  error?: string;
}

/**
 * Minimal interface for something that can answer questions
 * about Concordium transactions for x402.
 *
 * Implementations:
 *   - DirectNodeConcordiumClient (Boosty-style, direct gRPC).
 *   - IndexedConcordiumNodeClient (this repo, via Postgres).
 */
export interface ConcordiumNodeClient {
  /**
   * Fetch a snapshot of the current transaction status.
   *
   * Returns:
   *   - ConcordiumTransactionInfo, if the tx is known.
   *   - null, if the tx hash is unknown to the underlying source.
   */
  getTransactionStatus(
    txHash: string
  ): Promise<ConcordiumTransactionInfo | null>;

  /**
   * Wait until the tx is finalized or failed, or until timeoutMs is reached.
   *
   * Implementations are free to poll a node, poll a DB, or subscribe
   * to notifications underneath.
   */
  waitForFinalization(
    txHash: string,
    timeoutMs?: number
  ): Promise<ConcordiumTransactionInfo | null>;
}
