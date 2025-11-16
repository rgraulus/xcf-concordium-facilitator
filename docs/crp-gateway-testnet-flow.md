# CRP ↔ Gateway Testnet Flow (Concordium x402 Payments)

This document describes how the **Concordium Rail Plugin (CRP)** and an x402 **Payment Gateway / Paywall** cooperate on **Concordium testnet** to support real payment flows with **PLT-based receipts** and **merchant webhooks**.

It is written from the perspective of:

- **Gateway implementors** (x402/paywall side)
- **CRP backend / PayFi integrators** (this repo)

---

## 1. Roles and Components

- **Gateway (x402 / Paywall layer)**  
  - Owns merchant and pricing logic.  
  - Issues payment **challenges** and collects **receipts** (JWS).  
  - Interacts with CRP only via HTTP.

- **CRP (Concordium Rail Plugin)**  
  - Read/payments facilitator service.  
  - Provides read APIs and payment tuple matching for the gateway.  
  - Does **not** hold funds; it is not a wallet.  
  - Verifies PLT receipts and stores them in Postgres.

- **Concordium Testnet**  
  - L1 chain used for PLT payments and test flows.  
  - CRP talks to the Concordium testnet node (gRPC) for reads.

- **Merchant Webhook Endpoint**  
  - HTTP endpoint owned by the merchant or gateway.  
  - Receives a `crp.payment.fulfilled` notification from CRP when a
    payment tuple is fulfilled.

---

## 2. Core Data: Payment Tuple

The common “currency” between CRP and the Gateway is the **payment tuple**:

```jsonc
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

This tuple appears in the CRP contract in three places:

1. As part of a stored **payment/challenge** in the `challenges` table.
2. As the **input** to:
   - `POST /v1/crp/payments/match`
   - `POST /v1/crp/payments/fulfill`
3. As the “shape” embedded in the **receipt payload** (JWS payload) after a successful PLT payment.

The gateway is responsible for:

- Choosing `merchantId`, `nonce`, `amount`, `payTo`, and policy/metadata.
- Issuing the on-chain payment (through a wallet / terminal).
- Obtaining the **JWS receipt** and passing it to the CRP idempotent receipt endpoint (not part of the gateway contract; covered by the Payment Terminal / PayFi side).

CRP is responsible for:

- Persisting the payment row with tuple and status (`pending` → `fulfilled`).
- Making that payment discoverable through `/v1/crp/payments/search`.
- Enabling exact tuple matching through `/v1/crp/payments/match` and `/v1/crp/payments/fulfill`.
- Optionally posting a merchant webhook on successful fulfillment.

---

## 3. HTTP Contract Summary (Gateway-facing)

From the Gateway’s point of view, the CRP exposes three key routes:

1. **Search payments:**

   ```http
   GET /v1/crp/payments/search
   ```

   Query parameters (all optional):

   - `merchantId`
   - `network`
   - `tokenId`
   - `payTo`
   - `status` (e.g. `fulfilled`)
   - `limit` (default 25)

2. **Exact tuple match (read-only):**

   ```http
   POST /v1/crp/payments/match
   ```

   Body: the payment tuple as JSON.

3. **Exact tuple fulfill (match + webhook):**

   ```http
   POST /v1/crp/payments/fulfill
   ```

   Body: same payment tuple as JSON.

   - On success:
     - Returns `{ ok: true, reason: "exact_match", match, webhook }`.
     - `webhook` describes whether a merchant webhook was configured and whether the POST succeeded.

The detailed contract is in:

- `docs/crp-gateway-contract.md`

---

## 4. Testnet Flow: End-to-End (Happy Path)

This section describes the ideal end-to-end flow on **Concordium testnet**, assuming:

- The **Payment Terminal / PayFi side** is already creating `challenges` and updating them to `fulfilled` using a verified PLT receipt (JWS).
- The CRP database contains at least one `fulfilled` payment row.

### 4.1. Preconditions

- **CRP service** running (UFX server):

  ```bash
  npm run start
  # UFX listening on :8080
  ```

- **Database** up and seeded with demo/test challenges.
- **Concordium testnet node** reachable (for /v1/crp/consensus and account reads).
- **Optional: Merchant webhook configured** (for fulfill testing):

  ```bash
  export CRP_WEBHOOK_URL_DEMO_MERCHANT="https://your.webhook/endpoint"
  npm run start
  ```

  The env var name is derived from `merchantId`:

  - `merchantId: "demo-merchant"` → `CRP_WEBHOOK_URL_DEMO_MERCHANT`

### 4.2. Step 1 – Gateway discovers a fulfilled payment

CRP ships with a helper script:

```bash
bash scripts/smoke-gateway-contract.sh
```

This script simulates what a gateway would do. The first step is:

```http
GET /v1/crp/payments/search
  ?merchantId=demo-merchant
  &network=concordium:testnet
  &tokenId=usd:test
  &payTo=ccd1qexampleaddress
  &status=fulfilled
  &limit=1
