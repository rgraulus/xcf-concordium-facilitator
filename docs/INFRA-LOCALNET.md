# XCF Local Infrastructure – P9 Localnet Baseline

This document describes how to bring up and operate the local Concordium
infrastructure used by the XCF Concordium Facilitator for development and
smoke testing.

It assumes:

- Docker Desktop is installed and configured to use the **D:** drive for data.
- Node.js and npm are installed.
- `concordium-client` and `genesis-creator` are installed and on your `PATH`.
- The following repositories are cloned under `~/Documents/GitHub`:
  - `xcf-concordium-facilitator`
  - `concordium-local-stack` (upstream Concordium repo)

---

## 1. Components

### 1.1 XCF Core Database

- **Container:** `xcf-pg`
- **Image:** `postgres:16`
- **Host port:** `5432`
- **Volume:** `xcf-pg-data`
- **Database of interest:** `transaction-outcome`

This database contains historical testnet data (`summaries`, `cis2_tokens`,
`ati`, `cti`, `migrations`) used by XCF for read-side queries.

### 1.2 XCF Facilitator Service

- **Repo:** `xcf-concordium-facilitator`
- **Runtime:** Node.js (TypeScript → compiled to `dist/`)
- **HTTP port:** `8080`
- **Key endpoints:**
  - `/healthz` – basic liveness check
  - `/readyz` – readiness: DB + Concordium wallet-proxy

The facilitator connects to:

- `xcf-pg` for database access
- Concordium **wallet-proxy** for account / PLT visibility

### 1.3 Concordium Local Stack (P9 Localnet)

- **Repo:** `concordium-local-stack`
- **Node container:** `local-node` (`concordium/testnet-node:9.0.7-3`)
  - gRPC: `127.0.0.1:20100`
- **Wallet-proxy container:** `wallet-proxy`
  - HTTP: `http://localhost:7013`
  - Health: `GET /v0/health`
- **Local CCD Postgres:** `localccd-postgres`
- **Transaction logger:** `transaction-logger`
- **CCDScan:** `http://localhost:7016`
- **pgAdmin:** `http://localhost:8432`
- **PLT metadata webserver:** `http://localhost:7020`

These services are managed via `docker compose` in the `concordium-local-stack`
directory.

---

## 2. One-time Setup (already completed on lead dev machine)

> This section documents what has already been done once, for reference or for
> setting up a new machine.

1. **Clone the Concordium local stack**

   ```bash
   cd ~/Documents/GitHub
   git clone https://github.com/Concordium/concordium-local-stack.git
   cd concordium-local-stack
   ```

2. **Install CLI tools**

   - Install `concordium-client` (Windows binary) and ensure:

     ```bash
     concordium-client --version
     # e.g. 9.1.4
     ```

   - Install Rust + Cargo, then:

     ```bash
     cargo install --git https://github.com/Concordium/concordium-misc-tools genesis-creator
     genesis-creator --version
     # e.g. 0.6.x
     ```

3. **Initialize the P9 localnet**

   ```bash
   cd ~/Documents/GitHub/concordium-local-stack
   chmod +x ./initialise.sh
   ./initialise.sh
   ```

   This generates:

   - Genesis data and accounts
   - Identity providers and anonymity revokers
   - Wallet-proxy configuration
   - Local node config and data directories

---

## 3. Day-to-day: Starting the Local Infra

From a cold start, the typical sequence is:

### 3.1 Start XCF Postgres (`xcf-pg`)

```bash
# start container (if not already running)
docker start xcf-pg

# optional: sanity check
docker ps
```

### 3.2 Start Concordium Local Stack

```bash
cd ~/Documents/GitHub/concordium-local-stack

# bring up the P9 localnet stack
docker compose up -d

# check status
docker compose ps
```

You should see containers like:

- `local-node`
- `wallet-proxy`
- `localccd-postgres`
- `transaction-logger`
- `ccdscan-frontend` / `ccdscan-api`
- `pgadmin`
- `webserver`

All in `Up` state.

Quick checks:

```bash
# Wallet-proxy health
curl -s http://localhost:7013/v0/health | jq .

# Node consensus status
concordium-client --grpc-ip 127.0.0.1 --grpc-port 20100 consensus status
```

### 3.3 Start XCF Facilitator

```bash
cd ~/Documents/GitHub/xcf-concordium-facilitator
npm start
```

Ensure XCF is configured with:

```ini
# .env
WALLET_PROXY_BASE_URL=http://localhost:7013
```

When the service starts you should see logs like:

```text
[DB] Using postgres://postgres:pg@127.0.0.1:5432/postgres
{"msg":"Server listening","port":8080,"host":"0.0.0.0", ...}
```

---

## 4. Health Checks

### 4.1 XCF Readiness

```bash
cd ~/Documents/GitHub/xcf-concordium-facilitator

# Scripted smoke test
npm run readyz

# Or raw curl
curl -s http://localhost:8080/readyz | jq .
```

Expected success response:

```json
{
  "ok": true,
  "dbOk": true,
  "walletProxyOk": true,
  "details": {
    "db": "ok",
    "walletProxy": "ok"
  }
}
```

If `walletProxyOk` is `false`, check:

- Is `concordium-local-stack` running? (`docker compose ps`)
- Is `WALLET_PROXY_BASE_URL` set correctly in `.env`?
- Does `curl -s http://localhost:7013/v0/health | jq .` return `{ "healthy": true, ... }`?

### 4.2 Node and Wallet-proxy

```bash
# Node
concordium-client --grpc-ip 127.0.0.1 --grpc-port 20100 consensus status

# Wallet-proxy health
curl -s http://localhost:7013/v0/health | jq .
curl -s http://localhost:7013/v0/ip_info | head
```

---

## 5. Stopping the Infra

### 5.1 Stop XCF Facilitator

In the terminal where `npm start` is running: `Ctrl+C`.

### 5.2 Stop Concordium Local Stack

```bash
cd ~/Documents/GitHub/concordium-local-stack
docker compose down
```

### 5.3 Optionally stop XCF Postgres

```bash
docker stop xcf-pg
```

The Docker volumes (`xcf-pg-data`, `concordium-local-stack` volumes) preserve
data between runs.

---

## 6. Notes & Future Work

- **Current CRP & PLT reads** in XCF still use the public testnet node via the
  older `@concordium/node-sdk`.
- A future milestone (**M2.1**) will:
  - Migrate to `@concordium/web-sdk/nodejs`.
  - Point node access to `127.0.0.1:20100` (local P9 node).
  - Expose richer consensus and PLT information over XCF’s HTTP APIs.

For now, this document describes the baseline infrastructure setup that makes
`/readyz` green and supports wallet-proxy-driven flows for local development.
