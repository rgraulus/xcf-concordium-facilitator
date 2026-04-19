// src/store/match.pg.ts
//
// Search helpers for matching payments/challenges.
// This does NOT depend on PLT transfers yet; it searches the `challenges` table
// using the core tuple (network + tokenId + pay_to + status, etc.).
//
// Later we can extend this to join/link against `plt_transfers` once the
// PLT parser is fully wired up.

import { pool } from "../db/pool";
import { networkCandidates } from "../lib/networkId";
import type { Asset, Status, Challenge } from "./repo.pg";

/**
 * Filters for payment/challenge search.
 *
 * All fields are optional; the search will AND them together.
 * `limit` defaults to 25, capped at 100.
 */
export type PaymentSearchFilters = {
  merchantId?: string;
  network?: string;
  networkCandidates?: string[];
  tokenId?: string; // asset.tokenId (from JSONB column `asset`)
  payTo?: string;
  status?: Status;
  limit?: number;
};

/**
 * Map a raw PG row (from `challenges`) into a Challenge DTO.
 * This mirrors the mapping in repo.pg.ts.
 */
function rowToChallenge(row: any): Challenge {
  return {
    merchant_id: row.merchant_id,
    nonce: row.nonce,
    network: row.network,
    asset: row.asset as Asset,
    amount: row.amount,
    pay_to: row.pay_to,
    expiry: new Date(row.expiry).toISOString(),
    policy: row.policy ?? {},
    metadata: row.metadata ?? {},
    status: row.status as Status,
    receipt: row.receipt ?? null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Search challenges/payments using flexible filters.
 *
 * Typical usage for matching:
 *  - merchantId: required by caller (tenant scoping)
 *  - network: "concordium:testnet" or similar
 *  - tokenId: PLT token id, e.g. "usd:test"
 *  - payTo: recipient address
 *
 * For now this only returns matching Challenges. In a later
 * step we can enrich this with linked PLT transfer info if needed.
 */
export async function searchPayments(
  filters: PaymentSearchFilters
): Promise<Challenge[]> {
  const {
    merchantId,
    network,
    networkCandidates: explicitNetworkCandidates,
    tokenId,
    payTo,
    status,
    limit,
  } = filters;

  const effectiveNetworkCandidates =
    explicitNetworkCandidates && explicitNetworkCandidates.length > 0
      ? explicitNetworkCandidates
      : network
        ? networkCandidates(network)
        : [];

  const params: any[] = [];
  let where = "WHERE 1=1";

  if (merchantId) {
    params.push(merchantId);
    where += ` AND merchant_id = $${params.length}`;
  }

  if (effectiveNetworkCandidates.length === 1) {
    params.push(effectiveNetworkCandidates[0]);
    where += ` AND network = $${params.length}`;
  } else if (effectiveNetworkCandidates.length > 1) {
    params.push(effectiveNetworkCandidates);
    where += ` AND network = ANY($${params.length})`;
  }

  if (tokenId) {
    // asset is JSONB, with shape { type: "PLT", tokenId, decimals }
    params.push(tokenId);
    where += ` AND asset->>'tokenId' = $${params.length}`;
  }

  if (payTo) {
    params.push(payTo);
    where += ` AND pay_to = $${params.length}`;
  }

  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }

  const effectiveLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.floor(limit)))
      : 25;

  params.push(effectiveLimit);
  const limitParamIndex = params.length;

  const sql = `
    SELECT *
    FROM challenges
    ${where}
    ORDER BY created_at DESC
    LIMIT $${limitParamIndex}
  `;

  const res = await pool.query(sql, params);
  return res.rows.map(rowToChallenge);
}
