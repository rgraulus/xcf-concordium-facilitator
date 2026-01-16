// src/contracts/crpGateway.ts
// Canonical TypeScript types for the CRP ↔ Gateway HTTP contract.
// These are the shapes used on the wire by /v1/crp/payments* and the webhook.

export type CrpNetwork = "concordium:testnet"; // Extend when more networks are supported.

// Asset as used in requests and responses.
export interface CrpAsset {
  type: "PLT";       // PoC: only PLT (protocol-level token).
  tokenId: string;   // e.g. "EUDemo".
  decimals: number;  // e.g. 6.
}

// === Requests ===

// Challenge creation request body: POST /v1/crp/payments
export interface CrpChallengeCreateRequest {
  merchantId: string;
  nonce: string;
  network: CrpNetwork;
  asset: CrpAsset;
  amount: string; // Decimal string, e.g. "25.00".
  payTo: string;  // Concordium address.
  expiry?: string; // ISO-8601 or omitted.
  policy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Exact match request: POST /v1/crp/payments/match
export interface CrpMatchRequest {
  merchantId: string;
  nonce: string;
  network: CrpNetwork;
  asset: CrpAsset;
  amount: string;
  payTo: string;
}

// Fulfill request shares the same tuple as match.
export type CrpFulfillRequest = CrpMatchRequest;

// === Receipt (Canonical: aligns to schemas/receipt.schema.json) ===

export interface CrpReceiptPayloadV1 {
  v: "1";
  challenge_nonce: string;
  network: string; // schema: ^concordium:(testnet|mainnet)$
  asset: {
    type: "PLT";
    tokenId: string;
    decimals: number;
  };
  amount: string; // decimal string
  from: string;
  to: string;
  tx_hash: string;
  block_hash: string;
  finalized_at: string; // date-time
  compliance: Record<string, unknown>;
  facilitator_sig: string;     // we'll store the compact JWS here
  facilitator_key_id: string;  // kid
}

// What we store/return on the payment record.
export interface CrpReceipt {
  jws: string;                 // compact JWS (header.payload.signature)
  payload: CrpReceiptPayloadV1; // canonical payload (includes facilitator_sig + key id)
}

// === Payment record (as returned in responses & webhook) ===

export type CrpPaymentStatus = "pending" | "fulfilled";

// Note: field names use snake_case to match HTTP JSON and DB rows.
export interface CrpPaymentRecord {
  merchant_id: string;
  nonce: string;
  network: CrpNetwork;
  asset: CrpAsset;
  amount: string;
  pay_to: string;
  expiry?: string | null;
  policy: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: CrpPaymentStatus;
  receipt: CrpReceipt | null;
  created_at: string;
  updated_at: string;
}

// === Webhook support ===

export interface CrpWebhookResult {
  configured: boolean;
  attempted: boolean;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface CrpWebhookPayload {
  kind: "crp.payment.fulfilled";
  payment: CrpPaymentRecord;
}
