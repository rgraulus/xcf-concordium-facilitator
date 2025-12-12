// src/tools/debugTxByHash.ts
//
// M3.4 – Lookup a single transaction summary by hash.
//
// Purpose:
//   - Connect to the transaction-logger DB
//   - Find rows in `summaries` whose summary.Left.hash or summary.Right.hash
//     matches a given transaction hash
//   - Dump a small snapshot of matching rows
//
// This is purely read-only and safe to run multiple times.
//
// Usage:
//   export XCF_DEBUG_TX_HASH="<transaction-hash-hex>"
//   npx ts-node src/tools/debugTxByHash.ts
//
// Connection priority:
//   1) TX_DB_CONN_STRING
//   2) CRP_DB_CONN_STRING
//   3) DATABASE_URL
//   4) Fallback to local xcf-pg / transaction-outcome

import { Client } from "pg";

interface TxSummaryRow {
  id: string;
  height: string;
  timestamp: string;
  summary: unknown;
}

function getConnectionString(): string {
  const conn =
    process.env.TX_DB_CONN_STRING ??
    process.env.CRP_DB_CONN_STRING ??
    process.env.DATABASE_URL ??
    "postgres://postgres:pg@127.0.0.1:5432/transaction-outcome";

  return conn;
}

function getTxHash(): string {
  const hash = process.env.XCF_DEBUG_TX_HASH;
  if (!hash || !hash.trim()) {
    throw new Error(
      "XCF_DEBUG_TX_HASH is required. Set it to the transaction hash you want to inspect."
    );
  }
  return hash.trim();
}

async function main(): Promise<void> {
  const connectionString = getConnectionString();
  const txHash = getTxHash();

  console.log(
    JSON.stringify({
      source: "debug-tx-by-hash",
      step: "connecting",
      connectionStringRedacted: true,
      txHash,
    })
  );

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // We search for the hash in summary.Left.hash or summary.Right.hash.
    const sql = `
      SELECT
        id::text,
        height::text,
        timestamp::text,
        summary
      FROM summaries
      WHERE
        (summary->'Left'->>'hash' = $1)
        OR (summary->'Right'->>'hash' = $1)
      ORDER BY id::bigint DESC
      LIMIT 10;
    `;

    console.log(
      JSON.stringify({
        source: "debug-tx-by-hash",
        step: "query",
        txHash,
      })
    );

    const res = await client.query<TxSummaryRow>(sql, [txHash]);

    console.log(
      JSON.stringify(
        {
          source: "debug-tx-by-hash",
          step: "snapshot",
          txHash,
          rowCount: res.rowCount,
          rows: res.rows,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error("[debug-tx-by-hash] failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[debug-tx-by-hash] crashed:", err);
    process.exitCode = 1;
  });
}
