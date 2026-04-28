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

// === Receipt payload (SHAPED FOR GATEWAY proofPayload.ts) ===

export interface CrpContractRef {
  contractId: string;
  contractVersion: string;
  isFrozen: boolean;

  merchantId: string;
  resource: {
    method: string;
    path: string;
  };

  // Canonical-first chain identity for proof payloads
  chain_id?: string; // e.g. ccd:4221332d34e1694168c2a0c0b3fd0f27

  // Legacy compatibility field retained during migration
  network: string; // e.g. concordium:testnet

  asset: CrpAsset;
  amount: string;
  payTo: string;

  // allow forward-compat extras
  [k: string]: unknown;
}

export interface CrpReceiptPayloadV1 {
  proofVersion: "ccd-plt-proof@v1";
  contract: CrpContractRef;
  nonce: string;

  settlement: {
    status: "finalized";
    settledAt: number; // unix seconds
    expiresAt?: number; // unix seconds
  };

  chain: {
    transactionHash: string;
    blockHash?: string;
    blockHeight?: number;
  };

  paymentEvent: {
    kind: "plt.transfer";
    tokenId: string;
    amountRaw: string; // integer string
    from?: string;
    to: string;
  };

  compliance?: Record<string, unknown>;

  // Facilitator extras (gateway ignores unknown keys)
  facilitator_sig?: string;
  facilitator_key_id?: string;

  [k: string]: unknown;
}

// What we store/return on the payment record.
export interface CrpReceipt {
  jws: string;                  // compact JWS (header.payload.signature)
  payload: CrpReceiptPayloadV1; // canonical payload
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
