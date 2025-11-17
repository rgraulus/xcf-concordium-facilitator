# CRP Gateway HTTP Client (for PayFi)

This document describes a thin TypeScript client that the PayFi / x402 gateway
backend can use to talk to the Concordium Rail Plugin (CRP) service.

The goal is to provide:

- A **single canonical tuple shape** shared between Gateway → CRP.
- A minimal **HTTP wrapper** (`CrpClient`) that:
  - performs **exact-tuple match** via `/v1/crp/payments/match`, and
  - triggers **fulfillment + webhook** via `/v1/crp/payments/fulfill`.
- A **copy-paste ready example** that PayFi can adapt into its own codebase.

> This file lives in the CRP repo as *reference documentation*.
> The actual production client should be implemented in the PayFi/x402 backend repo.

---

## 1. Tuple: Gateway → CRP payment shape

The core “receipt tuple” that Gateway sends to CRP is:

```ts
export interface CrpAsset {
  type: string;      // e.g. "PLT"
  tokenId: string;   // e.g. "usd:test"
  decimals: number;  // e.g. 2
}

export interface CrpPaymentTuple {
  merchantId: string;   // Gateway / merchant id (e.g. "demo-merchant")
  nonce: string;        // Gateway-generated nonce (idempotency key)
  network: string;      // e.g. "concordium:testnet"
  asset: CrpAsset;      // PLT asset descriptor
  amount: string;       // Decimal string, e.g. "25.00"
  payTo: string;        // Concordium address that received the PLT
}
```

### 1.1 JSON example

```json
{
  "merchantId": "demo-merchant",
  "nonce": "n-1763272560",
  "network": "concordium:testnet",
  "asset": {
    "type": "PLT",
    "tokenId": "usd:test",
    "decimals": 2
  },
  "amount": "25.00",
  "payTo": "ccd1qexampleaddress"
}
```

### 1.2 Required fields

All of the fields above are **required** for `/v1/crp/payments/match` and
`/v1/crp/payments/fulfill`. The CRP side performs:

- a **DB lookup** using a filtered search, and then  
- an **in-memory exact comparison** on:
  - `nonce`
  - `amount`
  - `asset.type`
  - `asset.tokenId`
  - `asset.decimals`
  - `payTo`

If any one of those differs, CRP returns `ok: false, reason: "no_match"`.

---

## 2. CRP HTTP endpoints

The main contract used by PayFi is:

- `POST /v1/crp/payments/match`  
  **Exact-tuple, read-only**. Returns a payment row if the tuple matches.

- `POST /v1/crp/payments/fulfill`  
  Same match logic, but also triggers a **webhook POST** (if configured) and
  returns webhook status inside `webhook`.

### 2.1 Request: `/v1/crp/payments/match`

**Method**

```http
POST /v1/crp/payments/match
Content-Type: application/json
```

**Body (tuple)**

```json
{
  "merchantId": "demo-merchant",
  "nonce": "n-1763272560",
  "network": "concordium:testnet",
  "asset": {
    "type": "PLT",
    "tokenId": "usd:test",
    "decimals": 2
  },
  "amount": "25.00",
  "payTo": "ccd1qexampleaddress"
}
```

**Success response (shape)**

```json
{
  "ok": true,
  "reason": "exact_match",
  "count": 1,
  "match": {
    "merchant_id": "demo-merchant",
    "nonce": "n-1763272560",
    "network": "concordium:testnet",
    "asset": {
      "type": "PLT",
      "tokenId": "usd:test",
      "decimals": 2
    },
    "amount": "25.00",
    "pay_to": "ccd1qexampleaddress",
    "status": "fulfilled",
    "receipt": {
      "jws": "<jwt-here>",
      "payload": {
        "asset": {
          "type": "PLT",
          "tokenId": "usd:test",
          "decimals": 2
        },
        "nonce": "n-1763272560",
        "amount": "25.00",
        "paidTo": "ccd1qexampleaddress",
        "network": "concordium:testnet",
        "finalizedAt": "2025-11-16T05:56:02Z"
      }
    },
    "created_at": "2025-11-16T05:56:01.244Z",
    "updated_at": "2025-11-16T05:56:02.261Z"
  }
}
```

If there is **no match**, CRP returns:

```json
{
  "ok": false,
  "reason": "no_match",
  "count": 0
}
```

### 2.2 Request: `/v1/crp/payments/fulfill`

**Method**

```http
POST /v1/crp/payments/fulfill
Content-Type: application/json
```

**Body**

Same tuple as `/v1/crp/payments/match`.

**Success response (shape)**

```json
{
  "ok": true,
  "reason": "exact_match",
  "count": 1,
  "match": { /* same as /match */ },
  "webhook": {
    "configured": true,
    "attempted": true,
    "ok": true,
    "status": 200
  }
}
```

If no match:

```json
{
  "ok": false,
  "reason": "no_match",
  "count": 0,
  "webhook": {
    "configured": false,
    "attempted": false,
    "ok": false
  }
}
```

---

## 3. Reference: `CrpClient` (TypeScript)

The following is a **reference implementation** of a thin HTTP client for CRP.
PayFi can copy this into its own repo (e.g. `src/crpClient.ts`) and adapt the
HTTP layer (native `fetch`, `axios`, `node-fetch`, etc).

### 3.1 Types

