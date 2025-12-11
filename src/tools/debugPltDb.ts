// src/tools/debugPltDb.ts
//
// M3.2 – Quick snapshot of PLT schema
// Shows:
//   - counts for crp_plt_assets / crp_plt_events
//   - up to 10 assets
//   - up to 10 most recent events

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

  console.log(
    JSON.stringify({
      source: "debug-plt-db",
      step: "connecting",
      connectionStringRedacted: true,
    })
  );

  await client.connect();

  try {
    const { rows: assetCountRows } = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM crp_plt_assets;"
    );
    const { rows: eventCountRows } = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM crp_plt_events;"
    );
    const { rows: assetRows } = await client.query(
      `
      SELECT asset_id, symbol, decimals, enabled
      FROM crp_plt_assets
      ORDER BY asset_id
      LIMIT 10;
      `
    );
    const { rows: eventRows } = await client.query(
      `
      SELECT
        id,
        block_height,
        transaction_hash,
        event_index,
        amount_raw,
        asset_id,
        to_address
      FROM crp_plt_events
      ORDER BY id DESC
      LIMIT 10;
      `
    );

    console.log(
      JSON.stringify(
        {
          source: "debug-plt-db",
          step: "snapshot",
          counts: {
            assets: Number(assetCountRows[0]?.count ?? "0"),
            events: Number(eventCountRows[0]?.count ?? "0"),
          },
          sampleAssets: assetRows,
          sampleEvents: eventRows,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error("[debug-plt-db] failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[debug-plt-db] crashed:", err);
    process.exitCode = 1;
  });
}
