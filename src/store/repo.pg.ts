// src/store/repo.pg.ts
import { pool } from "../db/pool";

/** ---------- Types ---------- */

export type Status = "pending" | "fulfilled" | "expired" | "invalid" | "policy_failed";

export interface Asset {
  type: "PLT";
  tokenId: string;
  decimals: number;
}

export interface Challenge {
  merchant_id: string;
  nonce: string;
  network: string; // e.g., "concordium:testnet"
  asset: Asset;    // stored as JSONB
  amount: string;  // major units as string, e.g. "25.00"
  pay_to: string;  // recipient address
  expiry: string;  // ISO string (TIMESTAMPTZ in DB)
  policy: Record<string, any> | null;
  metadata: Record<string, any> | null;
  status: Status;
  receipt: any | null;
  created_at: string;
  updated_at: string;
}

/** Ensures we store nulls (not {}) for policy/metadata to avoid idempotency mismatches */
function normalizeNullable<T extends Record<string, unknown> | null | undefined>(v: T) {
  return v == null ? null : (v as Record<string, unknown>);
}

/** The shape expected by upsert */
export type ChallengeInsert = Omit<
  Challenge,
  "status" | "receipt" | "created_at" | "updated_at"
> & { status?: Status };

/** ---------- Helpers ---------- */

