// src/tools/applyCrpPltEventsMigration.ts
//
// Small helper to create the crp_plt_events table via Node/pg,
// so we don't depend on the psql CLI being installed.
//
// Usage:
//
//   export DATABASE_URL=postgres://postgres:pg@127.0.0.1:5432/postgres
//   npx ts-node src/tools/applyCrpPltEventsMigration.ts
//

import "dotenv/config";
import { Client } from "pg";

const MIGRATION_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.tables
    WHERE  table_schema = 'public'
    AND    table_name   = 'crp_plt_events'
  ) THEN
    CREATE TABLE public.crp_plt_events (
      id            BIGSERIAL PRIMARY KEY,
      network       TEXT        NOT NULL,  -- e.g. "concordium:testnet"
      token_id      TEXT        NOT NULL,  -- on-chain PLT token id, e.g. "EUDemo"
      tx_hash       TEXT        NOT NULL,  -- transaction hash (hex string)
      event_index   INTEGER     NOT NULL,  -- index of the event within the tx
      block_hash    TEXT        NOT NULL,  -- containing block hash (hex string)
      block_height  BIGINT      NOT NULL,  -- containing block height
      from_addr     TEXT        NOT NULL,  -- sender address (CCD account or contract)
      to_addr       TEXT        NOT NULL,  -- recipient address
      amount_minor  NUMERIC(30,0) NOT NULL, -- integer amount in minor units (scaled by decimals)
      decimals      INTEGER     NOT NULL,  -- token decimals (e.g. 6 for EUDemo)
      occurred_at   TIMESTAMPTZ NOT NULL,  -- when it happened on-chain (approx/finalized time)
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() -- when we stored it
    );

    CREATE INDEX crp_plt_events_token_idx
      ON public.crp_plt_events (network, token_id);

    CREATE INDEX crp_plt_events_block_idx
      ON public.crp_plt_events (block_height DESC);

    CREATE INDEX crp_plt_events_tx_idx
      ON public.crp_plt_events (tx_hash, event_index);

    CREATE INDEX crp_plt_events_addr_idx
      ON public.crp_plt_events (from_addr, to_addr);
  END IF;
END
$$;
`;

async function main() {
  const dbUrl =
    process.env.DATABASE_URL ||
    "postgres://postgres:pg@127.0.0.1:5432/postgres";

  // eslint-disable-next-line no-console
  console.log("[PLT-MIGRATE] Using DATABASE_URL:", dbUrl);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // eslint-disable-next-line no-console
    console.log("[PLT-MIGRATE] Applying crp_plt_events migration...");
    await client.query(MIGRATION_SQL);
    // eslint-disable-next-line no-console
    console.log("[PLT-MIGRATE] Migration applied successfully.");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[PLT-MIGRATE] Error while applying migration:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