```

The script:

- Calls `/v1/crp/payments/search` with the parameters above.
- Writes the first match into `.crp-gateway-sample.json`.

This is equivalent to:

```bash
curl -sS   "http://localhost:8080/v1/crp/payments/search?merchantId=demo-merchant&network=concordium:testnet&tokenId=usd:test&payTo=ccd1qexampleaddress&status=fulfilled&limit=1"
```

The response contains a `matches[0]` element with fields:

- `merchant_id`
- `nonce`
- `network`
- `asset`
- `amount`
- `pay_to`
- `status` (e.g. `"fulfilled"`)
- `receipt` (JWS + decoded payload)
- `created_at`, `updated_at`

The script extracts and normalizes this into the JSON tuple the gateway would use.

### 4.3. Step 2 – Gateway calls `/v1/crp/payments/match`

Given the tuple described above, the gateway issues:

```http
POST /v1/crp/payments/match
Content-Type: application/json

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

CRP:

1. Converts this into a `PaymentMatchInput`.
2. Uses `searchPayments` with a tight filter:
   - `merchantId`
   - `network`
   - `tokenId`
   - `payTo`
3. Scans the candidate rows in memory to find an exact match on:
   - `nonce`
   - `amount`
   - `asset.type`
   - `asset.tokenId`
   - `asset.decimals`

If a row is found, CRP returns:

```json
{
  "ok": true,
  "reason": "exact_match",
  "count": 1,
  "match": {
    "...": "full payment row from DB"
  }
}
```

If no row is found:

```json
{
  "ok": false,
  "reason": "no_match",
  "count": 0
}
```

The gateway can treat `POST /v1/crp/payments/match` as a **read-only sanity check**:  
“Does CRP see exactly the same payment tuple I believe has been fulfilled on-chain?”

This is especially useful when:

- Debugging testnet integration.
- Verifying invariants before triggering webhooks or granting access.

### 4.4. Step 3 – Gateway calls `/v1/crp/payments/fulfill`

Once the gateway is satisfied that the tuple is valid, it calls:

```http
POST /v1/crp/payments/fulfill
Content-Type: application/json

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

CRP:

1. Performs the **same exact tuple match** as `/payments/match`.
2. If no match is found:
   - Returns `{ ok: false, reason: "no_match", count: 0, webhook: { configured: false, attempted: false, ok: false } }`
3. If a match is found:
   - Builds a webhook payload:

     ```json
     {
       "kind": "crp.payment.fulfilled",
       "payment": {
         "...": "full payment row from DB"
       }
     }
     ```

   - Looks up a merchant-specific webhook URL:
     - `CRP_WEBHOOK_URL_DEMO_MERCHANT` for `merchantId = "demo-merchant"`.
   - If a URL is configured:
     - POSTs the JSON envelope to the webhook URL.
   - Returns:

     ```json
     {
       "ok": true,
       "reason": "exact_match",
       "count": 1,
       "match": { "...": "payment row" },
       "webhook": {
         "configured": true,
         "attempted": true,
         "ok": true,
         "status": 200
       }
     }
     ```

If no webhook URL is configured, CRP returns:

```json
"webhook": {
  "configured": false,
  "attempted": false,
  "ok": false
}
```

This allows the gateway to distinguish between:

- “No webhook configured for this merchant” vs.
- “Webhook configured, but POST failed.”

---

## 5. Example Webhook Payload (from Testnet Demo)

A real `crp.payment.fulfilled` payload captured via `webhook.site` looks like:

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
      "jws": "…",
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

Key points for gateway / merchant webhook handlers:

- `kind` can be used for event routing (`crp.payment.fulfilled`).
- `payment.status` indicates the state (`fulfilled`).
- `payment.receipt.payload` contains the normalized PLT receipt payload.
- `payment.nonce` and `payment.amount` can be correlated with internal order IDs.

---

## 6. How to Run the Testnet Gateway Flow Locally

1. **Start CRP / UFX:**

   ```bash
   # optional: set webhook URL before starting
   export CRP_WEBHOOK_URL_DEMO_MERCHANT="https://webhook.site/your-id"

   npm run start
   ```

2. **Run the gateway contract smoke test:**

   ```bash
   bash scripts/smoke-gateway-contract.sh
   ```

   This runs:

   - `GET /v1/crp/payments/search` → `.crp-gateway-sample.json`
   - `POST /v1/crp/payments/match`
   - `POST /v1/crp/payments/fulfill`

3. **Inspect the webhook:**

   - If using `webhook.site`, look at the latest request.  
   - Confirm the payload matches the structure in section 5.

4. **Iterate with a real Gateway implementation:**

   - Replace the bash script with real gateway calls.  
   - Use the same payment tuple structure and endpoints.

---

## 7. Next Steps

This document focuses on **CRP ↔ Gateway integration on testnet**.  
Next phases will typically include:

1. **Integrating a real x402 Gateway / Payment Terminal implementation** that:
   - Issues challenges and collects receipts.
   - Calls CRP endpoints (`/payments/match`, `/payments/fulfill`) directly.

2. **Extending monitoring and metrics** for:
   - Match/fulfill success and failure rates.
   - Webhook delivery metrics.

3. **Hardening**:
   - AuthN/AuthZ between Gateway and CRP (e.g. API keys, mTLS).
   - Additional validation around tuples and receipt origin.
