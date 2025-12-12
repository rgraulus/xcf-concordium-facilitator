// src/tools/seedPltAssets.ts
//
// M3.4 – Seed PLT asset registry (crp_plt_assets)
//
// Purpose:
//   - Insert (or update) a single row for the EUDemo PLT on testnet
//   - Idempotent via ON CONFLICT (asset_id) DO UPDATE
//
// This does NOT touch crp_plt_events and is safe to run multiple times.
//
// Usage (direct):
//   npx ts-node src/tools/seedPltAssets.ts
//
// Connection priority:
//   1) CRP_DB_CONN_STRING
//   2) DATABASE_URL
//   3) Fallback to local xcf-pg / transaction-outcome

import { Client } from "pg";

function getConnectionString(): string {
  const conn =
    process.env.CRP_DB_CONN_STRING ??
    process.env.DATABASE_URL ??
    "postgres://postgres:pg@127.0.0.1:5432/transaction-outcome";
  return conn;
}

async function main(): Promise<void> {
  const connectionString = getConnectionString();
  const client = new Client({ connectionString });

  // Hard-coded EUDemo PLT asset for testnet.
  // Decimals: 6 (per Concordium testnet explorers)
  // asset_id scheme matches the M3.4 Kick-off Pack.
  const assetId = "concordium:testnet:PLT:EUDemo";
  const symbol = "EUDemo";
  const decimals = 6;
  const description = "EUDemo testnet PLT (CIS-7 protocol-level token)";
  const enabled = true;

  console.log(
    JSON.stringify({
      source: "seed-plt-assets",
      step: "connecting",
      connectionStringRedacted: true,
      assetId,
      symbol,
      decimals,
      enabled,
    })
  );

  await client.connect();

  try {
    await client.query("BEGIN;");

    const upsertSql = `
      INSERT INTO crp_plt_assets (
        asset_id,
        symbol,
        decimals,
        description,
        enabled,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, now(), now())
      ON CONFLICT (asset_id) DO UPDATE SET
        symbol = EXCLUDED.symbol,
        decimals = EXCLUDED.decimals,
        description = EXCLUDED.description,
        enabled = EXCLUDED.enabled,
        updated_at = now();
    `;

    const params = [assetId, symbol, decimals, description, enabled];

    const res = await client.query(upsertSql, params);

    console.log(
      JSON.stringify({
        source: "seed-plt-assets",
        step: "upsert-done",
        rowCount: res.rowCount,
      })
    );

    await client.query("COMMIT;");

    console.log(
      JSON.stringify({
        source: "seed-plt-assets",
        step: "commit",
        assetId,
        symbol,
        decimals,
        enabled,
      })
    );
  } catch (err) {
    console.error("[seed-plt-assets] failed:", err);
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
    console.error("[seed-plt-assets] crashed:", err);
    process.exitCode = 1;
  });
}
