// src/plt/pltSearch.ts
//
// M3.4 – PLT events search helper (data-plane skeleton)
//
// This module focuses on *reading* from crp_plt_events in a safe,
// composable way. It does not mutate the DB.
//
// It exposes:
//   - PltEvent:     normalized event shape for HTTP responses / tools
//   - PltEventSearchFilter: simple filter abstraction
//   - buildPltEventsQuery(): query builder returning SQL + params
//   - searchPltEventsWithNewClient(): convenience helper for tools / smoke
//
// Later, the HTTP route can either:
//   - reuse buildPltEventsQuery() with the shared server pool, or
//   - call searchPltEventsWithNewClient() directly for a quick POC.

import { Client } from "pg";

/**
 * Normalized PLT event as returned by queries.
 *
 * Note: numeric DB types (NUMERIC, BIGINT) are surfaced as strings to
 * avoid precision loss in JS. Callers can BigInt/Decimal-ify if needed.
 */
export interface PltEvent {
  id: string;
  createdAt: string;
  updatedAt: string;

  blockHash: string;
  blockHeight: string;
  transactionHash: string;
  eventIndex: number;

  eventType: string; // e.g. 'transfer', 'mint', 'burn'
  fromAddress: string | null;
  toAddress: string | null;

  amountRaw: string; // NUMERIC(38,0) as string
  assetId: string;

  networkGenesisIndex: number;
  finalized: boolean;
}

/**
 * Filters for PLT event search.
 *
 * All fields are optional; they combine with AND semantics.
 */
export interface PltEventSearchFilter {
  fromAddress?: string;
  toAddress?: string;
  assetId?: string;
  networkGenesisIndex?: number;
  finalized?: boolean;

  minAmountRaw?: string;
  maxAmountRaw?: string;

  // Generic pagination guard. Default is 50, hard cap at 500.
  limit?: number;
}

/**
 * Resolve the Postgres connection string used for PLT queries.
 *
 * Follows the same precedence as other PLT tools:
 *   1) CRP_DB_CONN_STRING
 *   2) DATABASE_URL
 *   3) local xcf-pg fallback (transaction-outcome)
 */
function getConnectionString(): string {
  const conn =
    process.env.CRP_DB_CONN_STRING ??
    process.env.DATABASE_URL ??
    "postgres://postgres:pg@127.0.0.1:5432/transaction-outcome";

  return conn;
}

/**
 * Internal: build WHERE clause + parameter list from the provided filter.
 *
 * Returns:
 *   - whereSql: string starting with "WHERE 1=1 ..."
 *   - params:   positional parameter values for $1, $2, ...
 */
function buildWhereClause(
  filter: PltEventSearchFilter
): { whereSql: string; params: unknown[] } {
  const clauses: string[] = ["1 = 1"];
  const params: unknown[] = [];

  const push = (sqlFragment: string, value: unknown) => {
    params.push(value);
    clauses.push(`${sqlFragment} $${params.length}`);
  };

  if (filter.fromAddress) {
    push("from_address =", filter.fromAddress);
  }

  if (filter.toAddress) {
    push("to_address =", filter.toAddress);
  }

  if (filter.assetId) {
    push("asset_id =", filter.assetId);
  }

  if (typeof filter.networkGenesisIndex === "number") {
    push("network_genesis_index =", filter.networkGenesisIndex);
  }

  if (typeof filter.finalized === "boolean") {
    push("finalized =", filter.finalized);
  }

  if (filter.minAmountRaw) {
    // amount_raw is NUMERIC; compare as numeric
    push("amount_raw >= ", filter.minAmountRaw);
  }

  if (filter.maxAmountRaw) {
    push("amount_raw <= ", filter.maxAmountRaw);
  }

  return {
    whereSql: "WHERE " + clauses.join(" AND "),
    params,
  };
}

/**
 * Build the PLT events query (SQL string + params) for the given filter.
 *
 * This is handy if you want to plug into an existing pg Pool/Client.
 */
export function buildPltEventsQuery(
  filter: PltEventSearchFilter = {}
): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildWhereClause(filter);

  const limit =
    filter.limit && Number.isFinite(filter.limit)
      ? Math.min(Math.max(filter.limit, 1), 500)
      : 50;

  const sql = `
    SELECT
      id,
      created_at,
      updated_at,
      block_hash,
      block_height,
      transaction_hash,
      event_index,
      event_type,
      from_address,
      to_address,
      amount_raw,
      asset_id,
      network_genesis_index,
      finalized
    FROM crp_plt_events
    ${whereSql}
    ORDER BY block_height DESC, event_index ASC
    LIMIT ${limit};
  `;

  return { sql, params };
}

/**
 * Map a raw row from pg into a normalized PltEvent struct.
 *
 * This assumes the SELECT list in buildPltEventsQuery().
 */
function mapRowToPltEvent(row: any): PltEvent {
  return {
    id: String(row.id),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),

    blockHash: String(row.block_hash),
    blockHeight: String(row.block_height),
    transactionHash: String(row.transaction_hash),
    eventIndex: Number(row.event_index),

    eventType: String(row.event_type),
    fromAddress: row.from_address === null ? null : String(row.from_address),
    toAddress: row.to_address === null ? null : String(row.to_address),

    amountRaw: String(row.amount_raw),
    assetId: String(row.asset_id),

    networkGenesisIndex: Number(row.network_genesis_index),
    finalized: Boolean(row.finalized),
  };
}

/**
 * Convenience helper: open a fresh pg Client, run the PLT events query,
 * then close the client.
 *
 * This is ideal for:
 *   - one-off tools / scripts,
 *   - smoke tests,
 *   - quick REPL experiments.
 *
 * For HTTP handlers on the hot path, prefer using buildPltEventsQuery()
 * with the shared server pool to avoid per-request client churn.
 */
export async function searchPltEventsWithNewClient(
  filter: PltEventSearchFilter = {}
): Promise<PltEvent[]> {
  const connectionString = getConnectionString();
  const client = new Client({ connectionString });

  await client.connect();

  try {
    const { sql, params } = buildPltEventsQuery(filter);

    const res = await client.query(sql, params);

    return res.rows.map(mapRowToPltEvent);
  } finally {
    await client.end();
  }
}
