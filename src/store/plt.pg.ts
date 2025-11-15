// src/store/plt.pg.ts
import { pool } from "../db/pool";

/**
 * Storage helpers for finalized blocks and PLT transfers.
 * Schema is defined in db/migrations/002_m3_stream.sql.
 */

export type FinalizedBlock = {
  block_hash: string;
  network: string;        // e.g. "concordium:testnet"
  height: number;         // BIGINT -> JS number (be cautious if heights get very large)
  finalized_at: string;   // ISO string
  created_at: string;     // ISO string
};

export type PltTransfer = {
  tx_hash: string;
  event_index: number;
  block_hash: string;
  network: string;
  token_id: string;
  from_addr: string | null;
  to_addr: string;
  amount_minor: string;   // numeric(38,0) -> string in JS
  decimals: number;
  occurred_at: string;    // ISO string
  created_at: string;     // ISO string
};

function toFinalizedBlockRow(row: any): FinalizedBlock {
  return {
    block_hash: row.block_hash,
    network: row.network,
    height: Number(row.height),
    finalized_at: new Date(row.finalized_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toPltTransferRow(row: any): PltTransfer {
  return {
    tx_hash: row.tx_hash,
    event_index: Number(row.event_index),
    block_hash: row.block_hash,
    network: row.network,
    token_id: row.token_id,
    from_addr: row.from_addr ?? null,
    to_addr: row.to_addr,
    amount_minor: row.amount_minor.toString(), // numeric -> string
    decimals: Number(row.decimals),
    occurred_at: new Date(row.occurred_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * Upsert a finalized block by block_hash.
 * If it already exists, height/network/finalized_at are updated.
 */
export async function upsertFinalizedBlock(input: {
  block_hash: string;
  network: string;
  height: number | string;
  finalized_at: string | Date;
}): Promise<FinalizedBlock> {
  const { block_hash, network, height, finalized_at } = input;

  const res = await pool.query(
    `
    INSERT INTO blocks_finalized (block_hash, network, height, finalized_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (block_hash)
    DO UPDATE SET
      network = EXCLUDED.network,
      height = EXCLUDED.height,
      finalized_at = EXCLUDED.finalized_at
    RETURNING *;
    `,
    [
      block_hash,
      network,
      height,
      new Date(finalized_at).toISOString(),
    ]
  );

  return toFinalizedBlockRow(res.rows[0]);
}

/**
 * Batch insert PLT transfers.
 * - ON CONFLICT DO NOTHING on (tx_hash, event_index) to keep this idempotent.
 * - Returns the number of rows successfully inserted (not counting conflicts).
 */
export async function insertPltTransfers(
  transfers: Array<{
    tx_hash: string;
    event_index: number;
    block_hash: string;
    network: string;
    token_id: string;
    from_addr: string | null;
    to_addr: string;
    amount_minor: string | number; // integer minor units
    decimals: number;
    occurred_at: string | Date;
  }>
): Promise<{ inserted: number }> {
  if (transfers.length === 0) {
    return { inserted: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let inserted = 0;
    for (const t of transfers) {
      const res = await client.query(
        `
        INSERT INTO plt_transfers (
          tx_hash,
          event_index,
          block_hash,
          network,
          token_id,
          from_addr,
          to_addr,
          amount_minor,
          decimals,
          occurred_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (tx_hash, event_index)
        DO NOTHING
        RETURNING *;
        `,
        [
          t.tx_hash,
          t.event_index,
          t.block_hash,
          t.network,
          t.token_id,
          t.from_addr,
          t.to_addr,
          t.amount_minor,
          t.decimals,
          new Date(t.occurred_at).toISOString(),
        ]
      );

      if ((res.rowCount ?? 0) > 0) {
        inserted += res.rowCount!;
      }
    }

    await client.query("COMMIT");
    return { inserted };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Search PLT transfers for the matching endpoint.
 * All filters are optional; if none provided, this returns the most recent transfers
 * (bounded by limit).
 */
export async function searchPltTransfers(filters: {
  tokenId?: string;
  to?: string;
  amountMinor?: string;      // integer minor units as string
  limit?: number;
}): Promise<PltTransfer[]> {
  const where: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.tokenId) {
    where.push(`token_id = $${idx++}`);
    params.push(filters.tokenId);
  }

  if (filters.to) {
    where.push(`to_addr = $${idx++}`);
    params.push(filters.to);
  }

  if (filters.amountMinor) {
    where.push(`amount_minor = $${idx++}`); // exact match on numeric(38,0)
    params.push(filters.amountMinor);
  }

  const limit = filters.limit && filters.limit > 0 ? filters.limit : 25;
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const res = await pool.query(
    `
    SELECT *
      FROM plt_transfers
      ${whereClause}
     ORDER BY occurred_at DESC
     LIMIT $${idx};
    `,
    [...params, limit]
  );

  return res.rows.map(toPltTransferRow);
}
