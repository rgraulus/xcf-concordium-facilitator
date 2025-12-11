// src/tools/debugTxSummary.ts
//
// M3.3 – Quick snapshot of transaction-logger summaries.
//
// Purpose:
//   - Connect to the transaction-logger DB
//   - Show total row count in `summaries`
//   - Dump a small sample of recent rows
//
// Connection priority:
//   1) TX_DB_CONN_STRING
//   2) CRP_DB_CONN_STRING
//   3) DATABASE_URL
//   4) Fallback to local xcf-pg / transaction-outcome

import { Client } from "pg";

function getConnectionString(): string {
  const conn =
    process.env.TX_DB_CONN_STRING ??
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
      source: "debug-tx-summary",
      step: "connecting",
      connectionStringRedacted: true,
    })
  );

  await client.connect();

  try {
    // 1) Total count in summaries
    const countRes = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM summaries;"
    );

    // 2) Small sample of rows (ordered by first column desc as a generic heuristic)
    const sampleRes = await client.query(
      `
      SELECT *
      FROM summaries
      ORDER BY 1 DESC
      LIMIT 10;
      `
    );

    console.log(
      JSON.stringify(
        {
          source: "debug-tx-summary",
          step: "snapshot",
          total: Number(countRes.rows[0]?.count ?? "0"),
          sample: sampleRes.rows,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error("[debug-tx-summary] failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[debug-tx-summary] crashed:", err);
    process.exitCode = 1;
  });
}
