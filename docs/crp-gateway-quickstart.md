# CRP ↔ Gateway Integration Quickstart

This document is a practical guide for implementers of an x402/paywall gateway
that integrates with the **Concordium Rail Plugin (CRP)** service.

It shows how to:

1. Discover a fulfilled payment in CRP.
2. Perform an **exact-tuple match** via `/v1/crp/payments/match`.
3. Call `/v1/crp/payments/fulfill` and receive a webhook callback.

The goal is to validate the **HTTP contract** between the gateway and CRP using
real testnet flows.

---

## 1. CRP endpoints

All CRP routes are currently rooted at:

- Base URL (local dev): `http://localhost:8080`
- CRP routes: `/v1/crp/...`

For the gateway integration, the key endpoints are:

- `GET  /v1/crp/payments/search`
- `POST /v1/crp/payments/match`
- `POST /v1/crp/payments/fulfill`

These operate on a **payment challenge** stored in the CRP database (table
`challenges`), representing a payment that has been observed and finalized on
the Concordium testnet.

---

## 2. Search for a fulfilled payment

The gateway can use `/v1/crp/payments/search` to query payments by tuple:

- `merchantId`
- `network`
- `tokenId`
- `payTo`
- `status`
- `limit`

Example request:

```bash
curl -sS   "http://localhost:8080/v1/crp/payments/search?merchantId=demo-merchant&network=concordium:testnet&tokenId=usd:test&payTo=ccd1qexampleaddress&status=fulfilled&limit=1"
```

Example (trimmed) response:

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
      "status": "fulfilled",
      "receipt": {
        "jws": "...",
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
      }
    }
  ]
}
```

The gateway does **not** have to use `/search` in production if it already knows
the tuple it wants to verify. However, `/search` is useful for:

- Dev/test flows.
- Backoffice reconciliation.
- Debugging specific payments.

---

## 3. Exact-tuple matching (`/v1/crp/payments/match`)

In the normal flow, the gateway will send CRP an **exact tuple** describing a
payment it believes has been completed on-chain. CRP then confirms whether this
tuple matches a known, finalized payment in its `challenges` table.

### 3.1. Request shape

`POST /v1/crp/payments/match`

Body:

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

- `merchantId` – gateway’s merchant identifier (string).
- `nonce` – unique payment nonce (string).
- `network` – Concordium network identifier (e.g. `concordium:testnet`).
- `asset.type` – `PLT` for Protocol Level Token.
- `asset.tokenId` – PLT identifier (e.g. `usd:test`).
- `asset.decimals` – integer decimals for the PLT (e.g. `2`).
- `amount` – human-readable amount as a string (e.g. `"25.00"`).
- `payTo` – Concordium account address (string).

### 3.2. Response (success)

If CRP finds an **exact match**, it responds:

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
      "jws": "...",
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
    }
  }
}
```

Key points:

- `ok: true` and `reason: "exact_match"` indicate that CRP found a unique,
  exact match.
- `match` contains the internal CRP record plus an embedded **JWS receipt**
  signed by the CRP / CDP key.

### 3.3. Response (no match)

If nothing matches:

```json
{
  "ok": false,
  "reason": "no_match",
  "count": 0
}
```

In this case, the gateway should treat the payment as **not confirmed** by CRP.

---

## 4. Fulfill + webhook (`/v1/crp/payments/fulfill`)

`/v1/crp/payments/fulfill` is the **same tuple match** as `/match`, but:
- Intended as the gateway’s fulfillment entrypoint.
- Triggers a **webhook POST** to the merchant’s backend, if configured.

### 4.1. Request shape

`POST /v1/crp/payments/fulfill` takes the same body as `/match`:

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

### 4.2. Response with webhook

If there is an exact match, CRP responds:

```json
{
  "ok": true,
  "reason": "exact_match",
  "count": 1,
  "match": {
    "...": "same as /match"
  },
  "webhook": {
    "configured": true,
    "attempted": true,
    "ok": true,
    "status": 200
  }
}
```

If the webhook URL is **not configured** for the merchant, CRP still returns
the match, but with:

```json
"webhook": {
  "configured": false,
  "attempted": false,
  "ok": false
}
```

If the webhook is configured but fails (network error, timeout, non-2xx),
CRP returns:

```json
"webhook": {
  "configured": true,
  "attempted": true,
  "ok": false,
  "status": 500,
  "error": "..."
}
```

The gateway can decide how strictly to treat webhook failures (e.g. retry vs
surface warning).

---

## 5. Merchant webhook configuration

CRP resolves the merchant webhook URL from environment variables.

For a merchant:

- `merchantId`: `"demo-merchant"`

CRP looks for:

```text
CRP_WEBHOOK_URL_DEMO_MERCHANT
```

The normalization rules:

- Uppercase the merchant ID.
- Replace any sequence of non `[A-Z0-9]` characters with `_`.
- Trim leading/trailing `_`.
- Prefix with `CRP_WEBHOOK_URL_`.

Examples:

- `"demo-merchant"` → `CRP_WEBHOOK_URL_DEMO_MERCHANT`
- `"acme.inc"` → `CRP_WEBHOOK_URL_ACME_INC`
- `"my-merchant-123"` → `CRP_WEBHOOK_URL_MY_MERCHANT_123`

In local dev, you can run CRP like this:

```bash
CRP_WEBHOOK_URL_DEMO_MERCHANT="https://webhook.site/<your-id>"   npm run start
```

When the gateway calls `/v1/crp/payments/fulfill`, CRP will POST a JSON
payload to that URL:

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
    "status": "fulfilled",
    "receipt": {
      "jws": "...",
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

---

## 6. Notes on testnet vs real gateway flows

For local/backend testing:

- The CRP service and its server-side test wallets handle the actual Concordium
  testnet payments and receipts.
- The gateway only needs to:
  - Work with the HTTP contract above.
  - Optionally inspect the JWS receipt to verify headers and payload.

For a **full end-to-end shopper flow** (wallet → PLT transfer → receipt → CRP)
you will also need:

- A testnet Concordium wallet funded with CCD and PLT.
- A gateway that creates challenges and drives the wallet UX.

This Quickstart focuses on the CRP ↔ Gateway HTTP contract and webhook path.
