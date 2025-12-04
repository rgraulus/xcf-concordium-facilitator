// src/tools/debugPltDb.ts
//
// Stronger debug tool for crp_plt_events and crp_finalized_blocks.
//
// Usage:
//   DATABASE_URL=postgres://... npm run debug:plt:db
//
// It will:
//   - Check that crp_plt_events exists.
//   - Print total row count.
//   - Dump the latest rows.
//   - Optionally show crp_finalized_blocks row count.

import { Pool } from "pg";

async function main() {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://postgres:pg@127.0.0.1:5432/postgres";

  console.log("[PLT-DB-DEBUG] Using DATABASE_URL:", databaseUrl);

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    console.log("[PLT-DB-DEBUG] Connected to Postgres");

    // 1) Check that the table exists in the current database / schema.
    const tableCheck = await client.query(
      "SELECT to_regclass('public.crp_plt_events') AS table_name"
    );
    const tableName = tableCheck.rows[0]?.table_name as string | null;

    if (!tableName) {
      console.log(
        "[PLT-DB-DEBUG] Table crp_plt_events does NOT exist in this database/schema."
      );
      return;
    }

    console.log("[PLT-DB-DEBUG] Table found:", tableName);

    // 2) Total count.
    const countRes = await client.query(
      "SELECT COUNT(*) AS total FROM crp_plt_events"
    );
    const total = countRes.rows[0]?.total;
    console.log("[PLT-DB-DEBUG] Total rows in crp_plt_events:", total);

    // 3) Latest rows.
    const rowsRes = await client.query(
      `
      SELECT
        block_hash,
        network,
        token_id,
        from_addr,
        to_addr,
        amount_minor,
        decimals,
        occurred_at,
        tx_hash,
        event_index
      FROM crp_plt_events
      ORDER BY occurred_at DESC NULLS LAST,
               block_hash,
               tx_hash,
               event_index DESC
      LIMIT 10
      `
    );

    if (rowsRes.rows.length === 0) {
      console.log("[PLT-DB-DEBUG] No rows to display from crp_plt_events.");
    } else {
      console.log(
        "[PLT-DB-DEBUG] Latest rows from crp_plt_events:\n" +
          JSON.stringify(rowsRes.rows, null, 2)
      );
    }

    // 4) Optional: show finalized block count if the table exists.
    try {
      const blkRes = await client.query(
        "SELECT COUNT(*) AS total FROM crp_finalized_blocks"
      );
      console.log(
        "[PLT-DB-DEBUG] Total rows in crp_finalized_blocks:",
        blkRes.rows[0]?.total
      );
    } catch (err) {
      console.log(
        "[PLT-DB-DEBUG] crp_finalized_blocks not found or not readable:",
        (err as Error).message
      );
    }
  } catch (err) {
    console.error("[PLT-DB-DEBUG] Error while inspecting PLT DB:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[PLT-DB-DEBUG] Fatal error in debugPltDb:", err);
});