/** Convert DB row → Challenge (ensures types/ISO strings) */
function mapRow(row: any): Challenge {
  return {
    merchant_id: row.merchant_id,
    nonce: row.nonce,
    network: row.network,
    asset: row.asset,
    amount: row.amount,
    pay_to: row.pay_to,
    expiry: new Date(row.expiry).toISOString(),
    policy: row.policy ?? null,
    metadata: row.metadata ?? null,
    status: row.status,
    receipt: row.receipt ?? null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** ---------- Reads ---------- */

export async function getChallenge(
  merchantId: string,
  nonce: string
): Promise<Challenge | null> {
  const q = `
    SELECT merchant_id, nonce, network, asset, amount, pay_to, expiry,
           policy, metadata, status, receipt, created_at, updated_at
    FROM challenges
    WHERE merchant_id = $1 AND nonce = $2
  `;
  const r = await pool.query(q, [merchantId, nonce]);
  if ((r.rowCount ?? 0) === 0) return null;
  return mapRow(r.rows[0]);
}

/** ---------- Writes ---------- */

/**
 * Idempotent create:
 * - INSERT … ON CONFLICT DO NOTHING
 * - If conflict, check if payload matches (using IS NOT DISTINCT FROM to be null-safe)
 * Returns:
 *   { created: true,  samePayload: true,  row }  // first insert
 *   { created: false, samePayload: true,  row }  // duplicate but identical payload
 *   { created: false, samePayload: false }       // duplicate with different payload (caller should 409)
 */
export async function upsertChallenge(
  payload: ChallengeInsert
): Promise<{ created: boolean; samePayload: boolean; row?: Challenge }> {
  const {
    merchant_id,
    nonce,
    network,
    asset,
    amount,
    pay_to,
    expiry,
    policy,
    metadata,
  } = payload;

  // normalize nullable fields so DB stores nulls consistently
  const normPolicy = normalizeNullable(policy);
  const normMetadata = normalizeNullable(metadata);
  const status: Status = payload.status ?? "pending";

  // 1) Try insert
  const ins = await pool.query(
    `
    INSERT INTO challenges
      (merchant_id, nonce, network, asset, amount, pay_to, expiry, policy, metadata, status)
    VALUES
      ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz, $8::jsonb, $9::jsonb, $10)
    ON CONFLICT (merchant_id, nonce) DO NOTHING
    RETURNING merchant_id, nonce, network, asset, amount, pay_to, expiry,
              policy, metadata, status, receipt, created_at, updated_at
  `,
    [
      merchant_id,
      nonce,
      network,
      JSON.stringify(asset),
      amount,
      pay_to,
      expiry,
      normPolicy === null ? null : JSON.stringify(normPolicy),
      normMetadata === null ? null : JSON.stringify(normMetadata),
      status,
    ]
  );

  if ((ins.rowCount ?? 0) === 1) {
    // Freshly created
    return { created: true, samePayload: true, row: mapRow(ins.rows[0]) };
  }

  // 2) Already exists — check whether payload is identical (null-safe)
  const sel = await pool.query(
    `
    SELECT merchant_id, nonce, network, asset, amount, pay_to, expiry,
           policy, metadata, status, receipt, created_at, updated_at
    FROM challenges
    WHERE merchant_id = $1 AND nonce = $2
  `,
    [merchant_id, nonce]
  );

  if ((sel.rowCount ?? 0) === 0) {
    // Extremely unlikely (deleted concurrently) — treat as conflict to be safe
    return { created: false, samePayload: false };
  }

  const row = sel.rows[0];

  // Payload equality check in SQL to be precise & null-safe
  const eq = await pool.query(
    `
    SELECT
      ($1 = $2)                                           AS same_network,
      ($3::jsonb = $4::jsonb)                             AS same_asset,
      ($5 = $6)                                           AS same_amount,
      ($7 = $8)                                           AS same_pay_to,
      ($9::timestamptz = $10::timestamptz)                AS same_expiry,
      ($11::jsonb IS NOT DISTINCT FROM $12::jsonb)        AS same_policy,
      ($13::jsonb IS NOT DISTINCT FROM $14::jsonb)        AS same_metadata
  `,
    [
      row.network, network,
      row.asset, JSON.stringify(asset),
      row.amount, amount,
      row.pay_to, pay_to,
      row.expiry, expiry,
      row.policy, normPolicy === null ? null : JSON.stringify(normPolicy),
      row.metadata, normMetadata === null ? null : JSON.stringify(normMetadata),
    ]
  );

  const flags = eq.rows[0] as Record<string, boolean>;
  const identical =
    flags.same_network &&
    flags.same_asset &&
    flags.same_amount &&
    flags.same_pay_to &&
    flags.same_expiry &&
    flags.same_policy &&
    flags.same_metadata;

  if (identical) {
    return { created: false, samePayload: true, row: mapRow(row) };
  }
  return { created: false, samePayload: false };
}

/**
 * Mark a challenge as fulfilled and persist a signed JWS receipt.
 * Atomic: updates challenges + receipts in a single transaction.
 */
export async function markFulfilled(
  merchantId: string,
  nonce: string,
  receipt: any,
  jws: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const upd = await client.query(
      `
      UPDATE challenges
      SET status = 'fulfilled',
          receipt = $3::jsonb,
          updated_at = now()
      WHERE merchant_id = $1 AND nonce = $2 AND status = 'pending'
    `,
      [merchantId, nonce, JSON.stringify(receipt)]
    );

    if ((upd.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return false;
    }

    const ins = await client.query(
      `
      INSERT INTO receipts (merchant_id, nonce, jws)
      VALUES ($1, $2, $3)
      ON CONFLICT (merchant_id, nonce) DO UPDATE SET
        jws = EXCLUDED.jws,
        created_at = receipts.created_at
    `,
      [merchantId, nonce, jws]
    );
    // (ins.rowCount ?? 0) should be 1 for insert; 0 for an update via ON CONFLICT — both are fine.

    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Mark a challenge expired (no-op if already terminal) */
export async function markExpired(merchantId: string, nonce: string): Promise<boolean> {
  const r = await pool.query(
    `
    UPDATE challenges
    SET status = 'expired', updated_at = now()
    WHERE merchant_id = $1 AND nonce = $2 AND status = 'pending'
  `,
    [merchantId, nonce]
  );
  return (r.rowCount ?? 0) === 1;
}

/** Mark a challenge invalid (schema/policy rejection) */
export async function markInvalid(merchantId: string, nonce: string): Promise<boolean> {
  const r = await pool.query(
    `
    UPDATE challenges
    SET status = 'invalid', updated_at = now()
    WHERE merchant_id = $1 AND nonce = $2 AND status = 'pending'
  `,
    [merchantId, nonce]
  );
  return (r.rowCount ?? 0) === 1;
}

/** Convenience status update (used by admin/simulator flows if needed) */
export async function setStatus(
  merchantId: string,
  nonce: string,
  status: Status
): Promise<boolean> {
  const r = await pool.query(
    `
    UPDATE challenges
    SET status = $3, updated_at = now()
    WHERE merchant_id = $1 AND nonce = $2
  `,
    [merchantId, nonce, status]
  );
  return (r.rowCount ?? 0) === 1;
}
