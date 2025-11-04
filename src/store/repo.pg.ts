// src/store/repo.pg.ts
import { pool } from "../db/pool";

/** Types */
export type Status =
  | "pending"
  | "fulfilled"
  | "expired"
  | "invalid"
  | "policy_failed";

export type Asset = {
  type: string;      // e.g. "PLT"
  tokenId: string;   // e.g. "usd:test"
  decimals: number;  // e.g. 2
};

export type Challenge = {
  merchant_id: string;
  nonce: string;
  network: string;               // e.g. "concordium:testnet"
  asset: Asset;
  amount: string;                // major units string
  pay_to: string;                // recipient address
  expiry: string;                // ISO string
  policy: Record<string, any>;   // stored as JSONB
  metadata: Record<string, any>; // stored as JSONB
  status: Status;
  receipt: Record<string, any> | null;
  created_at: string;            // ISO serialized
  updated_at: string;            // ISO serialized
};

/** Helpers */
function toChallengeRow(row: any): Challenge {
  return {
    merchant_id: row.merchant_id,
    nonce: row.nonce,
    network: row.network,
    asset: row.asset,
    amount: row.amount,
    pay_to: row.pay_to,
    expiry: new Date(row.expiry).toISOString(),
    policy: row.policy ?? {},
    metadata: row.metadata ?? {},
    status: row.status,
    receipt: row.receipt ?? null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Idempotent upsert:
 *  - First insert -> { created: true,  samePayload: false, row }
 *  - Exists + identical payload -> { created: false, samePayload: true, row }
 *  - Exists + different payload -> { created: false, samePayload: false }
 */
export async function upsertChallenge(
  input: Omit<Challenge, "status" | "receipt" | "created_at" | "updated_at"> & { status?: Status }
): Promise<
  | { created: true;  samePayload: false; row: Challenge }
  | { created: false; samePayload: true;  row: Challenge }
  | { created: false; samePayload: false }
> {
  const {
    merchant_id,
    nonce,
    network,
    asset,
    amount,
    pay_to,
    expiry,
    policy = {},
    metadata = {},
    status = "pending",
  } = input;

  // Try insert first
  const ins = await pool.query(
    `
    INSERT INTO challenges (
      merchant_id, nonce, network, asset, amount, pay_to, expiry,
      policy, metadata, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (merchant_id, nonce) DO NOTHING
    RETURNING *
    `,
    [
      merchant_id,
      nonce,
      network,
      JSON.stringify(asset),
      amount,
      pay_to,
      new Date(expiry).toISOString(),
      JSON.stringify(policy ?? {}),
      JSON.stringify(metadata ?? {}),
      status,
    ]
  );

  if ((ins.rowCount ?? 0) > 0) {
    return { created: true, samePayload: false, row: toChallengeRow(ins.rows[0]) };
  }

  // Already exists: fetch and compare payloads
  const sel = await pool.query(
    `SELECT * FROM challenges WHERE merchant_id=$1 AND nonce=$2`,
    [merchant_id, nonce]
  );

  if ((sel.rowCount ?? 0) > 0) {
    const row = sel.rows[0];
    const same =
      row.network === network &&
      JSON.stringify(row.asset) === JSON.stringify(asset) &&
      row.amount === amount &&
      row.pay_to === pay_to &&
      new Date(row.expiry).toISOString() === new Date(expiry).toISOString() &&
      JSON.stringify(row.policy ?? {}) === JSON.stringify(policy ?? {}) &&
      JSON.stringify(row.metadata ?? {}) === JSON.stringify(metadata ?? {});
    if (same) {
      return { created: false, samePayload: true, row: toChallengeRow(row) };
    }
  }

  // Exists but differs → conflict
  return { created: false, samePayload: false };
}

/** Read current status + full challenge (or null if not found) */
export async function getStatus(
  merchantId: string,
  nonce: string
): Promise<Challenge | null> {
  const sel = await pool.query(
    `SELECT * FROM challenges WHERE merchant_id=$1 AND nonce=$2`,
    [merchantId, nonce]
  );
  return (sel.rowCount ?? 0) > 0 ? toChallengeRow(sel.rows[0]) : null;
}

/**
 * Mark as fulfilled + attach receipt (payload + jws)
 * Signature: (merchantId, nonce, receiptPayloadObject, jwsString)
 */
export async function markFulfilled(
  merchant_id: string,
  nonce: string,
  receipt: any,
  jws: string
): Promise<Challenge | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Important: cast $4 to text and $3 to jsonb to avoid 42P18 type ambiguity.
    const upd = await client.query(
      `
      UPDATE challenges
         SET status = 'fulfilled',
             receipt = jsonb_build_object(
               'jws', $4::text,
               'payload', $3::jsonb
             ),
             updated_at = now()
       WHERE merchant_id = $1 AND nonce = $2
       RETURNING *;
      `,
      // Be explicit: stringify receipt so $3 is text -> cast to jsonb above.
      [merchant_id, nonce, JSON.stringify(receipt), jws]
    );

    if ((upd.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    // Durable copy in receipts table (idempotent upsert)
    await client.query(
      `
      INSERT INTO receipts (merchant_id, nonce, jws)
      VALUES ($1, $2, $3)
      ON CONFLICT (merchant_id, nonce)
      DO UPDATE SET jws = EXCLUDED.jws;
      `,
      [merchant_id, nonce, jws]
    );

    await client.query("COMMIT");
    return toChallengeRow(upd.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
