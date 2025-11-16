# PayFi Integration Checklist (CRP / Concordium Rail Plugin)

This checklist is for the **PayFi / Gateway** team integrating with the **Concordium Rail Plugin (CRP)** on testnet.

It assumes:

- CRP is already deployed and reachable (e.g. `http://localhost:8080` in dev).
- CRP is wired to **Concordium testnet** and a **Postgres** instance.
- The docs below are available in the repo:
  - `docs/crp-gateway-contract.md`
  - `docs/crp-gateway-quickstart.md`
  - `docs/crp-gateway-testnet-flow.md`

Use this as a **working checklist** when bringing up a new environment.

---

## 1. High-level goals

- [ ] Gateway and CRP agree on a **stable HTTP contract** for payments.
- [ ] Gateway can **discover and match** finalized payments via CRP.
- [ ] Gateway can call CRP to **fulfill** a payment and receive a webhook.
- [ ] Both sides have a **repeatable smoke-flow** for testnet verification.

---

## 2. Prerequisites

Before starting integration, check:

- [ ] You know the **base URL** for CRP in your environment  
      (e.g. `https://crp.dev.example.com` or `http://localhost:8080`).
- [ ] You have at least one **merchantId** for test (e.g. `demo-merchant`).
- [ ] You have a **webhook endpoint** (per merchant) that can accept:
      - HTTP `POST`
      - `Content-Type: application/json`
      - A simple JSON body of the form:
        - `{ "kind": "crp.payment.fulfilled", "payment": { ... } }`
- [ ] CRP has access to **Concordium testnet** (as per existing setup).
- [ ] CRP can connect to **Postgres** and see the `challenges` table.

---

## 3. Environment configuration (CRP)

CRP uses environment variables for:

### 3.1 Base networking (already existing)

- [ ] Host and port (e.g. `:8080`) are correctly configured for your environment.
- [ ] Any reverse proxy / ingress in front of CRP forwards:
      - Method, path, query string
      - Request body
      - Standard HTTP headers

(No special headers are required for the CRP–Gateway contract at this stage.)

### 3.2 Merchant webhooks

CRP resolves merchant-specific webhook URLs from environment variables.

Pattern (documented in `src/webhook.ts`):

- Input: `merchantId` (e.g. `demo-merchant`)
- Normalization:
  - Uppercase everything
  - Replace any sequence of non-`[A-Z0-9]` chars with `_`
  - Trim leading/trailing `_`
- Resulting env var name:

  - `CRP_WEBHOOK_URL_<NORMALIZED_MERCHANT_ID>`

Examples:

- `demo-merchant` → `CRP_WEBHOOK_URL_DEMO_MERCHANT`
- `acme.inc`      → `CRP_WEBHOOK_URL_ACME_INC`
- `my-merchant-123` → `CRP_WEBHOOK_URL_MY_MERCHANT_123`

Checklist:

- [ ] For each test merchant, set the appropriate env var. Example:

      CRP_WEBHOOK_URL_DEMO_MERCHANT=https://webhook.site/your-test-id

- [ ] Webhook endpoint is reachable from the CRP environment (no firewall / VPN issues).
- [ ] Webhook endpoint logs/inspects incoming JSON bodies for debugging.

---

## 4. Contract docs to align on

CRP and the Gateway must both read and align on:

- [ ] `docs/crp-gateway-contract.md`  
      The **authoritative HTTP contract** between Gateway (x402/paywall) and CRP.
- [ ] `docs/crp-gateway-quickstart.md`  
      A **hands-on developer guide** to bring up a local test environment and run smokes.
- [ ] `docs/crp-gateway-testnet-flow.md`  
      A **testnet-oriented flow doc** describing how receipts and challenges relate.

Key tuple that both sides must agree on:

- `merchantId` (string)
- `nonce` (string)
- `network` (string, e.g. `concordium:testnet`)
- `asset`:
  - `type` (e.g. `PLT`)
  - `tokenId` (e.g. `usd:test`)
  - `decimals` (e.g. `2`)
- `amount` (string, e.g. `"25.00"`)
- `payTo` (e.g. CCD account address)

This tuple is what CRP uses for **exact matching**.

---

## 5. Minimal integration tests for PayFi

### 5.1 Health and basic connectivity

From a machine that can reach CRP:

- [ ] `GET /healthz`
- [ ] `GET /v1/crp/health`
- [ ] `GET /v1/crp/consensus`

Expected:

- HTTP 200
- JSON bodies indicating `ok: true` and a valid network (e.g. `testnet`).

If you’re using the provided scripts, see:

- `scripts/smoke-crp-reads.sh`
- `scripts/smoke-crp-plt.sh`
- `scripts/smoke-gateway-contract.sh`

(Names may evolve, but the docs above describe their intent.)

---

### 5.2 Verify that test payments show up in CRP

Goal: Confirm that CRP can **search** for payments that the system considers finalized.

- [ ] Ensure there is at least **one fulfilled payment** in the CRP database
      for your test merchant and PLT asset  
      (`status = "fulfilled"` in `challenges` table).

