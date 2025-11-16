# CRP ↔ Gateway HTTP Contract

This document defines the HTTP contract between:

- **Gateway** – the x402 / paywall layer that issues payment challenges and handles client flows.
- **CRP** – *Concordium Rail Plugin* (a Concordium read/payments facilitator service).

The goal is to provide a **minimal, stable HTTP surface** so the gateway can:

1. **Discover** payments / challenges created by CRP.
2. **Perform an exact-tuple match** for a specific payment it believes has been fulfilled.
3. **Trigger merchant webhooks** once a payment is confirmed as fulfilled.

---

## Base URL & Conventions

- All routes below are rooted at:

  `{BASE_URL}/v1/crp/...`

- All payloads are **JSON**.
- CRP responses always include:

  ```json
  {
    "ok": true,
    "reason": "string"  // optional, machine-readable
  }
  ```

  on top-level objects where applicable (with `ok: false` on failures).

- **Field naming:**
  - **Request bodies** from the gateway use camelCase (e.g. `merchantId`, `payTo`).
  - **Database-backed rows** in responses use snake_case fields (e.g. `merchant_id`, `pay_to`) because they reflect the underlying table layout.

---

## Canonical Payment Tuple

The core “tuple” the gateway and CRP share is:

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

Fields:

- `merchantId` — Identifier of the merchant as seen by both gateway and CRP.
- `nonce` — Unique payment/challenge identifier (per merchant).
- `network` — Concordium network identifier (e.g. `concordium:testnet`).
- `asset`:
  - `type` — Asset type, e.g. `"PLT"`.
  - `tokenId` — PLT identifier, e.g. `"usd:test"`.
  - `decimals` — Decimal precision (e.g. `2` for cents).
- `amount` — Decimal-string amount (`"25.00"`).
- `payTo` — Concordium address that received the PLT payment.

This tuple is used by:

- **Gateway → CRP** in `/payments/match` and `/payments/fulfill` requests.
- **CRP internal DB** when seeding challenges and recording fulfilled payments.

---

## Endpoint: GET `/v1/crp/payments/search`

Search challenges / payments by tuple filters.

### Purpose

- Allow the gateway (or admin tools) to **query payments** using a subset of the tuple, plus `status` and `limit`.
- This is **read-only** and does **not** send webhooks.

### Query Parameters

All parameters are optional. Empty or missing values are ignored.

| Param       | Type    | Description                                         |
|------------|---------|-----------------------------------------------------|
| `merchantId` | string | Filter by merchant identifier.                      |
| `network`    | string | Filter by network (e.g. `concordium:testnet`).     |
| `tokenId`    | string | Filter by PLT token ID (e.g. `usd:test`).          |
| `payTo`      | string | Filter by destination Concordium address.          |
| `status`     | string | Filter by status (e.g. `pending`, `fulfilled`).    |
| `limit`      | number | Max rows to return (default: `25`).                |

### Example Request

```bash
curl -sS   "http://localhost:8080/v1/crp/payments/search?merchantId=demo-merchant&network=concordium:testnet&tokenId=usd:test&payTo=ccd1qexampleaddress&status=fulfilled&limit=1"
```

### Example Response

```json
{
  "ok": true,
  "filters": {
    "merchantId": "demo-merchant",
    "network": "concordium:testnet",
    "tokenId": "usd:test",
    "payTo": "ccd1qexampleaddress",
    "status": "fulfilled",
    "limit": 1
  },
  "matches": [
    {
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
      "expiry": "2025-11-02T12:00:00.000Z",
      "policy": {},
      "metadata": {},
      "status": "fulfilled",
      "receipt": {
        "jws": "eyJhbGciOiJFZERTQSIsImtpZCI6ImtpZC1kZXYtMSIsInR5cCI6IkpXVCJ9.eyJub25jZSI6Im4tMTc2MzI3MjU2MCIsImFtb3VudCI6IjI1LjAwIiwibmV0d29yayI6ImNvbmNvcmRpdW06dGVzdG5ldCIsImFzc2V0Ijp7InR5cGUiOiJQTFQiLCJ0b2tlbklkIjoidXNkOnRlc3QiLCJkZWNpbWFscyI6Mn0sInBhaWRUbyI6ImNjZDFxZXhhbXBsZWFkZHJlc3MiLCJmaW5hbGl6ZWRBdCI6IjIwMjUtMTEtMTZUMDU6NTY6MDJaIn0.pDAt4jTOIo4Hb15ljQ_UixqZKpx_W2cThJqAvpIvBmoBfNRDHfPorjSGQrmgmFEr0TMP-X63yiJT2L3CwbScAw",
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
  ]
}
```