```ts
export interface CrpClientOptions {
  /** Base URL of the CRP service, e.g. "http://localhost:8080" */
  baseUrl: string;

  /** Default merchantId to use for requests (e.g. "demo-merchant"). */
  merchantId: string;

  /** Optional request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface CrpAsset {
  type: string;
  tokenId: string;
  decimals: number;
}

export interface CrpPaymentTuple {
  merchantId: string;
  nonce: string;
  network: string;
  asset: CrpAsset;
  amount: string;
  payTo: string;
}

export interface CrpMatchResponse {
  ok: boolean;
  reason?: string;
  count?: number;
  match?: any; // DB row shape; gateway usually only needs receipt + status
}

export interface CrpFulfillResponse extends CrpMatchResponse {
  webhook?: {
    configured: boolean;
    attempted: boolean;
    ok: boolean;
    status?: number;
    error?: string;
  };
}
```

### 3.2 Minimal `CrpClient` using `fetch`

This version uses the global `fetch` API. In Node.js:

- If you’re on **Node 18+**, `fetch` is built-in.
- Otherwise, add a polyfill (`node-fetch`, `undici`, etc.) and wire it up.

```ts
export class CrpClient {
  private readonly baseUrl: string;
  private readonly merchantId: string;
  private readonly timeoutMs: number;

  constructor(opts: CrpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.merchantId = opts.merchantId;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  /**
   * Build the payment tuple that will be sent to CRP.
   */
  buildTuple(input: Omit<CrpPaymentTuple, "merchantId">): CrpPaymentTuple {
    return {
      merchantId: this.merchantId,
      ...input,
    };
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try:
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: any;
      try:
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `CRP: failed to parse JSON from ${path} (status ${res.status})`
        );
      }

      if (!res.ok) {
        // Non-2xx; surface response as error
        const msg = parsed?.error || res.statusText || "CRP error";
        const err = new Error(`CRP: ${msg}`);
        (err as any).status = res.status;
        (err as any).body = parsed;
        throw err;
      }

      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Exact-tuple, read-only match.
   * Calls POST /v1/crp/payments/match.
   */
  async matchPayment(tuple: CrpPaymentTuple): Promise<CrpMatchResponse> {
    return this.postJson<CrpMatchResponse>(
      "/v1/crp/payments/match",
      tuple
    );
  }

  /**
   * Exact-tuple fulfillment.
   * Calls POST /v1/crp/payments/fulfill` and returns both match + webhook result.
   */
  async fulfillPayment(tuple: CrpPaymentTuple): Promise<CrpFulfillResponse> {
    return this.postJson<CrpFulfillResponse>(
      "/v1/crp/payments/fulfill",
      tuple
    );
  }
}
```

---

## 4. Integrating into the PayFi / x402 gateway

A typical usage inside the PayFi/x402 backend could look like this
(pseudocode-level, not a full implementation):

```ts
// src/crpClient.ts (inside PayFi repo)
import {
  CrpClient,
  CrpPaymentTuple,
  CrpMatchResponse,
  CrpFulfillResponse,
} from "./crp-types"; // or inline the types above

const CRP_BASE_URL =
  process.env.CRP_BASE_URL ?? "http://localhost:8080";
const CRP_MERCHANT_ID =
  process.env.CRP_MERCHANT_ID ?? "demo-merchant";

export const crpClient = new CrpClient({
  baseUrl: CRP_BASE_URL,
  merchantId: CRP_MERCHANT_ID,
  timeoutMs: 3000,
});
```

Then, in the gateway’s payment handling logic:

```ts
import { crpClient } from "./crpClient";

async function handlePaymentFinalized(event: X402PaymentEvent) {
  // 1) Derive the CRP tuple from gateway / PLT data
  const tuple = crpClient.buildTuple({
    nonce: event.nonce,
    network: "concordium:testnet",
    asset: {
      type: "PLT",
      tokenId: event.tokenId,
      decimals: event.decimals,
    },
    amount: event.amount, // "25.00"
    payTo: event.payTo,   // "ccd1qexampleaddress"
  });

  // 2) Ask CRP to match and fulfill (webhook)
  const res = await crpClient.fulfillPayment(tuple);

  if (!res.ok || res.reason !== "exact_match") {
    // no match: treat as an internal error for now,
    // or bubble back a 4xx/5xx to the caller
    throw new Error(
      `CRP fulfill failed: reason=${res.reason ?? "unknown"}`
    );
  }

  // Optional: inspect the webhook status
  if (!res.webhook?.ok) {
    console.warn("CRP webhook not ok", res.webhook);
    // decide if this is soft-fail (log) or hard-fail
  }

  // 3) Use the CRP receipt if needed
  const receipt = res.match?.receipt;
  // attach receipt to internal order record, etc.
}
```

---

## 5. Environment variables (PayFi side)

Suggested environment variables for the PayFi / x402 backend:

- `CRP_BASE_URL`  
  Base URL of the CRP facilitator service  
  Example: `http://localhost:8080` (local dev)

- `CRP_MERCHANT_ID`  
  Merchant id string that CRP expects (e.g. `"demo-merchant"`).
  This must match what is stored in the CRP `challenges` table.

In production, these should be configured via your deployment system
(Kubernetes secrets, Docker env, etc.).

---

## 6. Summary

- CRP exposes two main endpoints for Gateway:
  - `POST /v1/crp/payments/match` (read-only, exact-tuple match)
  - `POST /v1/crp/payments/fulfill` (exact-tuple match + webhook)
- The **payment tuple** (`CrpPaymentTuple`) is the canonical shape shared
  between Gateway and CRP.
- The **`CrpClient`** wrapper provides a small, testable surface for PayFi to
  integrate with CRP using standard HTTP/JSON.
- Once wired, PayFi’s backend can:
  - treat CRP as the **source of truth** for PLT payment receipts, and
  - leverage CRP’s webhook mechanism for merchant-specific integrations.