- [ ] Call:

      GET /v1/crp/payments/search?merchantId=<id>&network=<network>&tokenId=<token>&payTo=<addr>&status=fulfilled&limit=1

  For example:

      GET /v1/crp/payments/search
        ?merchantId=demo-merchant
        &network=concordium:testnet
        &tokenId=usd:test
        &payTo=ccd1qexampleaddress
        &status=fulfilled
        &limit=1

Expected:

- [ ] Response `ok: true`
- [ ] `matches` array with at least one row
- [ ] Each row includes:
  - `merchant_id`
  - `nonce`
  - `network`
  - `asset` object (type, tokenId, decimals)
  - `amount`
  - `pay_to`
  - `status`
  - `receipt.jws` and `receipt.payload`

---

### 5.3 Exact-tuple match (`/v1/crp/payments/match`)

Goal: The Gateway can ask CRP:  
“Given this tuple (from my payment session), do you see an exact match?”

CRP endpoint:

- `POST /v1/crp/payments/match`

Body shape (simplified):

- `merchantId` (string)
- `nonce` (string)
- `network` (string)
- `asset`:
  - `type`
  - `tokenId`
  - `decimals`
- `amount` (string)
- `payTo` (string)

Checklist:

- [ ] Gateway can construct the tuple **from its own payment session**.
- [ ] Gateway calls `POST /v1/crp/payments/match` with this tuple.
- [ ] CRP responds with:

      { "ok": true, "reason": "exact_match", "count": 1, "match": { ... } }

  when there is a single confirmed payment matching the tuple.

- [ ] In the “no match” case, Gateway handles:

      { "ok": false, "reason": "no_match", "count": 0 }

appropriately (e.g. show “payment not found yet, please retry”).

---

### 5.4 Fulfillment + webhook (`/v1/crp/payments/fulfill`)

Goal: Use CRP as the **fulfillment oracle**:

- Gateway sends the same tuple as for `/match`.
- CRP:
  - Verifies exact match.
  - Returns the matching payment.
  - Attempts a webhook (if configured for the merchant).

Endpoint:

- `POST /v1/crp/payments/fulfill`

Body: **same tuple** as `/match`.

Expected success response (shape):

- [ ] `ok: true`
- [ ] `reason: "exact_match"`
- [ ] `count: 1`
- [ ] `match: { ... }` (same payment row)
- [ ] `webhook: { configured, attempted, ok, status?, error? }`

Checklist:

- [ ] Webhook configured: `CRP_WEBHOOK_URL_<NORMALIZED_MERCHANT_ID>` set.
- [ ] On success, `webhook.ok === true` and `webhook.status` is 2xx.
- [ ] Gateway logs both the CRP response and the webhook result in its own logging.
- [ ] The receiving webhook service logs the incoming body:

      {
        "kind": "crp.payment.fulfilled",
        "payment": { ... }
      }

---

## 6. Gateway responsibilities

Summary of what the **Gateway / PayFi** side must do:

- [ ] Maintain the **tuple** (merchantId, nonce, network, asset, amount, payTo) across:
      - Challenge creation (402 response)
      - Wallet payment
      - Finalization / receipt
      - Call into CRP
- [ ] Decide when a payment is considered **ready** to query CRP:
      - After wallet has paid and the network has finalized the PLT transfer.
      - Ensure any intermediate ingestion layer has written the payment
        into CRP’s `challenges` table (with `status = "fulfilled"` and `receipt`).
- [ ] Handle **match** vs **no-match** vs **error** cases from CRP gracefully.
- [ ] Treat `/v1/crp/payments/fulfill` as a **side-effecting call**:
      - It may trigger webhooks.
      - It should not be retried blindly without idempotency strategy on the Gateway side.

---

## 7. CRP responsibilities

What CRP is expected to guarantee (once deployed correctly):

- [ ] Stable HTTP contract as documented in `docs/crp-gateway-contract.md`.
- [ ] Highly predictable behavior of:
      - `/v1/crp/payments/search`
      - `/v1/crp/payments/match`
      - `/v1/crp/payments/fulfill`
- [ ] Clear indication of webhook status in the response:
      - `configured`
      - `attempted`
      - `ok`
      - `status` (if HTTP response was received)
      - `error` (for network/timeout/serialization failures)
- [ ] Well-defined error responses with:
      - `ok: false`
      - `reason` and a human-readable `error` string for 4xx/5xx cases.

---

## 8. Final “ready for joint E2E test” checklist

Before running a joint end-to-end demo with actual wallets:

- [ ] All health checks are green.
- [ ] Gateway can:
      - Issue challenges,
      - Record the tuple,
      - Call into CRP `/match` and `/fulfill`.
- [ ] Webhook pipeline is tested end-to-end using **test payments**.
- [ ] Both teams agree on:
      - Tuple semantics (exactly which fields, types, and normalization rules),
      - Error-handling behavior,
      - Logging strategy for debugging live issues.

Once all boxes above are ticked, the system is ready for:
- Wallet-based human-in-the-loop flows, and
- Future autonomous/agentic flows that build on the same CRP contract.
