# x402 Concordium-aware Facilitator (XCF)

## 🧱 Architecture (layered)
<p align="center">
  <img src="images/XCF_Architecture.png" alt="XCF Layered Architecture" width="500">
</p>

**XCF consists of two layers:**
- **UFX (Universal Facilitator for x402)** – rail-agnostic core that exposes the x402-friendly API, enforces idempotency/expiry, signs verifiable receipts (JWS), and emits webhooks/metrics.
- **CRP (Concordium Rail Plugin)** – rail-specific adapter that talks to a Concordium **gRPC v2** node, reads **finalized** blocks, parses PLT (protocol-level token) transfers, and matches exact payments.

> **PoC scope:** No custody; no on-chain contracts. Finality-only, exact amount matching, signed receipts, and minimal merchant integration (webhook + polling).

---

## ✨ Demo outcome
A payer scans a QR (or taps NFC), sends the exact PLT amount to the `pay_to` address, and the terminal shows a **green check** as soon as XCF issues a signed receipt.

---

## 📐 Hard guarantees
- **Finality-only**: match only transactions in **last-finalized** blocks (no mempool/pending).
- **Exact tuple match**: `{ tokenId, to, amountMinor }`, where `amountMinor = toMinorUnits(amount, decimals)`; **no slippage**.
- **Idempotency**: same `nonce` + identical payload ⇒ same outcome; same `nonce` + different payload ⇒ **422**.
- **Verifiable receipts**: compact JWS with `kid`; JWKS published at `/.well-known/jwks.json`.
- **Auth everywhere**: all facilitator endpoints require auth; CORS allow-list enforced.

---

## 🧭 Milestones (status)
- **M1 (done)** – UFX API skeleton: routes, auth, schemas, JWKS, idempotency table.
- **M2 (done)** – CRP wiring: gRPC v2 client, `/v1/crp/health`, `/v1/crp/consensus`, fast-path `/v1/crp/payments/search`.
- **Next** – Stream finalized blocks, PLT traversal/match, webhooks, security pass.

---

## 🚀 Quick start (dev)

### 1) Install
```bash
npm i
2) Environment
Create .env (example for testnet):

ini
Copy code
PORT=8080
HOST=0.0.0.0

# Concordium gRPC (testnet public node)
CONCORDIUM_GRPC_HOST=grpc.testnet.concordium.com
CONCORDIUM_GRPC_PORT=20000
CONCORDIUM_GRPC_TLS=true
CONCORDIUM_NETWORK=testnet

# JWKS / JWS signing (optional for PoC receipts)
JWS_PRIVATE_KEY_BASE64=...base64-ed25519-private-key...
JWS_KID=kid-dev-1
JWS_ALG=EdDSA
3) Build & Run
bash
Copy code
npm run build
npm run start
🧪 Smoke checks
bash
Copy code
# Liveness
curl -s http://localhost:8080/healthz | jq .

# CRP health (verifies host/port/TLS actually in use)
curl -s http://localhost:8080/v1/crp/health | jq .

# Consensus (hashes are 64-char hex; heights may be empty by design)
curl -s http://localhost:8080/v1/crp/consensus | jq .

# PLT search (fast path; matches may be empty)
curl -s "http://localhost:8080/v1/crp/payments/search" | jq .
Or via helper scripts:

bash
Copy code
npm run smoke:crp
npm run smoke:plt
🛣️ Public API (auth required)
POST /v1/challenges — register a challenge (idempotent by nonce)

POST /v1/verify — ad-hoc verify inline x402 payloads (no pre-registration)

GET /v1/challenges/:nonce/status — poll status

POST /v1/receipts/verify — helper to verify JWS receipts server-side

GET /.well-known/jwks.json — JWKS for public keys (receipts)

GET /supported — discovery of schemes/networks/assets

Ops: GET /healthz, GET /v1/crp/health, GET /v1/crp/consensus, GET /metrics

/supported example

json
Copy code
{"schemes":["exact"],"networks":["concordium:testnet","concordium:mainnet"],"assets":[{"type":"PLT","tokenId":"USDQ","decimals":2}]}
📁 Repo structure (current highlights)
bash
Copy code
/src
  server.ts               # Fastify, health, route wiring
  /routes
    crp.health.ts         # /v1/crp/health
    crp.reads.ts          # /v1/crp/consensus
    crp.payments.ts       # /v1/crp/payments/search (fast-path)
  /crp
    grpc.ts               # gRPC v2 Queries client
    transport-shim.ts     # mergeOptions shim for grpc transport
/schemas                  # Ajv JSON schemas
/scripts                  # probes & smoke helpers
✅ Definition of Done (PoC)
Finality-only matching + strict equality tuple

Idempotency semantics enforced (409 vs 422)

Signed receipt (JWS) verifiable via /.well-known/jwks.json

Health endpoints and quick smoke scripts

Demo: terminal gets green check on exact payment
