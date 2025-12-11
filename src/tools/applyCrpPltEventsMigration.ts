// src/tools/applyCrpPltEventsMigration.ts
//
// M3.2 – PLT schema + registry
// Creates:
//   - crp_plt_assets: PLT asset/decimals registry
//   - crp_plt_events: raw PLT transfer events
//
// Safe to run multiple times (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).

import { Client } from "pg";

function getConnectionString(): string {
  const conn =
    process.env.CRP_DB_CONN_STRING ??
    process.env.DATABASE_URL ??
    // Fallback for local xcf-pg (shared with transaction-logger)
    "postgres://postgres:pg@127.0.0.1:5432/transaction-outcome";
  return conn;
}

async function main(): Promise<void> {
  const connectionString = getConnectionString();
  const client = new Client({ connectionString });

  console.log(
    JSON.stringify({
      source: "plt-migration",
      step: "connecting",
      connectionStringRedacted: true,
    })
  );

  await client.connect();

  try {
    console.log(
      JSON.stringify({
        source: "plt-migration",
        step: "begin",
      })
    );

    await client.query("BEGIN;");

    // 1) Asset / decimals registry
    await client.query(`
      CREATE TABLE IF NOT EXISTS crp_plt_assets (
        asset_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        decimals INTEGER NOT NULL,
        description TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 2) Raw PLT transfer events
    await client.query(`
      CREATE TABLE IF NOT EXISTS crp_plt_events (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- Chain location
        block_hash TEXT NOT NULL,
        block_height BIGINT NOT NULL,
        transaction_hash TEXT NOT NULL,
        event_index INTEGER NOT NULL,

        -- Semantics
        event_type TEXT NOT NULL, -- e.g. 'transfer', 'mint', 'burn'
        from_address TEXT,
        to_address TEXT,

        -- Amount in atomic units (raw integer)
        amount_raw NUMERIC(38, 0) NOT NULL,
        asset_id TEXT NOT NULL REFERENCES crp_plt_assets(asset_id),

        -- Network / rail
        network_genesis_index INTEGER NOT NULL,
        finalized BOOLEAN NOT NULL DEFAULT TRUE,

        -- One row per on-chain event
        UNIQUE (transaction_hash, event_index)
      );
    `);

    // Indexes to support common lookups:
    await client.query(`
      CREATE INDEX IF NOT EXISTS crp_plt_events_block_height_idx
        ON crp_plt_events (block_height);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS crp_plt_events_tx_hash_idx
        ON crp_plt_events (transaction_hash);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS crp_plt_events_to_addr_amount_idx
        ON crp_plt_events (to_address, asset_id, amount_raw);
    `);

    await client.query("COMMIT;");

    console.log(
      JSON.stringify({
        source: "plt-migration",
        step: "done",
        tables: ["crp_plt_assets", "crp_plt_events"],
      })
    );
  } catch (err) {
    console.error("[plt-migration] failed:", err);
    try {
      await client.query("ROLLBACK;");
    } catch {
      // ignore rollback failure
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[plt-migration] crashed:", err);
    process.exitCode = 1;
  });
}
