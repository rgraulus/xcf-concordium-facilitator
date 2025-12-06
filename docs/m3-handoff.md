# XCF Concordium Facilitator – M3 Hand-off Summary

## 1. Purpose of this service

The XCF Concordium Facilitator is a Node/TypeScript service that:

- Exposes a CRP-style payment gateway API on top of Concordium (testnet).
- Reads chain data via Concordium gRPC and wallet-proxy.
- Normalizes PLT (Protocol-Level Token) events and CRP payment information into Postgres.
- Provides operational endpoints for health, readiness, and basic metrics.

It is intended to sit between:

- Upstream payment initiators / resource servers (speaking CRP/x402-like HTTP),
- Downstream Concordium infrastructure (node, wallet-proxy, transaction-logger),
- And internal observability/ops tooling.

---

## 2. Current scope (M1–M3)

### M1 – Core skeleton and JWT/JWS

- Fastify server scaffolding in place.
- Base health endpoint:
  - GET /health
- JWS/JWT signing wired for payment receipts:
  - Uses Ed25519 key from env (JWS_PRIVATE_KEY_BASE64, JWS_KID, JWS_ALG).
- Basic configuration via .env and .env.example.

Status: complete and merged to main.

---

### M2 – Concordium gRPC and CRP core routes

- Concordium testnet gRPC wiring (Node/TS client) using the documented host/port:
  - CONCORDIUM_GRPC_HOST=grpc.testnet.concordium.com
  - CONCORDIUM_GRPC_PORT=20000
  - CONCORDIUM_GRPC_TLS=true
- CRP “core” routes under /v1/crp:
  - GET /v1/crp/consensus  
    Returns current consensus / chain summary from Concordium testnet.
  - GET /v1/crp/account/:address  
    Reads account information from Concordium (shape tailored for CRP).
- PLT search route:
  - GET /v1/crp/plt/search  
    Queries PLT transfer events stored in Postgres (crp_plt_events) once populated.

Status: complete, passing smoke tests against testnet (subject to node load).

---

### M3 – Wallet-proxy integration, PLT worker, ops endpoints, and CRP payments

#### 3.1 Infrastructure integration

Components:

- Postgres (xcf-pg)
  - Main facilitator DB (postgres://postgres:pg@127.0.0.1:5432/postgres).
  - Shared transaction-outcome DB for Concordium transaction-logger.
- Transaction logger (concordium/transaction-logger)
  - Scans Concordium testnet and writes into transaction-outcome.
- Wallet-proxy (concordium/wallet-proxy)
  - HTTP façade over Concordium node + transaction-outcome DB.
  - XCF calls into:
    - /v3/accTransactions/:account

Environment:

- WALLET_PROXY_BASE_URL=http://localhost:3000
- WALLET_PROXY_TIMEOUT_MS=15000
- WALLET_PROXY_MAX_RETRIES=2

#### 3.2 Wallet-proxy client and PLT source

- Dedicated internal client module for wallet-proxy:
  - Handles HTTP calls with timeouts, retry, and structured error handling.
  - Used both by the PLT worker and readiness checks.
- Concordium PLT source abstraction:
  - Initially stubbed to return no events.
  - Now extended to:
    - Call wallet-proxy /v3/accTransactions for a configured account.
    - Filter and normalize PLT transfers for a logical tokenId (e.g. "EUDemo").
    - Return events in a generic shape (network, blockHeight, txHash, from/to, amountMinor, occurredAt, etc.).
  - Configured through:
    - CRP_STREAM_ACCOUNT
    - CRP_STREAM_TOKEN_ID (e.g. EUDemo)
    - CRP_STREAM_NETWORK (e.g. concordium:testnet)

Note: the extraction logic is intentionally conservative and will need to be revisited once Concordium / Boosty Labs publish a canonical PLT read pattern for the target token(s).

#### 3.3 PLT worker (stream processor)

- Entry point:
  - npm run crp:worker:demo
- Behavior:
  - Reads CRP_STREAM_* env vars:
    - CRP_STREAM_SOURCE=concordium
    - CRP_STREAM_POLL_MS
    - CRP_STREAM_NETWORK
    - CRP_STREAM_TOKEN_ID
    - CRP_STREAM_DRY_RUN
    - CRP_STREAM_START_HEIGHT / CRP_STREAM_MAX_TICKS
  - Uses the wallet-proxy-backed PLT source to:
    - Pull PLT events strictly above the last processed height.
    - Normalize them for DB insertion (block height, tx hash, from/to, amountMinor, decimals).
  - Writes into Postgres via crp_plt_events (once fully wired; stubbing is allowed while Concordium clarifies PLT read details).
- Current state:
  - Worker loop, logging, and env configuration are in place.
  - Event normalization and DB insertion path have been defined.
  - Actual PLT read-side still depends on reliable node/wallet-proxy behavior and final Concordium SDK guidance.

#### 3.4 Ops endpoints

- GET /health
  - Simple liveness check: “is the process up and serving HTTP?”
- GET /readyz
  - Readiness check:
    - Verifies Postgres connectivity (simple SELECT 1).
    - Verifies wallet-proxy connectivity by hitting its health/transaction endpoint.
  - Returns detailed JSON with:
    - ok, dbOk, walletProxyOk
    - details.db, details.walletProxy (e.g. "ok", "timeout", "http_503", etc.).
  - Intended to return HTTP 503 when DB or wallet-proxy are unavailable or timing out.
- GET /metrics
  - In-memory metrics (current focus: /readyz):
    - readyz.totalChecks
    - readyz.success
    - readyz.dbFailures
    - readyz.walletProxyFailures
  - Counters reset on process restart (no persistent metrics store yet).

#### 3.5 CRP payments routes

Mounted under /v1/crp via src/routes/crp.payments.ts:

- GET /v1/crp/payments/search
  - Filters: merchantId, network, tokenId, payTo, status, limit.
  - Returns matches from Postgres (e.g. demo PLT payments in usd:test).
- POST /v1/crp/payments/match
  - Exact-tuple match on:
    - merchantId, nonce, network, asset (type, tokenId, decimals), amount, payTo.
  - Returns:
    - ok: true / false
    - reason: "exact_match" or "no_match"
    - count and optional match payload.
- POST /v1/crp/payments/fulfill
  - Same matching behavior as /payments/match.
  - Additionally:
    - Looks up a merchant-specific webhook URL (env-based convention).
    - POSTs a payload when a match is found:
      - { kind: "crp.payment.fulfilled", payment: <matched record> }
    - Returns a webhook object describing configuration and outcome:
      - configured, attempted, ok, status, error (if any).

These endpoints provide the core gateway semantics needed for a CRP/x402-style payment processor, while remaining decoupled from any specific merchant implementation.

---

## 3. Exposed HTTP surface (summary)

Base URL (local dev): http://localhost:8080

Health and ops:

- GET /health
- GET /readyz
- GET /metrics

CRP core:

- GET /v1/crp/consensus
- GET /v1/crp/account/:address
- GET /v1/crp/plt/search

CRP payments:

- GET  /v1/crp/payments/search
- POST /v1/crp/payments/match
- POST /v1/crp/payments/fulfill

Worker (not HTTP):

- npm run crp:worker:demo

---

## 4. Known limitations and open questions

1) Concordium PLT read side is intentionally conservative
- Current implementation makes wallet-proxy calls and provides a normalized shape for PLT events.
- Exact event decoding, filtering, and height/cursor semantics may need to be updated once Concordium or Boosty Labs publish a canonical approach for EUDemo or target PLTs.
- Node / wallet-proxy timeouts and 503s are still common on testnet and must be expected by any integration.

