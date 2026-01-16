// src/store/plt.pg.ts
//
// Postgres helpers for PLT-related tables.
// Canonical schema (M4.2):
//   - public.crp_plt_assets (network-scoped decimals registry)
//       PK: (network, network_genesis_index, asset_id)
//   - public.crp_plt_events  (raw PLT transfers, amount_raw + asset_id)
//       FK: (network, network_genesis_index, asset_id) -> crp_plt_assets(...)
//
// Public API (used by worker and routes):
//   - insertPltTransfers(events)  // inserts into crp_plt_events (idempotent)
//
// IMPORTANT:
// - This module is NOT a full migration runner.
// - It will create tables/indexes if missing, and then validate the schema.
// - If your DB has an older incompatible schema, it will throw and instruct you
//   to run: npx ts-node src/tools/applyCrpPltEventsMigration.ts

import { Pool } from "pg";

function getDatabaseUrlOrThrow(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error("DATABASE_URL is required for PLT persistence.");
  }
  return url;
}

const pool = new Pool({
  connectionString: getDatabaseUrlOrThrow(),
});

let schemaInitialized = false;
let schemaInitPromise: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (schemaInitialized) return;

  if (!schemaInitPromise) {
    schemaInitPromise = (async () => {
      const p = pool;

      // 1) Create tables if missing (canonical M4.2 shape).
      await p.query(`
        CREATE TABLE IF NOT EXISTS public.crp_plt_assets (
          network               TEXT    NOT NULL,
          network_genesis_index INTEGER NOT NULL,
          asset_id              TEXT    NOT NULL,
          symbol                TEXT    NOT NULL,
          decimals              INTEGER NOT NULL,
          description           TEXT,
          enabled               BOOLEAN NOT NULL DEFAULT TRUE,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (network, network_genesis_index, asset_id)
        );
      `);

      await p.query(`
        CREATE TABLE IF NOT EXISTS public.crp_plt_events (
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
          asset_id TEXT NOT NULL,

          occurred_at TIMESTAMPTZ NOT NULL,

          -- One row per on-chain event
          UNIQUE (transaction_hash, event_index)
        );
      `);

      // 2) Validate that assets table has the expected columns.
      // (If not, we are in an older schema state and should not attempt to auto-migrate here.)
      const colsRes = await p.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='crp_plt_assets'
        `,
        []
      );

      const cols = new Set<string>(colsRes.rows.map((r) => String(r.column_name)));
      for (const required of ["network", "network_genesis_index", "asset_id", "decimals", "enabled"]) {
        if (!cols.has(required)) {
          throw new Error(
            `[PLT][schema] public.crp_plt_assets is missing required column '${required}'. ` +
              `Your DB schema is not M4.2-compatible. Run:\n` +
              `  npx ts-node src/tools/applyCrpPltEventsMigration.ts`
          );
        }
      }

      // 3) Ensure FK exists from events -> assets (composite).
      // Safe to attempt "ADD CONSTRAINT" only if missing.
      const fkRes = await p.query(
        `
        SELECT conname
        FROM pg_constraint
        WHERE conrelid='public.crp_plt_events'::regclass
          AND contype='f'
          AND conname='crp_plt_events_asset_fk'
        LIMIT 1
        `,
        []
      );

      if (fkRes.rows.length === 0) {
        await p.query(`
          ALTER TABLE public.crp_plt_events
            ADD CONSTRAINT crp_plt_events_asset_fk
            FOREIGN KEY (network, network_genesis_index, asset_id)
            REFERENCES public.crp_plt_assets (network, network_genesis_index, asset_id)
            ON UPDATE CASCADE
            ON DELETE RESTRICT;
        `);
      }

      // 4) Indexes (idempotent)
      await p.query(`
        CREATE INDEX IF NOT EXISTS crp_plt_events_block_height_idx
          ON public.crp_plt_events (block_height);
      `);

      await p.query(`
        CREATE INDEX IF NOT EXISTS crp_plt_events_tx_hash_idx
          ON public.crp_plt_events (transaction_hash);
      `);

      await p.query(`
        CREATE INDEX IF NOT EXISTS crp_plt_events_to_addr_amount_idx
          ON public.crp_plt_events (to_address, asset_id, amount_raw);
      `);

      await p.query(`
        CREATE INDEX IF NOT EXISTS crp_plt_events_network_height_idx
          ON public.crp_plt_events (network, block_height);
      `);

      await p.query(`
        CREATE INDEX IF NOT EXISTS crp_plt_events_network_asset_idx
          ON public.crp_plt_events (network, network_genesis_index, asset_id);
      `);

      await p.query(`
        CREATE INDEX IF NOT EXISTS crp_plt_assets_enabled_idx
          ON public.crp_plt_assets (network, network_genesis_index, enabled);
      `);

      schemaInitialized = true;
    })();
  }

  await schemaInitPromise;
}

// Canonical insert shape for crp_plt_events.
// Mirrors the DB columns (no "amount_minor/decimals/token_id" legacy fields).
export type PltEventInsertInput = {
  block_hash: string;
  block_height: number;
  transaction_hash: string;
  event_index: number;

  network: string;
  network_genesis_index: number;
  finalized: boolean;

  event_type: string;
  from_address: string | null;
  to_address: string | null;

  amount_raw: string; // integer string, already in minor units
  asset_id: string;   // plain tokenId (e.g. "EUDemo")

  occurred_at: string; // ISO timestamp
};

/**
 * Insert one or more PLT event rows into crp_plt_events.
 * Idempotent by UNIQUE(transaction_hash, event_index).
 *
 * Returns { inserted } count (rows that were newly inserted).
 */
export async function insertPltTransfers(
  events: PltEventInsertInput[]
): Promise<{ inserted: number }> {
  if (!events || events.length === 0) return { inserted: 0 };

  await ensureSchema();

  // Bulk insert via VALUES list
  const values: any[] = [];
  const tuples: string[] = [];

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];

    // 13 columns in INSERT (excluding id/created_at/updated_at)
    const base = i * 13;

    values.push(
      ev.block_hash,
      String(ev.block_height),
      ev.transaction_hash,
      String(ev.event_index),

      ev.network,
      String(ev.network_genesis_index),
      ev.finalized,

      ev.event_type,
      ev.from_address,
      ev.to_address,

      ev.amount_raw,
      ev.asset_id,

      ev.occurred_at
    );

    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, ` +
        `$${base + 5}, $${base + 6}, $${base + 7}, ` +
        `$${base + 8}, $${base + 9}, $${base + 10}, ` +
        `$${base + 11}, $${base + 12}, $${base + 13})`
    );
  }

  const sql = `
    INSERT INTO public.crp_plt_events (
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

      occurred_at
    )
    VALUES
      ${tuples.join(",\n      ")}
    ON CONFLICT (transaction_hash, event_index) DO NOTHING
  `;

  const res = await pool.query(sql, values);
  return { inserted: res.rowCount ?? 0 };
}

export { pool };
