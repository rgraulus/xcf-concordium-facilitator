// src/store/repo.pg.ts
import { pool } from "../db/pool";

export type Status = "pending" | "fulfilled" | "expired" | "invalid" | "policy_failed";

export interface Challenge {
  merchant_id: string;
  nonce: string;
  network: string;
  asset: any;
  amount: string;
  pay_to: string;
  expiry: string;     // ISO 8601 date-time
  policy?: any;
  metadata?: any;
  status?: Status;
  receipt?: any;
}

/**
 * Idempotent upsert on (merchant_id, nonce).
 * - First call inserts with status 'pending'.
 * - Subsequent calls with identical payload effectively no-op and return the row.
 * - If you want to enforce “conflicting payload → 409”, do that in the route
 *   by fetching existing + deep-comparing before calling this.
 */
export async function upsertChallenge(ch: Challenge) {
  const sql = `
    INSERT INTO challenges (merchant_id, nonce, network, asset, amount, pay_to, expiry, policy, metadata, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
    ON CONFLICT (merchant_id, nonce) DO UPDATE
      SET network  = EXCLUDED.network,
          asset    = EXCLUDED.asset,
          amount   = EXCLUDED.amount,
          pay_to   = EXCLUDED.pay_to,
          expiry   = EXCLUDED.expiry,
          policy   = EXCLUDED.policy,
          metadata = EXCLUDED.metadata
    RETURNING *`;
  const vals = [
    ch.merchant_id, ch.nonce, ch.network, ch.asset, ch.amount,
    ch.pay_to, ch.expiry, ch.policy ?? null, ch.metadata ?? null,
  ];
  const { rows } = await pool.query(sql, vals);
  return rows[0];
}

export async function getChallenge(merchant_id: string, nonce: string) {
  const { rows } = await pool.query(
    `SELECT * FROM challenges WHERE merchant_id=$1 AND nonce=$2`,
    [merchant_id, nonce]
  );
  return rows[0] ?? null;
}

export async function setStatus(merchant_id: string, nonce: string, status: Status) {
  const { rows } = await pool.query(
    `UPDATE challenges
       SET status=$3, updated_at=now()
     WHERE merchant_id=$1 AND nonce=$2
     RETURNING *`,
    [merchant_id, nonce, status]
  );
  return rows[0] ?? null;
}

export async function markFulfilled(merchant_id: string, nonce: string, jws: string) {
  const { rows } = await pool.query(
    `UPDATE challenges
        SET status='fulfilled',
            receipt=jsonb_build_object('jws',$3),
            updated_at=now()
      WHERE merchant_id=$1 AND nonce=$2
      RETURNING *`,
    [merchant_id, nonce, jws]
  );
  return rows[0] ?? null;
}
