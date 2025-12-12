// src/plt/pltEvents.ts
//
// M3.4 – Internal PLT event model + extraction skeleton.
//
// This module is intentionally decoupled from Postgres and HTTP.
// It only knows about:
//   - The shape of a "raw" transaction summary row we care about
//   - The internal PltEvent model XCF will use
//   - A placeholder extractor function whose implementation we will
//     fill in once we have real EUDemo PLT events in `summaries`.
//
// IMPORTANT:
//   - For now, `extractPltEventsFromSummaryRow` returns an empty array.
//   - This keeps the code safe to import without changing behaviour.
//   - Once we have PLT-era data in `summaries`, we'll implement the
//     actual extraction logic against the true JSON shapes.
//
// References:
//   - CIS-7: Protocol-level Tokens (PLTs) – TokenTransfer, TokenMint,
//     TokenBurn, TokenCreated kernel events.
//   - Protocol Update 9 (PLT introduction).
//
// The intent is that higher-level code will:
//   1) Load rows from `summaries` (e.g. via src/tools/ingestPltFromSummaries.ts)
//   2) Call this extractor to map them into PltEvent[]
//   3) Persist those into crp_plt_events in an idempotent way.

export type PltEventKind =
  | "transfer"
  | "mint"
  | "burn"
  | "create"
  | "unknown";

export interface PltEvent {
  // Chain location
  blockHash: string;
  blockHeight: bigint;
  transactionHash: string;
  eventIndex: number; // index within the tx's event list

  // Semantics
  kind: PltEventKind;

  // CIS-7 Token ID (e.g. "EUDemo")
  tokenId: string;

  // Optional addresses (depending on event kind)
  fromAddress?: string;
  toAddress?: string;

  // Amount in atomic units (raw integer string, already scaled by decimals)
  // For TokenCreated this may be "0" or omitted depending on the event semantics.
  amountRaw: string;

  // Optional memo (if the event carries it and we decide to keep it)
  memo?: string;

  // XCF asset wiring
  assetId: string; // e.g. "concordium:testnet:PLT:EUDemo"
  networkGenesisIndex: number; // e.g. 6 for testnet

  // Finality marker (for now PLT events we ingest will usually be finalized)
  finalized: boolean;

  // Raw timestamp from the summary (ms since epoch, as string -> we can
  // normalise later if needed)
  timestampMs: string;
}

// Minimal shape of the `summaries` row we care about.
// This matches what debugTxSummary / ingestPltFromSummaries already use.
export interface RawTxSummaryRow {
  id: string;
  height: string;
  timestamp: string;
  summary: unknown;
}

/**
 * Internal options for PLT extraction.
 *
 * For M3.4 we will typically:
 *   - target a single PLT (EUDemo) on a single network (testnet)
 *   - rely on a pre-seeded crp_plt_assets row with a known assetId + decimals
 */
export interface PltExtractionOptions {
  assetId: string; // XCF asset id, e.g. "concordium:testnet:PLT:EUDemo"
  networkGenesisIndex: number; // e.g. 6 for testnet
  // Future: we might add `expectedTokenId: string` = "EUDemo"
}

/**
 * Skeleton extractor.
 *
 * For now this intentionally returns an empty list. Once we have at least one
 * real EUDemo PLT transaction in `summaries`, we will:
 *
 *   - Inspect it via src/tools/debugTxByHash.ts
 *   - Identify how PLT Token Kernel events are encoded in the JSON
 *   - Implement the decoding logic here, mapping them into PltEvent objects.
 *
 * This keeps M3.4 code changes safe and non-invasive until we have real data.
 */
export function extractPltEventsFromSummaryRow(
  row: RawTxSummaryRow,
  options: PltExtractionOptions
): PltEvent[] {
  // Placeholder implementation:
  //  - We do not attempt to interpret `row.summary` yet.
  //  - Once we know the exact JSON representation of TokenTransfer /
  //    TokenMint / TokenBurn / TokenCreated in transaction-outcome.summaries,
  //    we will:
  //      * locate the relevant event list(s) in the summary
  //      * filter for PLT events for the desired Token ID
  //      * normalise amounts into `amountRaw` strings
  //      * populate PltEvent objects accordingly.
  //
  // Keeping this as a no-op ensures we can safely import and unit-test it
  // without changing any runtime behaviour until M3.4 is ready to ingest.
  void row;
  void options;
  return [];
}
