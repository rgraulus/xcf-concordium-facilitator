// Canonical TypeScript types for the CRP ↔ Gateway HTTP contract.
// These are the shapes used on the wire by /v1/crp/payments* and the webhook.

export type CrpNetwork = "concordium:testnet"; // Extend when more networks are supported.

// Asset as used in requests and responses.
export interface CrpAsset {
  type: "PLT";       // PoC: only PLT (protocol-level token).
  tokenId: string;   // e.g. "usd:test".
  decimals: number;  // e.g. 2.
}

// === Requests ===

// Challenge creation request body: POST /v1/crp/payments
export interface CrpChallengeCreateRequest {
  merchantId: string;
  nonce: string;
  network: CrpNetwork;
  asset: CrpAsset;
  amount: string; // Decimal string, e.g. "25.00".
  payTo: string;  // Concordium address (testnet for now).
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

// === Receipt ===

export interface CrpReceiptPayload {
  nonce: string;
  amount: string;
  network: CrpNetwork;
  asset: CrpAsset;
  paidTo: string;
  finalizedAt: string; // ISO-8601.
}

export interface CrpReceipt {
  jws: string;                 // Compact JWS (header.payload.signature).
  payload: CrpReceiptPayload;  // Decoded payload for convenience.
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

// Internal representation of the webhook attempt result, surfaced in responses.
export interface CrpWebhookResult {
  configured: boolean;
  attempted: boolean;
  ok: boolean;
  status?: number;
  error?: string;
}

// Webhook payload from XCF (CRP) to Gateway.
export interface CrpWebhookPayload {
  kind: "crp.payment.fulfilled";
  payment: CrpPaymentRecord;
}
