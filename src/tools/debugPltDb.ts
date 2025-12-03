// src/tools/debugPltDb.ts
//
// Small debug helper to inspect what (if anything) is currently
// stored in the crp_plt_events table.
//
// Usage:
//
//   # from repo root
//   export DATABASE_URL=postgres://postgres:pg@127.0.0.1:5432/postgres   # if not already set
//   npx ts-node --transpile-only src/tools/debugPltDb.ts
//
// Or, after we wire an npm script:
//   npm run debug:plt:db
//
// This will print the last 20 PLT events seen by the facilitator
// (according to the DB), ordered by occurred_at DESC.

import "dotenv/config";
import { Client } from "pg";

async function main() {
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:pg@127.0.0.1:5432/postgres";

  // eslint-disable-next-line no-console
  console.log("[PLT-DB-DEBUG] Using DATABASE_URL:", connectionString);

  const client = new Client({ connectionString });

  try {
    await client.connect();
    // eslint-disable-next-line no-console
    console.log("[PLT-DB-DEBUG] Connected to Postgres");

    const sql = `
      SELECT
        id,
        network,
        token_id,
        tx_hash,
        block_hash,
        block_height,
        from_addr,
        to_addr,
        amount_minor,
        decimals,
        occurred_at,
        created_at
      FROM crp_plt_events
      ORDER BY occurred_at DESC
      LIMIT 20;
    `;

    const res = await client.query(sql);

    if (res.rows.length === 0) {
      // eslint-disable-next-line no-console
      console.log("[PLT-DB-DEBUG] No rows in crp_plt_events yet.");
      return;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[PLT-DB-DEBUG] Found ${res.rows.length} row(s) in crp_plt_events (latest first):`
    );
    for (const row of res.rows) {
      // eslint-disable-next-line no-console
      console.log("----");
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(row, null, 2));
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[PLT-DB-DEBUG] Error while querying crp_plt_events:", err);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[PLT-DB-DEBUG] Fatal error:", err);
  process.exit(1);
});
