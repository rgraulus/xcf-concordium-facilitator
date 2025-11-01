// src/db/pool.ts
import { Pool } from "pg";

/**
 * Postgres connection string, e.g.:
 *   postgres://USER:PASS@HOST:PORT/DBNAME
 * For local dev we default to a simple local instance.
 */
const DEFAULT_URL = "postgres://postgres:pg@127.0.0.1:5432/postgres";

const connectionString =
  process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0
    ? process.env.DATABASE_URL
    : DEFAULT_URL;

/**
 * If your DATABASE_URL comes from a managed provider that requires TLS,
 * set PGSSLMODE=require (or DATABASE_SSL=true) in the environment and
 * we’ll enable SSL automatically.
 */
const useSSL =
  process.env.PGSSLMODE === "require" ||
  process.env.DATABASE_SSL === "true" ||
  false;

export const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  // tune if needed:
  // max: 10,
  // idleTimeoutMillis: 30_000,
  // connectionTimeoutMillis: 5_000,
});

/** Simple health probe you can call on startup */
export async function health(): Promise<void> {
  await pool.query("SELECT 1");
}

/** Graceful shutdown helper */
export async function close(): Promise<void> {
  await pool.end();
}
