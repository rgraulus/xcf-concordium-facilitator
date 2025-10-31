# x402 Concordium-aware Facilitator (XCF)

**XCF Consists of UFX + CRP**
- **UFX (Universal Facilitator for x402):** rail-agnostic core that exposes the x402-friendly API, enforces idempotency/expiry, orchestrates policy checks, signs verifiable receipts (JWS), and emits webhooks/metrics.
- **CRP (Concordium Rail Plugin):** rail-specific adapter that reads **finalized** Concordium PLT (protocol-level token) events via gRPC v2 and matches exact payments.

> **PoC scope:** No custody; no on-chain contracts. Finality-only, exact amount matching, signed receipts, and minimal merchant integration (webhook + polling).

---

## ✨ Demo outcome
A payer scans a QR (or taps NFC), sends the exact PLT amount to the `pay_to` address, and the terminal shows a **green check** as soon as XCF issues a signed receipt.

---

## 📐 Hard guarantees
- **Finality-only:** match only transactions in **last-finalized** blocks (no mempool/pending).
- **Exact tuple match:** `{ tokenId, to, amountMinor }`, where `amountMinor = toMinorUnits(amount, decimals)`; **no slippage**.
- **Idempotency:** same `nonce` + identical payload ⇒ same outcome; same `nonce` + different payload ⇒ **422**.
- **Verifiable receipts:** JWS with `kid`, JWKS published at `/.well-known/jwks.json`.
- **Auth everywhere:** all facilitator endpoints require auth; CORS allow-list enforced.

---

# 🧱 Architecture (layered)

![XCF Layered Architecture](images/XCF Architecture.png)

# 🛣️ API (public, auth required)

- `POST /v1/challenges` — register a challenge (idempotent by `nonce`)
- `POST /v1/verify` — ad-hoc verify inline x402 payloads (no pre-registration)
- `GET  /v1/challenges/:nonce/status` — poll status
- `POST /v1/receipts/verify` — helper to verify JWS receipts server-side
- `GET  /.well-known/jwks.json` — JWKS for public keys (receipts)
- `GET  /supported` — discovery of schemes/networks/assets
- Ops: `GET /healthz`, `GET /readyz`, `GET /metrics`

