// src/tools/debugPltCandidates.ts
//
// M3.4 – Read-only probe for PLT-style events in transaction-outcome.summaries.
//
// Purpose:
//   - Connect to the transaction-logger DB
//   - Search the `summary` JSON for PLT-related event markers
//   - Dump a small sample of matching rows
//
// This is *purely read-only* and safe to run on your existing DB.
//
// Usage (no npm script yet; invoke directly with ts-node):
//   npx ts-node src/tools/debugPltCandidates.ts
//
// Optional environment variables:
//   XCF_PLT_SEARCH_TERMS      – comma-separated list of substrings to search for
//                               (default: "TokenTransfer,TokenMint,TokenBurn,TokenCreated,PLT")
//   XCF_PLT_CANDIDATE_LIMIT   – max number of rows to return (default: 25)
//
// Connection priority (same pattern as other tools):
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

function getSearchTerms(): string[] {
  const raw = process.env.XCF_PLT_SEARCH_TERMS;
  if (!raw || !raw.trim()) {
    return [
      "TokenTransfer",
      "TokenMint",
      "TokenBurn",
      "TokenCreated",
      "PLT",
    ];
  }

  const terms = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (terms.length === 0) {
    return [
      "TokenTransfer",
      "TokenMint",
      "TokenBurn",
      "TokenCreated",
      "PLT",
    ];
  }

  return terms;
}

function getCandidateLimit(): number {
  const raw = process.env.XCF_PLT_CANDIDATE_LIMIT;
  const n = raw ? Number(raw) : 25;
  if (!Number.isFinite(n) || n <= 0) {
    return 25;
  }
  return Math.min(n, 100); // keep output sane
}

async function main(): Promise<void> {
  const connectionString = getConnectionString();
  const terms = getSearchTerms();
  const limit = getCandidateLimit();

  console.log(
    JSON.stringify({
      source: "debug-plt-candidates",
      step: "connecting",
      connectionStringRedacted: true,
      terms,
      limit,
    })
  );

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // Build a WHERE clause like:
    //   summary::text ILIKE $1 OR summary::text ILIKE $2 OR ...
    const likeClauses: string[] = [];
    const params: any[] = [];

    terms.forEach((term, idx) => {
      likeClauses.push(`summary::text ILIKE $${idx + 1}`);
      params.push(`%${term}%`);
    });

    const whereClause =
      likeClauses.length > 0
        ? likeClauses.join(" OR ")
        : "TRUE"; // should never happen, but be defensive

    const countSql = `
      SELECT COUNT(*) AS count
      FROM summaries
      WHERE ${whereClause};
    `;

    const sampleSql = `
      SELECT
        id::text,
        height::text,
        timestamp::text,
        summary
      FROM summaries
      WHERE ${whereClause}
      ORDER BY id::bigint DESC
      LIMIT $${terms.length + 1};
    `;

    console.log(
      JSON.stringify({
        source: "debug-plt-candidates",
        step: "query-params",
        whereClause,
        termCount: terms.length,
        limit,
      })
    );

    // Total count (this may take a bit of time but is fine for ~500k rows)
    const countRes = await client.query<{ count: string }>(countSql, params);
    const totalMatches = Number(countRes.rows[0]?.count ?? "0");

    // Sample rows
    const sampleParams = [...params, limit];
    const sampleRes = await client.query<TxSummaryRow>(sampleSql, sampleParams);

    console.log(
      JSON.stringify(
        {
          source: "debug-plt-candidates",
          step: "snapshot",
          totalMatches,
          returned: sampleRes.rows.length,
          terms,
          limit,
          sample: sampleRes.rows,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error("[debug-plt-candidates] failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[debug-plt-candidates] crashed:", err);
    process.exitCode = 1;
  });
}
