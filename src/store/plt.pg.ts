// src/store/plt.pg.ts
//
// Postgres helpers for PLT-related data.
// Canonical tables (created by migration:apply:plt):
//   - crp_plt_assets
//   - crp_plt_events
//
// Public API (used by worker and tools):
//   - insertPltTransfers(events)   // inserts into crp_plt_events (idempotent)
//   - upsertFinalizedBlock(...)    // kept for future use (optional)

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

/**
 * Canonical insert shape for crp_plt_events.
 * Mirrors the DB columns (no "amount_minor/decimals/token_id" legacy fields).
 */
export interface PltEventInsertInput {
  // Chain location
  block_hash: string;
  block_height: number;
  transaction_hash: string;
  event_index: number;

  // Network / rail
  network: string;
  network_genesis_index: number;
  finalized?: boolean;

  // Semantics
  event_type: string; // e.g. 'transfer'
  from_address: string | null;
  to_address: string | null;

  // Amount in atomic units (raw integer)
  amount_raw: string; // NUMERIC(38,0) as string
  asset_id: string; // FK -> crp_plt_assets(asset_id)

  occurred_at: Date;
}

// Back-compat alias: older code may still import this name.
export type PltTransferInsertInput = PltEventInsertInput;

export interface InsertPltTransfersResult {
  inserted: number;
}

let pool: Pool | null = null;
let schemaInitialized = false;
let schemaInitPromise: Promise<void> | null = null;

function getConnectionString(): string {
  return (
    process.env.CRP_DB_CONN_STRING ??
    process.env.DATABASE_URL ??
    // Fallback for local xcf-pg (shared with transaction-logger)
    "postgres://postgres:pg@127.0.0.1:5432/transaction-outcome"
  );
}

function getPool(): Pool {
  if (!pool) {
    const databaseUrl = getConnectionString();
    // eslint-disable-next-line no-console
    console.log("[DB] Using", databaseUrl);
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

/**
 * Keep an idempotent schema guard for local/dev.
 * (Safe: CREATE TABLE/INDEX IF NOT EXISTS are no-ops if already created.)
 */
async function ensureSchema(): Promise<void> {
  if (schemaInitialized) return;
  if (!schemaInitPromise) {
    const p = getPool();
    schemaInitPromise = (async () => {
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
        CREATE TABLE IF NOT EXISTS crp_plt_assets (
          asset_id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          decimals INTEGER NOT NULL,
          description TEXT,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      await p.query(`
        CREATE TABLE IF NOT EXISTS crp_plt_events (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

          -- Chain location
          block_hash TEXT NOT NULL,
          block_height BIGINT NOT NULL,
          transaction_hash TEXT NOT NULL,
          event_index INTEGER NOT NULL,

          -- Network / rail
          network TEXT NOT NULL,
          network_genesis_index INTEGER NOT NULL,
          finalized BOOLEAN NOT NULL DEFAULT TRUE,

          -- Semantics
          event_type TEXT NOT NULL,
          from_address TEXT,
          to_address TEXT,

          -- Amount
          amount_raw NUMERIC(38, 0) NOT NULL,
          asset_id TEXT NOT NULL REFERENCES crp_plt_assets(asset_id),

          occurred_at TIMESTAMPTZ NOT NULL,

          -- One row per on-chain event
          UNIQUE (transaction_hash, event_index)
        )
      `);

      await p.query(`
        CREATE INDEX IF NOT EXISTS crp_plt_events_block_height_idx
          ON crp_plt_events (block_height);
      `);

      await p.query(`
        CREATE INDEX IF NOT EXISTS crp_plt_events_tx_hash_idx
          ON crp_plt_events (transaction_hash);
      `);

      await p.query(`
        CREATE INDEX IF NOT EXISTS crp_plt_events_to_addr_amount_idx
          ON crp_plt_events (to_address, asset_id, amount_raw);
      `);

      await p.query(`
        CREATE INDEX IF NOT EXISTS crp_plt_events_network_height_idx
          ON crp_plt_events (network, block_height);
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
 * Insert one or more PLT event rows into crp_plt_events.
 *
 * Idempotent: ON CONFLICT (transaction_hash, event_index) DO NOTHING
 */
export async function insertPltTransfers(
  events: PltEventInsertInput[]
): Promise<InsertPltTransfersResult> {
  if (events.length === 0) {
    return { inserted: 0 };
  }

  await ensureSchema();
  const p = getPool();

  const values: any[] = [];
  const chunks: string[] = [];

  events.forEach((ev, idx) => {
    const base = idx * 14;

    chunks.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14})`
    );

    values.push(
      ev.block_hash,
      ev.block_height,
      ev.transaction_hash,
      ev.event_index,

      ev.network,
      ev.network_genesis_index,
      ev.finalized ?? true,

      ev.event_type,
      ev.from_address,
      ev.to_address,

      ev.amount_raw,
      ev.asset_id,

      ev.occurred_at,
      new Date() // updated_at
    );
  });

  const sql = `
    INSERT INTO crp_plt_events (
      block_hash,
      block_height,
      transaction_hash,
      event_index,

      network,
      network_genesis_index,
      finalized,

      event_type,
      from_address,
      to_address,

      amount_raw,
      asset_id,

      occurred_at,
      updated_at
    )
    VALUES ${chunks.join(", ")}
    ON CONFLICT (transaction_hash, event_index)
    DO NOTHING
  `;

  const res = await p.query(sql, values);
  return { inserted: res.rowCount ?? 0 };
}