2) Metrics are in-memory only
- /metrics is useful for basic operational visibility (especially around /readyz), but:
  - Counters reset on process restart.
  - No Prometheus or OpenTelemetry integration yet.

3) Webhooks are best-effort
- Webhook behavior is driven by env variables and simple POST semantics.
- There is no retry queue, DLQ, or persistent webhook log at this stage.
- Merchant systems must be prepared for at-least-once or missed webhook notifications in edge cases.

4) No full-blown “payment state machine” yet
- CRP payment status is represented at the DB level, and the API exposes basic states like fulfilled.
- A richer state machine (e.g. pending, expired, failed, refunded) could be added in a later milestone.

---

## 5. How to run it (quick-start for new devs)

Prerequisites:

- Node.js and npm installed.
- Docker running with:
  - xcf-pg (Postgres)
  - transaction-logger
  - wallet-proxy
- .env configured (or based on .env.example) with:
  - Concordium gRPC config
  - JWS signing keys
  - Wallet-proxy config
  - CRP stream config (account, network, PLT tokenId)

Steps:

1) Clone the repo and install dependencies

  cd ~/Documents/GitHub/xcf-concordium-facilitator
  npm install

2) Ensure Postgres and supporting containers are running

  docker ps --format "table {{.Names}}	{{.Status}}	{{.Ports}}" | sed -n '1,10p'

3) Build and start the facilitator

  npm run build
  npm start

4) Basic smoke checks

  curl -s "http://localhost:8080/health" | jq .
  curl -s "http://localhost:8080/readyz" | jq .
  curl -s "http://localhost:8080/metrics" | jq .

5) CRP payments smoke

  curl -s "http://localhost:8080/v1/crp/payments/search?limit=5" | jq .

---

## 6. Suggested next steps (post-M3)

For the next owner / team, recommended directions:

- Finalize PLT read-side integration
  - Align with Concordium/Boosty on:
    - Canonical node RPC methods to use.
    - PLT event encoding and filtering patterns for EUDemo and target PLTs.
  - Harden the PLT worker’s extraction logic and DB schema accordingly.

- Enhance observability
  - Convert /metrics data into a Prometheus-friendly format.
  - Add more granular metrics (per-route latencies, PLT worker stats, webhook outcomes).
  - Consider structured logs that can be shipped to centralized log management.

- Harden webhooks and payment lifecycle
  - Formalize a payment state machine with explicit transitions.
  - Introduce retryable webhook queues and DLQ patterns.
  - Add idempotent webhook handling guidance for merchants.

- Expand test coverage and automation
  - Add end-to-end tests covering:
    - Wallet-proxy integration and PLT worker behavior.
    - Payment match/fulfill against realistic data sets.
  - Automate smoke tests in CI using docker-compose.

This concludes the M3 hand-off for the XCF Concordium Facilitator.