Notes:

- `matches[*]` reflect CRP’s internal **`challenges` / `payments`** table.
- `receipt` carries both:
  - `jws`: signed receipt JWS.
  - `payload`: decoded JWS payload for convenience.

---

## Endpoint: POST `/v1/crp/payments/match`

Exact-tuple match, **read-only**. This is the gateway’s way of asking:

> “Given this payment tuple I believe has been fulfilled, do you have an exact match for it?”

No webhook is sent from this endpoint.

### Request Body

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

### Validation

CRP rejects the request with `400` if any required field is missing or obviously invalid:

- Required: `merchantId`, `nonce`, `network`, `asset.type`, `asset.tokenId`, `asset.decimals`, `amount`, `payTo`.
- `asset.decimals` must be a number (not `NaN`).

On validation failure:

- **HTTP status:** `400`
- **Body:**

```json
{
  "ok": false,
  "reason": "bad_request",
  "error": "Missing or invalid required fields"
}
```

### Matching Logic (Conceptual)

1. CRP uses a **filter** derived from the tuple:

   - `merchantId`, `network`, `tokenId` (`asset.tokenId`), `payTo`.

2. It queries up to a bounded number of rows (currently 100) and then does an **in-memory exact comparison**:

   - `nonce` must match exactly.
   - `amount` must match exactly as a string.
   - `asset.type` and `asset.tokenId` must match.
   - `asset.decimals` must match numerically.

3. If exactly one row matches, that row is returned.  
   The internal uniqueness guarantees for this tuple are enforced at the DB / ingestion level.

### Responses

#### 1. Exact Match Found

- **HTTP status:** `200`

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
    "expiry": "2025-11-02T12:00:00.000Z",
    "policy": {},
    "metadata": {},
    "status": "fulfilled",
    "receipt": {
      "jws": "eyJhbGciOiJFZERTQSIsImtpZCI6ImtpZC1kZXYtMSIsInR5cCI6IkpXVCJ9.eyJub25jZSI6Im4tMTc2MzI3MjU2MCIsImFtb3VudCI6IjI1LjAwIiwibmV0d29yayI6ImNvbmNvcmRpdW06dGVzdG5ldCIsImFzc2V0Ijp7InR5cGUiOiJQTFQiLCJ0b2tlbklkIjoidXNkOnRlc3QiLCJkZWNpbWFscyI6Mn0sInBhaWRUbyI6ImNjZDFxZXhhbXBsZWFkZHJlc3MiLCJmaW5hbGl6ZWRBdCI6IjIwMjUtMTEtMTZUMDU6NTY6MDJaIn0.pDAt4jTOIo4Hb15ljQ_UixqZKpx_W2cThJqAvpIvBmoBfNRDHfPorjSGQrmgmFEr0TMP-X63yiJT2L3CwbScAw",
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
}
```

#### 2. No Match

- **HTTP status:** `200`

```json
{
  "ok": false,
  "reason": "no_match",
  "count": 0
}
```

The gateway should treat `reason: "no_match"` as “no such fulfilled payment exists for this tuple yet.”

---

## Endpoint: POST `/v1/crp/payments/fulfill`

Exact-tuple match + optional **merchant webhook**.

This is the primary endpoint the gateway calls when it wants to:

1. Confirm fulfillment for a payment tuple, and  
2. Have CRP notify the merchant via webhook (if configured).

### Request Body

Identical to `/v1/crp/payments/match`:

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

### Validation

Identical to `/v1/crp/payments/match`:

- On bad input:

```json
{
  "ok": false,
  "reason": "bad_request",
  "error": "Missing or invalid required fields"
}
```

- **HTTP status:** `400`.

### Matching

- Uses the same **exact-tuple match** as `/payments/match`.
- If no match is found, webhook is **not** attempted, and a stub webhook result is returned.

### Webhook Semantics

Once a match is found:

1. CRP resolves a **merchant-specific webhook URL** from environment variables.
2. If configured, CRP will **POST** a JSON payload to that URL.
3. The webhook result is returned in the `webhook` field of the `/payments/fulfill` response.

See [Webhook Configuration & Payload](#webhook-configuration--payload) below for details.

### Responses

#### 1. Exact Match + Webhook (configured & 2xx)

- **HTTP status:** `200`

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
    "expiry": "2025-11-02T12:00:00.000Z",
    "policy": {},
    "metadata": {},
    "status": "fulfilled",
    "receipt": {
      "jws": "eyJhbGciOiJFZERTQSIsImtpZCI6ImtpZC1kZXYtMSIsInR5cCI6IkpXVCJ9.eyJub25jZSI6Im4tMTc2MzI3MjU2MCIsImFtb3VudCI6IjI1LjAwIiwibmV0d29yayI6ImNvbmNvcmRpdW06dGVzdG5ldCIsImFzc2V0Ijp7InR5cGUiOiJQTFQiLCJ0b2tlbklkIjoidXNkOnRlc3QiLCJkZWNpbWFscyI6Mn0sInBhaWRUbyI6ImNjZDFxZXhhbXBsZWFkZHJlc3MiLCJmaW5hbGl6ZWRBdCI6IjIwMjUtMTEtMTZUMDU6NTY6MDJaIn0.pDAt4jTOIo4Hb15ljQ_UixqZKpx_W2cThJqAvpIvBmoBfNRDHfPorjSGQrmgmFEr0TMP-X63yiJT2L3CwbScAw",
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
  },
  "webhook": {
    "configured": true,
    "attempted": true,
    "ok": true,
    "status": 200
  }
}
```

