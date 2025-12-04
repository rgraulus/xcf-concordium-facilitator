// src/store/plt.pg.ts
//
// Postgres helpers for PLT-related data:
//   - crp_finalized_blocks
//   - crp_plt_events
//
// Public API (used by the worker):
//   - upsertFinalizedBlock(input)
//   - insertPltTransfers(events)

import { Pool } from "pg";

export interface UpsertFinalizedBlockInput {
  block_hash: string;
  network: string;
  height: number;
  finalized_at: Date;
}

export interface FinalizedBlockRow {
  block_hash: string;
  network: string;
  height: number;
  finalized_at: Date;
}

export interface PltTransferInsertInput {
  network: string;
  token_id: string;
  tx_hash: string;
  event_index: number;
  block_hash: string;
  block_height: number;
  from_addr: string | null;
  to_addr: string | null;
  amount_minor: string; // minor units, e.g. "1000000" for 1.000000 with 6 decimals
  decimals: number;
  occurred_at: Date;
}

export interface InsertPltTransfersResult {
  inserted: number;
}

let pool: Pool | null = null;
let schemaInitialized = false;
let schemaInitPromise: Promise<void> | null = null;

function getPool(): Pool {
  if (!pool) {
    const databaseUrl =
      process.env.DATABASE_URL ??
      "postgres://postgres:pg@127.0.0.1:5432/postgres";

    // eslint-disable-next-line no-console
    console.log("[DB] Using", databaseUrl);

    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

async function ensureSchema(): Promise<void> {
  if (schemaInitialized) return;
  if (!schemaInitPromise) {
    const p = getPool();
    schemaInitPromise = (async () => {
      // Idempotent, conservative schema creation. If tables already exist,
      // these CREATE TABLE IF NOT EXISTS statements are no-ops and we do
      // not attempt to ALTER anything.
      await p.query(`
        CREATE TABLE IF NOT EXISTS crp_finalized_blocks (
          block_hash   TEXT        NOT NULL,
          network      TEXT        NOT NULL,
          height       BIGINT      NOT NULL,
          finalized_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (block_hash, network)
        )
      `);

      await p.query(`
        CREATE TABLE IF NOT EXISTS crp_plt_events (
          id           BIGSERIAL PRIMARY KEY,
          network      TEXT        NOT NULL,
          token_id     TEXT        NOT NULL,
          tx_hash      TEXT        NOT NULL,
          event_index  INTEGER     NOT NULL,
          block_hash   TEXT        NOT NULL,
          block_height BIGINT      NOT NULL,
          from_addr    TEXT,
          to_addr      TEXT,
          amount_minor TEXT        NOT NULL,
          decimals     INTEGER     NOT NULL,
          occurred_at  TIMESTAMPTZ NOT NULL,
          inserted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      schemaInitialized = true;
    })();
  }
  return schemaInitPromise;
}

/**
 * Upsert a finalized block row keyed by (block_hash, network).
 */
export async function upsertFinalizedBlock(
  input: UpsertFinalizedBlockInput
): Promise<FinalizedBlockRow> {
  await ensureSchema();
  const p = getPool();

  const res = await p.query(
    `
    INSERT INTO crp_finalized_blocks (
      block_hash,
      network,
      height,
      finalized_at
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (block_hash, network)
    DO UPDATE SET
      height       = EXCLUDED.height,
      finalized_at = EXCLUDED.finalized_at
    RETURNING block_hash, network, height, finalized_at
    `,
    [input.block_hash, input.network, input.height, input.finalized_at]
  );

  const row = res.rows[0];

  return {
    block_hash: row.block_hash,
    network: row.network,
    height: Number(row.height),
    finalized_at: row.finalized_at,
  };
}

/**
 * Insert one or more PLT transfer rows into crp_plt_events.
 *
 * We explicitly include block_height because the existing schema
 * has this column as NOT NULL.
 */
export async function insertPltTransfers(
  events: PltTransferInsertInput[]
): Promise<InsertPltTransfersResult> {
  if (events.length === 0) {
    return { inserted: 0 };
  }

  await ensureSchema();
  const p = getPool();

  const values: any[] = [];
  const chunks: string[] = [];

  events.forEach((ev, idx) => {
    const base = idx * 11;
    chunks.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`
    );

    values.push(
      ev.network,
      ev.token_id,
      ev.tx_hash,
      ev.event_index,
      ev.block_hash,
      ev.block_height,
      ev.from_addr,
      ev.to_addr,
      ev.amount_minor,
      ev.decimals,
      ev.occurred_at
    );
  });

  const sql = `
    INSERT INTO crp_plt_events (
      network,
      token_id,
      tx_hash,
      event_index,
      block_hash,
      block_height,
      from_addr,
      to_addr,
      amount_minor,
      decimals,
      occurred_at
    )
    VALUES ${chunks.join(", ")}
  `;

  const res = await p.query(sql, values);
  return { inserted: res.rowCount ?? 0 };
}
