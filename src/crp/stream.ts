// src/crp/stream.ts

/**
 * Finalized stream ingestion helpers.
 *
 * This module does NOT yet talk to Concordium directly. Instead, it provides
 * a small API to:
 *  - upsert a finalized block, and
 *  - store normalized PLT transfers for that block,
 * using the DB helpers in src/store/plt.pg.ts.
 *
 * Later, the actual Concordium stream worker will:
 *  - fetch finalized blocks via @concordium/web-sdk,
 *  - parse PLT transfers into ParsedPltTransfer[],
 *  - and call ingestFinalizedBlock(...) with that data.
 */

import { upsertFinalizedBlock, insertPltTransfers } from "../store/plt.pg";
import type { ParsedPltTransfer } from "./parser";

export type IngestResult = {
  blockHash: string;
  height: number;
  network: string;
  transfersInserted: number;
};

/**
 * Ingest a single finalized block + its PLT transfers into storage.
 *
 * This function is idempotent:
 *  - blocks_finalized is upserted by block_hash
 *  - plt_transfers uses (tx_hash, event_index) PK with ON CONFLICT DO NOTHING
 */
export async function ingestFinalizedBlock(options: {
  network: string;              // e.g. "concordium:testnet"
  blockHash: string;
  height: number;
  finalizedAt: Date | string;
  transfers: ParsedPltTransfer[];
}): Promise<IngestResult> {
  const { network, blockHash, height, finalizedAt, transfers } = options;

  // Ensure the block record exists / is updated.
  await upsertFinalizedBlock({
    block_hash: blockHash,
    network,
    height,
    finalized_at: finalizedAt,
  });

  // Map ParsedPltTransfer[] into the DB schema expected by insertPltTransfers.
  const dbTransfers = transfers.map((t) => ({
    tx_hash: t.txHash,
    event_index: t.eventIndex,
    block_hash: t.blockHash,
    network,
    token_id: t.tokenId,
    from_addr: t.from,
    to_addr: t.to,
    amount_minor: t.amountMinor,
    decimals: t.decimals,
    occurred_at: t.occurredAt,
  }));

  const { inserted } = await insertPltTransfers(dbTransfers);

  return {
    blockHash,
    height,
    network,
    transfersInserted: inserted,
  };
}