**`/supported` example**
```json
{"schemes":["exact"],"networks":["concordium:testnet","concordium:mainnet"],"assets":[{"type":"PLT","tokenId":"USDQ","decimals":2}]}
````

---

# 📦 Data contracts (canonical)

**Challenge**

```json
{
  "v": "1",
  "rail": "x402",
  "network": "concordium:testnet",
  "asset": { "type": "PLT", "tokenId": "USDQ", "decimals": 2 },
  "amount": "25.00",
  "pay_to": "<ConcordiumAccountAddress>",
  "expiry": "2025-12-31T23:59:00Z",
  "nonce": "b64url-unique",
  "policy": { "allowlist": true, "zkp": [] },
  "metadata": { "order_id": "DEMO-001" }
}
```

* **Units:** `amount` is in **major** units; CRP converts to **minor** using `decimals` for matching.
* **Equality tuple:** `{ tokenId, to, amountMinor }` (strict equality).

**Receipt (UFX → merchant)**

```json
{
  "v": "1",
  "challenge_nonce": "b64url-unique",
  "network": "concordium:testnet",
  "asset": { "type": "PLT", "tokenId": "USDQ", "decimals": 2 },
  "amount": "25.00",
  "from": "<PayerAddress>",
  "to": "<ConcordiumAccountAddress>",
  "tx_hash": "<TxHash>",
  "block_hash": "<FinalizedBlockHash>",
  "finalized_at": "2025-10-01T12:34:56Z",
  "compliance": { "allowlist": true, "zkp": [], "passed": true },
  "facilitator_sig": "<compact JWS>",
  "facilitator_key_id": "fac-v1"
}
```

---

# 🔐 Security profile (must-haves)

* **Auth & transport:** HTTPS; auth on all endpoints; CORS allow-list; HSTS; per-route timeouts & rate limits.
* **Webhooks:** header `X-XCF-Signature` (HMAC-SHA256 over raw body). Base string: `v1:{timestamp}:{sha256(body)}`. Accept ±90s clock skew; merchants dedupe on `{challenge_nonce, tx_hash}`.
* **JWKS:** pin issuer/kid/alg; rotate by publishing old+new keys for N days; receipts include `kid`.
* **Logs:** structured JSON with `trace_id`, `merchant_id`, `nonce`, `status`, `latency`; redact addresses/proofs/headers.

---

# ♻️ State machine

`pending → fulfilled | expired | invalid | policy_failed` (terminal, immutable; retain ≥ settlement window)

---

# 🧪 Error taxonomy

* `400` bad request (schema)
* `401/403` unauthorized/forbidden
* `404` unknown nonce
* `408` long-poll timeout
* `409` duplicate nonce
* `422` mismatch (wrong asset/to/amount) or `policy_failed`
* `503/504` upstream/node issues

---

# 🚀 Replit setup

1. **Import/Upload** the starter (Node/TS).
2. **Secrets (Environment):**

   ```
   NODE_ENV=production
   PORT=8080
   DATABASE_URL=postgres://<user>:<pass>@<host>:5432/<db>
   REDIS_URL=rediss://:<token>@<host>:6379
   CCD_NODE=grpc://<concordium-node-host>:<port>
   NETWORK=concordium:testnet
   SIGNING_ALG=EdDSA
   SIGNING_KID=fac-v1
   SIGNING_KEY_BASE64=        # optional for PoC (auto-generate if empty)
   JWKS_ISSUER=https://xcf.example.com
   WEBHOOK_HMAC_SECRET=<long-random>
   CORS_ALLOWLIST=https://terminal.example.com,https://merchant.example.com
   SCAN_MAX_BLOCKS=2000
   MCP_AUTH_TOKEN=<dev-bearer-token>
   ```
3. **Run (dev):** `npm i && npm run dev`
4. **Endpoints sanity check:**

   * `GET /healthz` → `{ "ok": true }`
   * `GET /.well-known/jwks.json` → JWKS with `kid`

**Deployments:** use **Always-on** with a custom domain + HTTPS and health check `/healthz`.

---

# 🧩 CRP (Concordium Rail Plugin) notes

* **Access:** gRPC v2 to read **last-finalized** blocks. Implement stream with backoff/heartbeat; fallback to polling if needed.
* **Events:** parse PLT (CIS-7) transfers; resolve `decimals` from a registry/table; cache in memory.
* **Match:** compute `amountMinor` from `amount` and `decimals`; match the exact tuple; return `{ from, to, txHash, blockHash, finalizedAt, compliancePassed }`.

---

# 🧭 Developer workflow (milestones)

* **M1: UFX API skeleton** — routes, auth, schemas, JWKS, idempotency table.
* **M2: CRP wiring** — finalized stream/poll, event parsing, matcher unit tests.
* **M3: Atomic fulfill + webhooks** — single transaction write; HMAC & retries.
* **M4: Security pass** — CORS, rate limits, rotation, log redaction.
* **M5: Demo polish** — PWA terminal (QR/NFC), status polling/SSE, expiry UX.

---

# 🧰 cURL smoke tests

```bash
# Health & JWKS
curl -s https://xcf.example.com/healthz
curl -s https://xcf.example.com/.well-known/jwks.json | jq .

# Register a challenge (Bearer auth)
AUTH="Authorization: Bearer $MCP_AUTH_TOKEN"
BODY='{"network":"concordium:testnet","asset":{"type":"PLT","tokenId":"USDQ","decimals":2},"amount":"25.00","pay_to":"<addr>","expiry":"2099-12-31T23:59:00Z","nonce":"demo-001"}'
curl -s -H "$AUTH" -H "Content-Type: application/json" -d "$BODY" https://xcf.example.com/v1/challenges | jq .

# Poll status
curl -s -H "$AUTH" https://xcf.example.com/v1/challenges/demo-001/status | jq .
```

---

# 📁 Repo structure (suggested)

```
/src
  server.ts                 # Fastify, health/ready/metrics, JWKS
  auth.ts                   # bearer auth, CORS allowlist, replay window
  signer.ts                 # JWS sign; /.well-known/jwks.json; rotation
  /store
    db.ts                   # Postgres pool + migrations
    state.ts                # idempotency + atomic fulfill
  /ufx
    api.ts                  # /v1 endpoints
    scheduler.ts            # (optional) fulfillment loop/outbox worker
  /crp
    concordium.ts           # gRPC v2 client (finalized blocks)
    events.ts               # PLT (CIS-7) event parsing
    matcher.ts              # exact tuple match
  /util
    metrics.ts              # Prometheus text
    logger.ts               # structured logs
/docs                       # prompt, contracts, security, tests, etc.
/schemas                    # Ajv JSON schemas
```

---

# ✅ Definition of Done (PoC)

* Finality-only matching + strict equality tuple
* Idempotency semantics enforced (409 vs 422)
* Signed receipt (JWS) verifiable via `/.well-known/jwks.json`
* Webhook with `X-XCF-Signature` + retry/backoff
* Health/ready/metrics exposed; basic dashboards
* Demo: terminal gets **green check** on exact payment

---
