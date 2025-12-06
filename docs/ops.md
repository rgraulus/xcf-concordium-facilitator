# XCF Concordium Facilitator – Ops & Dev Notes (M3)

This document summarizes how to run, monitor, and smoke-test the XCF Concordium Facilitator in the current M3 state.

It is written for local dev and early ops; paths and ports assume a single developer machine running Docker and Node.

---

## 1. Components Overview

The system currently uses these main components:

- Postgres (xcf-pg)
  - Stores:
    - CRP payment records (e.g. crp_payments).
    - PLT transfer events (via the M3 worker).
    - Transaction logger data (transaction-outcome DB).
- Transaction logger (concordium/transaction-logger)
  - Connects to a Concordium node (testnet).
  - Writes summarized transaction/PLT data into the transaction-outcome database.
- Concordium wallet-proxy (concordium/wallet-proxy)
  - HTTP façade to a Concordium node.
  - Used by XCF to:
    - Inspect account transaction history (/v3/accTransactions).
    - Power the M3 PLT stream worker.
- XCF Concordium Facilitator (this service)
  - Node/TypeScript + Fastify HTTP server.
  - Exposes:
    - /health
    - /readyz
    - /metrics
    - /v1/crp/* (CRP core + PLT search + payments)
  - Runs a PLT worker (via npm run crp:worker:demo in M3).

---

## 2. Databases and Containers

### Postgres (xcf-pg)

Assumed Docker container:

- Name: xcf-pg
- Host (from host machine): 127.0.0.1
- Port: 5432
- Connection string (for XCF main DB):

  - postgres://postgres:pg@127.0.0.1:5432/postgres

- Transaction logger DB:

  - dbname=transaction-outcome in the same Postgres instance.

Useful check:

  docker ps --format "table {{.Names}}	{{.Status}}	{{.Ports}}" | sed -n '1,10p'

You should see something like:

- xcf-pg with 0.0.0.0:5432->5432/tcp

---

### Transaction logger

Image: concordium/transaction-logger:0.11.0

Example local run (adjust as needed):

  docker run --rm \
    --name xcf-tx-logger \
    concordium/transaction-logger:0.11.0 \
    --db "host=host.docker.internal dbname=transaction-outcome user=postgres password=pg port=5432" \
    --node "http://node.testnet.concordium.com:20000" \
    --log-level info \
    --num-parallel 4

Key behavior:

- On first run, will apply DB migrations to transaction-outcome.
- Then continuously scans the testnet node and writes summaries into Postgres.

---

### Wallet-proxy

Image: concordium/wallet-proxy:0.43.0 (version may change later).

Typical local run:

- Container name: xcf-wallet-proxy
- Port: 3000 on host
- DB config pointing at transaction-outcome in xcf-pg

Health check:

  curl -s "http://localhost:3000/v0/health" | jq .

Notes:

- healthy: false with a message like
  "Could not get response from GRPC." is usually due to Concordium testnet node load / timeout.
- This can also surface in XCF via /readyz and worker logs.

---

## 3. XCF Environment Variables (local dev)

The .env file in this repo is used by:

- The HTTP server (npm start).
- The PLT stream worker (npm run crp:worker:demo).

Key variables (current M3 shape):

- Concordium gRPC (M2 wiring):

  - CONCORDIUM_GRPC_HOST=grpc.testnet.concordium.com
  - CONCORDIUM_GRPC_PORT=20000
  - CONCORDIUM_GRPC_TLS=true
  - CONCORDIUM_NETWORK=testnet

- JWKS / JWS signing (for payment receipts):

  - JWS_PRIVATE_KEY_BASE64=... (Ed25519 PKCS#8 private key, base64)
  - JWS_KID=kid-dev-1
  - JWS_ALG=EdDSA

- Wallet-proxy:

  - WALLET_PROXY_BASE_URL=http://localhost:3000
  - WALLET_PROXY_TIMEOUT_MS=15000
  - WALLET_PROXY_MAX_RETRIES=2

- CRP stream / PLT worker (M3):

  - CRP_STREAM_SOURCE=concordium
  - CRP_STREAM_POLL_MS=1000
  - CRP_STREAM_NETWORK=concordium:testnet
  - CRP_STREAM_TOKEN_ID=EUDemo (matches Concordium EUDemo PLT)
  - CRP_STREAM_DRY_RUN=false
  - CRP_STREAM_START_HEIGHT=0
  - CRP_STREAM_MAX_TICKS=3
  - CONCORDIUM_NODE_URL=http://localhost:9095 (placeholder for future node bridge)
  - CRP_STREAM_ACCOUNT=<testnet account address> (wallet-proxy account to scan)

---

## 4. Starting the Facilitator (local)

From the repo root:

  cd ~/Documents/GitHub/xcf-concordium-facilitator

  npm install   # first time only
  npm run build
  npm start

Expected logs:

- A line showing the DB connection string:

  - [DB] Using postgres://postgres:pg@127.0.0.1:5432/postgres

- Server listening:

  - Server listening at http://127.0.0.1:8080
  - Server listening at http://0.0.0.0:8080 (host/port info)

- And a final:

  - [DB] Connected to postgres 172.17.0.2 5432 (or similar Docker IP)

---

## 5. Core Health & Ops Endpoints

All paths assume http://localhost:8080.

### 5.1 /health

Simple liveness check:

  curl -s "http://localhost:8080/health" | jq .

Used mainly for “is the process up?” checks.

---

### 5.2 /readyz

Operational readiness check:

  curl -s "http://localhost:8080/readyz" | jq .

Example successful shape:

- ok: true
- dbOk: true
- walletProxyOk: true (or "skipped" if disabled)
- details with human-readable reasons.

Example when wallet-proxy or testnet is flaky:

- ok: false
- dbOk: true
- walletProxyOk: false
- details.walletProxy might be "timeout" or a http_503 message.

This endpoint is designed so that:

- If DB is down or misconfigured -> returns 503.
- If wallet-proxy is unreachable or timing out -> returns 503.

---

### 5.3 /metrics

In-memory metrics snapshot:

  curl -s "http://localhost:8080/metrics" | jq .

Current metrics focus on /readyz:

- readyz.totalChecks
- readyz.success
- readyz.dbFailures
- readyz.walletProxyFailures

Example:

  {
    "readyz": {
      "totalChecks": 2,
      "success": 0,
      "dbFailures": 0,
      "walletProxyFailures": 2
    }
  }

These counters are reset on process restart (in-memory only).

---

## 6. CRP Routes

All under the /v1/crp prefix.

### 6.1 Consensus read

Example:

  curl -s "http://localhost:8080/v1/crp/consensus" | jq .

Returns testnet consensus info based on the current Concordium wiring.

---

### 6.2 Account read

Shape depends on the CRP contract; used to look up account-level info via Concordium.

Example (using a dummy/test account):

  ACCOUNT="ccd1qexampleaddress"
  curl -s "http://localhost:8080/v1/crp/account/${ACCOUNT}" | jq .

---

### 6.3 PLT search

Backed by Postgres PLT events table (populated by the worker, once wired fully).

Example:

  curl -s "http://localhost:8080/v1/crp/plt/search" | jq .

Current data may be empty or stubbed depending on M3 wiring and node-side support.

---

## 7. CRP Payments Endpoints

Mounted under /v1/crp via src/routes/crp.payments.ts.

### 7.1 Search

  curl -s "http://localhost:8080/v1/crp/payments/search?limit=5" | jq .

Supports optional filters:

- merchantId
- network
- tokenId
- payTo
- status
- limit

Returns:

- ok: true
- filters (applied)
- matches array with payment records from Postgres (e.g. PLT usd:test demo data).

---

### 7.2 Match

Exact-tuple match, read-only:

  curl -s "http://localhost:8080/v1/crp/payments/match" \
    -H "Content-Type: application/json" \
    -d '{
      "merchantId": "demo-merchant",
      "nonce": "demo-nonce",
      "network": "concordium:testnet",
      "asset": {
        "type": "PLT",
        "tokenId": "usd:test",
        "decimals": 2
      },
      "amount": "25.00",
      "payTo": "ccd1qexampleaddress"
    }' | jq .

Responses:

- On match: ok: true, reason: "exact_match", count: 1, match.
- On no-match: ok: false, reason: "no_match", count: 0.

---

### 7.3 Fulfill (with webhook)

Same tuple as /payments/match, but intended as the “fulfill” entrypoint:

  curl -s "http://localhost:8080/v1/crp/payments/fulfill" \
    -H "Content-Type: application/json" \
    -d '{
      "merchantId": "demo-merchant",
      "nonce": "demo-nonce",
      "network": "concordium:testnet",
      "asset": {
        "type": "PLT",
        "tokenId": "usd:test",
        "decimals": 2
      },
      "amount": "25.00",
      "payTo": "ccd1qexampleaddress"
    }' | jq .

Response includes a webhook block describing:

- Whether a webhook URL was configured.
- Whether a POST was attempted.
- Whether it succeeded (2xx) or failed.

For non-existing tuples, expect:

- ok: false
- reason: "no_match"
- webhook.configured: false

---

## 8. PLT Stream Worker (M3)

Entry point:

  cd ~/Documents/GitHub/xcf-concordium-facilitator

  npm run crp:worker:demo

Behavior:

- Reads worker config from .env (CRP_STREAM_* vars).
- Uses the wallet-proxy-backed Concordium PLT source.
- Periodically polls for PLT events for the configured account/token.
- Writes normalized events into Postgres (when fully wired in future slices).

Current M3 state:

- Worker shape and wiring are in place.
- Real PLT event extraction will be finalized once Concordium/Boosty guidance on PLT read-side is available (gRPC or JSON-RPC patterns).

---

## 9. Troubleshooting Notes

- If /readyz returns walletProxyOk: false with reason: "timeout" or HTTP 503:
  - Check xcf-wallet-proxy logs.
  - Check Concordium node health (testnet may be slow or overloaded).
- If /readyz returns dbOk: false:
  - Verify xcf-pg is running.
  - Confirm DATABASE_URL and Postgres credentials.
- If /metrics shows many walletProxyFailures:
  - Expect some noise when testnet is under load.
  - This does not necessarily mean XCF itself is misconfigured.

---

## 10. Next Steps (beyond M3)

Planned / potential next steps:

- Harden PLT event parsing once Concordium SDK and node patterns are confirmed.
- Persist and expose more detailed metrics (Prometheus, OpenTelemetry).
- Tighten CRP payment state machine and webhook contracts.
- Add higher-level integration tests / smoke scripts.