#### 2. Exact Match + Webhook Not Configured

- **HTTP status:** `200`

```json
{
  "ok": true,
  "reason": "exact_match",
  "count": 1,
  "match": { "... same as above ..." },
  "webhook": {
    "configured": false,
    "attempted": false,
    "ok": false
  }
}
```

#### 3. Exact Match + Webhook Error (network / timeout / non-2xx)

- **HTTP status:** `200` (match is still valid; webhook failed)

```json
{
  "ok": true,
  "reason": "exact_match",
  "count": 1,
  "match": { "... same as above ..." },
  "webhook": {
    "configured": true,
    "attempted": true,
    "ok": false,
    "status": 500,
    "error": "timeout"
  }
}
```

- `status` is present if the HTTP response status is known (non-2xx).
- `error` is present if the request errored or timed out.

#### 4. No Match

- **HTTP status:** `200`

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

## Webhook Configuration & Payload

### Environment Variable Naming

CRP looks up a per-merchant webhook URL in the environment using a normalized key derived from `merchantId`.

1. Convert `merchantId` to uppercase.
2. Replace any sequence of non `[A-Z0-9]` characters with `_`.
3. Trim leading/trailing `_`.
4. Prefix with `CRP_WEBHOOK_URL_`.

Examples:

| `merchantId`         | env var                          |
|----------------------|----------------------------------|
| `demo-merchant`      | `CRP_WEBHOOK_URL_DEMO_MERCHANT` |
| `acme.inc`           | `CRP_WEBHOOK_URL_ACME_INC`      |
| `my-merchant-123`    | `CRP_WEBHOOK_URL_MY_MERCHANT_123` |

If the environment variable is unset or empty, CRP will treat the webhook as **not configured**:

```json
{
  "configured": false,
  "attempted": false,
  "ok": false
}
```

### HTTP Behaviour

- Method: `POST`
- Body: JSON
- Headers:
  - `content-type: application/json`
- Timeout: currently ~3 seconds (subject to tuning).
- No retries (single POST attempt only).

Transport:

- Uses Node’s built-in `http` / `https` modules based on the URL scheme.
- Webhooks can be plain HTTP (for local testing) or HTTPS in production.

