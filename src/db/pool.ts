// src/db/pool.ts
import 'dotenv/config';
import { Pool } from 'pg';

/**
 * Postgres connection string, e.g.:
 *   postgres://USER:PASS@HOST:PORT/DBNAME
 * For local dev we default to a simple local instance.
 */
const DEFAULT_URL = 'postgres://postgres:pg@127.0.0.1:5432/postgres';

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
  process.env.PGSSLMODE === 'require' ||
  process.env.DATABASE_SSL === 'true' ||
  false;

// Create the pool
export const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  // tune if needed:
  // max: 10,
  // idleTimeoutMillis: 30_000,
  // connectionTimeoutMillis: 5_000,
});

// One-line log of what we’re using (helps debug multi-DB confusion)
console.log('[DB] Using', connectionString || {
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  db:   process.env.PGDATABASE,
  user: process.env.PGUSER,
});

// Tiny connectivity probe (fail fast if wrong DB/creds)
pool
  .query('SELECT current_database() AS db, inet_server_addr() AS addr, inet_server_port() AS port;')
  .then(r => {
    const row = r.rows[0];
    console.log('[DB] Connected to', row.db, String(row.addr), String(row.port));
  })
  .catch(err => {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  });

/** Simple health probe you can call on startup */
export async function health(): Promise<void> {
  await pool.query('SELECT 1');
}

/** Graceful shutdown helper */
export async function close(): Promise<void> {
  await pool.end();
}

