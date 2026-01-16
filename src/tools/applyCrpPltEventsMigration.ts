// src/tools/applyCrpPltEventsMigration.ts
//
// M4.2 – PLT schema + registry
// Creates / migrates:
//   - crp_plt_assets: network-scoped decimals/enablement registry
//   - crp_plt_events: raw PLT transfer events
//
// This migration is intentionally defensive:
// - If an older crp_plt_assets exists with a PK on (asset_id) only, we:
//   1) add network columns,
//   2) backfill defaults,
//   3) DROP the existing PK (whatever its name / columns),
//   4) recreate composite PK (network, network_genesis_index, asset_id),
//   5) recreate FK from events to assets.

import { Client } from "pg";

const DEFAULT_PLT_ASSET_NETWORK = process.env.CRP_DEFAULT_NETWORK ?? "concordium:testnet";
const DEFAULT_PLT_ASSET_NETWORK_SQL = DEFAULT_PLT_ASSET_NETWORK.replace(/\'/g, "''");
const DEFAULT_PLT_ASSET_GENESIS_INDEX = Number.isFinite(Number(process.env.CRP_DEFAULT_NETWORK_GENESIS_INDEX))
  ? Number(process.env.CRP_DEFAULT_NETWORK_GENESIS_INDEX)
  : 6;

function getConnectionString(): string {
  const conn =
    process.env.CRP_DB_CONN_STRING ??
    process.env.DATABASE_URL ??
    "postgres://postgres:pg@127.0.0.1:5432/transaction-outcome";
  return conn;
}

function log(msg: any): void {
  // eslint-disable-next-line no-console
  console.log("[PLT-MIGRATION]", msg);
}

export async function applyCrpPltEventsMigration(): Promise<void> {
  const client = new Client({ connectionString: getConnectionString() });

  try {
    await client.connect();

    log(JSON.stringify({ source: "plt-migration", step: "begin" }));
    await client.query("BEGIN;");

    // 1) Ensure tables exist (does NOT override old shapes; we handle that below).
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.crp_plt_assets (
        -- M4.2 target shape (network scoped)
        network               TEXT,
        network_genesis_index INTEGER,
        asset_id              TEXT    NOT NULL,
        symbol                TEXT    NOT NULL,
        decimals              INTEGER NOT NULL,
        description           TEXT,
        enabled               BOOLEAN NOT NULL DEFAULT TRUE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
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

        UNIQUE (transaction_hash, event_index)
      );
    `);

    // 2) Ensure network columns exist on assets (older table may not have them).
    await client.query(`
      ALTER TABLE public.crp_plt_assets
        ADD COLUMN IF NOT EXISTS network               TEXT,
        ADD COLUMN IF NOT EXISTS network_genesis_index INTEGER;
    `);

    // 3) Backfill defaults for existing rows so composite PK can be created.
    await client.query(
      `
      UPDATE public.crp_plt_assets
         SET network = $1
       WHERE network IS NULL
      `,
      [DEFAULT_PLT_ASSET_NETWORK]
    );

    await client.query(
      `
      UPDATE public.crp_plt_assets
         SET network_genesis_index = $1
       WHERE network_genesis_index IS NULL
      `,
      [DEFAULT_PLT_ASSET_GENESIS_INDEX]
    );

    await client.query(`
      ALTER TABLE public.crp_plt_assets
        ALTER COLUMN network SET DEFAULT '${DEFAULT_PLT_ASSET_NETWORK_SQL}',
        ALTER COLUMN network_genesis_index SET DEFAULT ${DEFAULT_PLT_ASSET_GENESIS_INDEX},
        ALTER COLUMN network SET NOT NULL,
        ALTER COLUMN network_genesis_index SET NOT NULL;
    `);

    // 4) Drop any existing FK constraints on crp_plt_events (old FK may reference assets(asset_id)).
    await client.query(`
      DO $$
      DECLARE
        r record;
      BEGIN
        FOR r IN
          SELECT c.conname AS name
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public'
            AND t.relname = 'crp_plt_events'
            AND c.contype = 'f'
        LOOP
          EXECUTE format('ALTER TABLE public.crp_plt_events DROP CONSTRAINT %I', r.name);
        END LOOP;
      END $$;
    `);

    // 5) Drop the existing PRIMARY KEY on crp_plt_assets (whatever its name/columns), then recreate composite PK.
    //    (If there were other tables referencing it, we'd have to drop those FKs too; currently only events matters.)
    await client.query(`
      DO $$
      DECLARE
        pk_name text;
      BEGIN
        SELECT c.conname INTO pk_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname='public'
          AND t.relname='crp_plt_assets'
          AND c.contype='p'
        LIMIT 1;

        IF pk_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE public.crp_plt_assets DROP CONSTRAINT %I', pk_name);
        END IF;
      END $$;
    `);

    // Create the desired composite PK.
    await client.query(`
      ALTER TABLE public.crp_plt_assets
        ADD CONSTRAINT crp_plt_assets_pkey
        PRIMARY KEY (network, network_genesis_index, asset_id);
    `);

    // 6) Create the desired composite FK from events -> assets.
    await client.query(`
      ALTER TABLE public.crp_plt_events
        ADD CONSTRAINT crp_plt_events_asset_fk
        FOREIGN KEY (network, network_genesis_index, asset_id)
        REFERENCES public.crp_plt_assets (network, network_genesis_index, asset_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT;
    `);

    // 7) Indexes (idempotent)
    await client.query(`
      CREATE INDEX IF NOT EXISTS crp_plt_events_block_height_idx
        ON public.crp_plt_events (block_height);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS crp_plt_events_tx_hash_idx
        ON public.crp_plt_events (transaction_hash);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS crp_plt_events_to_addr_amount_idx
        ON public.crp_plt_events (to_address, asset_id, amount_raw);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS crp_plt_events_network_height_idx
        ON public.crp_plt_events (network, block_height);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS crp_plt_events_network_asset_idx
        ON public.crp_plt_events (network, network_genesis_index, asset_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS crp_plt_assets_enabled_idx
        ON public.crp_plt_assets (network, network_genesis_index, enabled);
    `);

    const verify = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name IN ('crp_plt_assets', 'crp_plt_events')
      ORDER BY table_name;
    `);

    log(JSON.stringify({ source: "plt-migration", step: "verify", tables: verify.rows }));

    await client.query("COMMIT;");
    log(JSON.stringify({ source: "plt-migration", step: "commit" }));
  } catch (err: any) {
    try {
      await client.query("ROLLBACK;");
    } catch {
      // ignore
    }
    log(JSON.stringify({ source: "plt-migration", step: "error", err: String(err?.message ?? err) }));
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  applyCrpPltEventsMigration()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("[PLT-MIGRATION] done");
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[PLT-MIGRATION] failed:", err);
      process.exitCode = 1;
    });
}
