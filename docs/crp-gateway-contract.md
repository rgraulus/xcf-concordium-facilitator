# CRP ↔ Gateway API Contract

## 0. Scope

This document defines the HTTP contract between:

- Gateway – the x402/paywall layer that interacts with merchants and payers.
- XCF service – the x402 Concordium Facilitator, which in this PoC is deployed as a single Node/TypeScript service exposing the `/v1/crp/*` HTTP surface and internally embodying:
  - UFX – Universal Facilitator for x402 (idempotency, expiry, receipt signing, webhooks).
  - CRP – Concordium Rail Plugin (Concordium-specific PLT matching logic).

The contract covers:

- Challenge creation: POST /v1/crp/payments
- Exact tuple match: POST /v1/crp/payments/match
- Fulfill + webhook: POST /v1/crp/payments/fulfill
- Webhook payload: XCF → Gateway

This is a **logical contract**; TypeScript types in src/contracts/crpGateway.ts mirror these shapes.

---

## 1. Challenge Creation – POST /v1/crp/payments

### 1.1 HTTP Interface

- Method: POST
- Path: /v1/crp/payments
- Content-Type: application/json

### 1.2 Request Fields

The Gateway sends a payment challenge identified by (merchantId, nonce).

Required fields:

- merchantId (string) – logical merchant identifier (e.g. "demo-merchant").
- nonce (string) – unique per challenge for a given merchant.
- network (string) – for this PoC: "concordium:testnet".
- asset (object):
  - type (string) – "PLT".
  - tokenId (string) – e.g. "usd:test".
  - decimals (number) – e.g. 2.
- amount (string) – decimal string, e.g. "25.00"; treated as an exact string.
- payTo (string) – Concordium address (testnet).

Optional fields:

- expiry (string, ISO 8601) – challenge expiration.
- policy (object) – arbitrary policy configuration, persisted but not interpreted yet.
- metadata (object) – free-form metadata for correlation / UX.

### 1.3 Response Semantics

The endpoint is idempotent on (merchantId, nonce) and enforces a single tuple per (merchantId, nonce).

- 201 Created:
  - First time a (merchantId, nonce) is seen.
  - Response body includes:
    - ok: true
    - status: "created"
    - payment: a payment record (see CrpPaymentRecord in TS types).

- 200 Idempotent replay:
  - (merchantId, nonce) already exists and the incoming tuple is exactly identical.
  - Response body includes:
    - ok: true
    - status: "idem"
    - payment: existing payment record.

- 409 Conflict:
  - (merchantId, nonce) already exists but tuple differs in any of:
    - network, asset.type, asset.tokenId, asset.decimals, amount, payTo.
  - Response body includes:
    - ok: false
    - status: "conflict"
    - error: "nonce_conflict"
    - message: human-readable description.

- 4xx Bad request:
  - Missing or invalid fields.
  - Response body includes:
    - ok: false
    - status: "bad_request"
    - error: "validation_error"
    - details: per-field issues.

The Gateway must treat 409 and 4xx as errors on its side (bug/misuse), not user-visible “payment failed due to blockchain”.

---

## 2. Exact Match – POST /v1/crp/payments/match

### 2.1 HTTP Interface

- Method: POST
- Path: /v1/crp/payments/match
- Content-Type: application/json

### 2.2 Request Fields

Same tuple shape as challenge creation, but without expiry/policy/metadata:

- merchantId
- nonce
- network
- asset (type, tokenId, decimals)
- amount
- payTo

### 2.3 Response Semantics

CRP performs a strict comparison over the tuple:

- merchant_id, nonce, network
- asset.type, asset.tokenId, asset.decimals
- amount, pay_to

Responses:

- Exact match:
  - ok: true
  - reason: "exact_match"
  - count: 1
  - match: a CrpPaymentRecord, typically with status "fulfilled" and a receipt.

- No match:
  - ok: false
  - reason: "no_match"
  - count: 0

- Bad request:
  - ok: false
  - reason: "bad_request"
  - error: "validation_error"
  - details: per-field issues.

The Gateway may use the returned receipt for verification, but typically relies on its own state plus webhook notifications.

---

## 3. Fulfill + Webhook – POST /v1/crp/payments/fulfill

### 3.1 HTTP Interface

- Method: POST
- Path: /v1/crp/payments/fulfill
- Content-Type: application/json

### 3.2 Request Fields

Same tuple as /match:

- merchantId
- nonce
- network
- asset (type, tokenId, decimals)
- amount
- payTo

Conceptually invoked when on-chain observation concludes that the challenge has been fulfilled.

### 3.3 Response Semantics

Responses:

- Exact match + webhook:
  - ok: true
  - reason: "exact_match"
  - count: 1
  - match: CrpPaymentRecord
  - webhook: CrpWebhookResult, with fields:
    - configured: boolean
    - attempted: boolean
    - ok: boolean
    - status: optional HTTP status code
    - error: optional error message

- No match:
  - ok: false
  - reason: "no_match"
  - count: 0
  - webhook: configured/attempted/ok all false.

- Bad request:
  - ok: false
  - reason: "bad_request"
  - error: "validation_error"
  - details: per-field issues.

---

## 4. Webhook Contract – XCF → Gateway

### 4.1 URL Configuration

For each merchant, XCF resolves a webhook URL via environment variables:

- CRP_WEBHOOK_URL_<NORMALIZED_MERCHANT_ID>

Normalization:

- Uppercase
- Dashes converted to underscores

Example:

- merchantId "demo-merchant" → CRP_WEBHOOK_URL_DEMO_MERCHANT

If a URL is configured, XCF sends a POST with the webhook payload below.

### 4.2 Webhook Payload

Fields:

- kind: "crp.payment.fulfilled"
- payment: CrpPaymentRecord

Gateway correlation keys:

- Required: payment.merchant_id and payment.nonce
- Recommended: also check payment.network, payment.asset.tokenId, payment.amount.

Typical Gateway flow:

1. Verify webhook authentication/signature (see separate Auth & Security doc).
2. Look up local challenge by (merchantId, nonce).
3. Confirm tuple (network, asset, amount, payTo) matches.
4. Mark challenge fulfilled and store receipt.jws.

---

## 5. Relationship to TypeScript Types

The TypeScript file src/contracts/crpGateway.ts defines:

- CrpNetwork, CrpAsset
- CrpChallengeCreateRequest
- CrpMatchRequest
- CrpFulfillRequest
- CrpReceiptPayload, CrpReceipt
- CrpPaymentStatus, CrpPaymentRecord
- CrpWebhookResult, CrpWebhookPayload

These types are the **single source of truth** for the wire formats described above.