### WebhookResult Structure

Every `/payments/fulfill` response includes a `webhook` object:

```ts
interface WebhookResult {
  configured: boolean; // true if a URL was found in env
  attempted: boolean;  // true if CRP tried to call it
  ok: boolean;         // true if 2xx response; false otherwise
  status?: number;     // HTTP status code from the webhook, if known
  error?: string;      // Error description (network error, timeout, etc.)
}
```

The gateway can use this to decide whether further action is required (e.g. retry on its own, alert, etc.).

### Webhook Payload: `crp.payment.fulfilled`

When `/v1/crp/payments/fulfill` finds an exact match and the merchant webhook is configured and returns 2xx, CRP POSTs:

```json
{
  "kind": "crp.payment.fulfilled",
  "payment": {
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
    "expiry": "2025-11-02T12:00:00.000Z",
    "policy": {},
    "metadata": {},
    "status": "fulfilled",
    "receipt": {
      "jws": "eyJhbGciOiJFZERTQSIsImtpZCI6ImtpZC1kZXYtMSIsInR5cCI6IkpXVCJ9.eyJub25jZSI6Im4tMTc2MzI3MjU2MCIsImFtb3VudCI6IjI1LjAwIiwibmV0d29yayI6ImNvbmNvcmRpdW06dGVzdG5ldCIsImFzc2V0Ijp7InR5cGUiOiJQTFQiLCJ0b2tlbklkIjoidXNkOnRlc3QiLCJkZWNpbWFscyI6Mn0sInBhaWRUbyI6ImNjZDFxZXhhbXBsZWFkZHJlc3MiLCJmaW5hbGl6ZWRBdCI6IjIwMjUtMTEtMTZUMDU6NTY6MDJaIn0.pDAt4jTOIo4Hb15ljQ_UixqZKpx_W2cThJqAvpIvBmoBfNRDHfPorjSGQrmgmFEr0TMP-X63yiJT2L3CwbScAw",
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

Fields:

- `kind` — Event type: currently `"crp.payment.fulfilled"`.
- `payment` — The exact matching row from CRP’s `challenges` / `payments` table:
  - Includes the asset, amount, network, destination address (`pay_to`) and `status`.
  - Includes `receipt.jws` (signed JWS) and `receipt.payload` (decoded claims).
  - Includes `created_at` / `updated_at` for auditing and UI purposes.

Merchants can:

- Route by `kind` (e.g. future events like `crp.payment.cancelled`).
- Store the full `payment` object in their own systems.
- Optionally verify `receipt.jws` against Concordium/merchant JWKS.

---

## Error Handling & Status Codes

- `200 OK` — Normal operation (match found or not, webhook success or failure).
  - Business outcome is communicated via `ok` and `reason` fields.
- `400 Bad Request` — Validation error on input (missing or invalid fields).
- `5xx` — Unexpected internal errors (CRP side).

Gateway **must** inspect:

- Top-level `ok` / `reason` to determine match outcome.
- `webhook.ok` / `webhook.status` / `webhook.error` to determine webhook outcome.

---

## Dev / Smoke Testing (Reference)

For local development, there is a helper script:

```bash
bash scripts/smoke-gateway-contract.sh
```

This script:

1. **Step 1** — Calls `/v1/crp/payments/search` with a filter for a fulfilled payment and writes:

   `.crp-gateway-sample.json`

2. **Step 2** — Extracts the canonical tuple and calls `/v1/crp/payments/match`.

3. **Step 3** — Calls `/v1/crp/payments/fulfill` with the same tuple and prints the resulting `webhook` object.

To verify a real webhook end-to-end, set e.g.:

```bash
export CRP_WEBHOOK_URL_DEMO_MERCHANT="https://webhook.site/<your-id>"
npm run start
bash scripts/smoke-gateway-contract.sh
```

You should see:

- `webhook: { "configured": true, "attempted": true, "ok": true, "status": 200 }` in the fulfill response.
- The full `crp.payment.fulfilled` payload on your webhook endpoint.

---

This contract is intentionally small and focused so that **gateway integration remains stable** even as internal CRP implementation details evolve.
