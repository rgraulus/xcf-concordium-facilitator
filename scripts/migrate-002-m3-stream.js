// scripts/migrate-002-m3-stream.js
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// Use same DB as the app: either DATABASE_URL or the known local URL.
const connectionString =
  process.env.DATABASE_URL ||
  "postgres://postgres:pg@127.0.0.1:5432/postgres";

const sqlPath = path.join(__dirname, "..", "db", "migrations", "002_m3_stream.sql");
const sql = fs.readFileSync(sqlPath, "utf8");

const pool = new Pool({ connectionString });

async function main() {
  console.log("Running migration 002_m3_stream.sql against:", connectionString);
  try {
    await pool.query(sql);
    console.log("✅ Migration 002_m3_stream.sql completed successfully.");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
