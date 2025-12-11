# XCF Concordium Local P9 Infra Baseline (INFRA-LOCALNET)

This document captures the **local infrastructure baseline** used by the XCF Concordium Facilitator (CRP plugin) on this machine.  
It is meant as a **repeatable recipe** so another developer can reproduce the same setup from scratch.

The baseline includes:

- A dedicated **PostgreSQL 16** instance (Docker) for:
  - The **`transaction-outcome`** database populated by Concordium's transaction-logger.
  - XCF’s own Postgres database (currently using the default `postgres` DB for CRP/UFX tables).
- A **local Concordium P9 node stack** (`concordium-local-stack`) that runs:
  - `local-node` (Concordium node, protocol P9)
  - `wallet-proxy` (v0.41.1-0)
  - `transaction-logger` (v0.14.0)
  - `localccd-postgres` & `pgadmin` for the local explorer stack
  - `ccdscan` and Web3ID helpers
- The **XCF Concordium Facilitator** (`xcf-concordium-facilitator`) running on `localhost:8080`.
- Two **web-sdk connectivity probes** (public testnet + local node) living in the XCF repo.

---

## 1. Prerequisites

You should have the following installed on the host:

- **Docker Desktop** (with Linux containers)
- **Git** + **Git Bash** (on Windows)
- **Node.js 22.x** and npm
- **curl** and **jq** in your shell
- **Concordium client** (`concordium-client`) available on `PATH`

Quick sanity for `concordium-client`:

```bash
concordium-client --version
# e.g. 9.1.4
```

> All commands below are shown from **Git Bash** unless otherwise noted.

---

## 2. XCF Postgres container (`xcf-pg`)

We run a dedicated Postgres 16 container named **`xcf-pg`** with a Docker volume named **`xcf-pg-data`**.

### 2.1 Check containers & volumes

```bash
docker ps
docker volume ls
```

Example output:

```text
CONTAINER ID   IMAGE         COMMAND                  CREATED        STATUS       PORTS                                         NAMES
98a5c6768356   postgres:16   "docker-entrypoint.s…"   11 hours ago   Up 2 hours   0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp   xcf-pg

DRIVER    VOLUME NAME
local     xcf-pg-data
```

If `xcf-pg` is not running, you can recreate/start it with something like:

```bash
docker run -d --name xcf-pg   -e POSTGRES_PASSWORD=pg   -p 5432:5432   -v xcf-pg-data:/var/lib/postgresql/data   postgres:16
```

### 2.2 Confirm `transaction-outcome` schema

The Concordium `transaction-logger` writes into a database named **`transaction-outcome`** inside this container.

List tables:

```bash
docker exec xcf-pg psql -U postgres -d transaction-outcome -c "\dt"
```

Example output:

```text
            List of relations
 Schema |    Name     | Type  |  Owner
--------+-------------+-------+----------
 public | ati         | table | postgres
 public | cis2_tokens | table | postgres
 public | cti         | table | postgres
 public | migrations  | table | postgres
 public | summaries   | table | postgres
(5 rows)
```

Sanity-check row count in `summaries`:

```bash
docker exec xcf-pg psql -U postgres -d transaction-outcome   -c "SELECT COUNT(*) FROM summaries;"
```

Example (current baseline):

```text
 count
--------
 513948
(1 row)
```

This confirms `transaction-logger` has fully populated the local chain data into `transaction-outcome`.

---

## 3. Local Concordium stack (`concordium-local-stack`)

We use the official **`concordium-local-stack`** repository to run a full local Concordium P9 stack.

### 3.1 Clone & initialise

```bash
cd ~/Documents/GitHub
git clone https://github.com/Concordium/concordium-local-stack.git
cd concordium-local-stack

chmod +x ./initialise.sh
./initialise.sh
```

Example output (truncated):

```text
creating genesis for localnet
Deleting any existing directories.
Account keys will be generated in ./chain/accounts
...
The genesis data will be stored in ./chain/genesis.dat
The genesis hash will be written to ./chain/genesis_hash
DONE
...
Setting up wallet proxy config
Making wallet-proxy/ip-info.json
localccd-postgresql data directory already exists, skipping
```

### 3.2 Start the stack

From the `concordium-local-stack` repo:

```bash
cd ~/Documents/GitHub/concordium-local-stack
docker compose up -d
```

Check containers:

```bash
docker compose ps
```

Example:

```text
NAME                        IMAGE                                        COMMAND                  SERVICE                     CREATED         STATUS                   PORTS
ccdscan-api                 concordium/ccdscan-api:2.0.20                "/bin/sh -c 'sleep 2…"   ccdscan-api                 4 minutes ago   Up 3 minutes             0.0.0.0:7015->8000/tcp
ccdscan-frontend            concordium/ccdscan-frontend:1.7.25           "docker-entrypoint.s…"   ccdscan-frontend            4 minutes ago   Up 3 minutes             0.0.0.0:7016->3000/tcp
identity-provider-service   concordium/identity-provider-service:0.6.0   "/start.sh"              identity-provider-service   4 minutes ago   Up 4 minutes             0.0.0.0:7011->7011/tcp
identity-verifier           concordium/identity-provider-service:0.6.0   "/start.sh"              identity-verifier           4 minutes ago   Up 4 minutes             0.0.0.0:7012->7012/tcp
local-node                  concordium/testnet-node:9.0.7-3              "/concordium-node"       local-node                  4 minutes ago   Up 4 minutes             0.0.0.0:8169->8169/tcp, 0.0.0.0:20100->20100/tcp
localccd-postgres           postgres:16                                  "docker-entrypoint.s…"   localccd-postgres           4 minutes ago   Up 4 minutes (healthy)   5432/tcp
pgadmin                     dpage/pgadmin4:9.8.0                         "/entrypoint.sh"         pgadmin                     4 minutes ago   Up 3 minutes             0.0.0.0:8432->80/tcp
transaction-logger          concordium/transaction-logger:0.14.0         "transaction-logger"     transaction-logger          4 minutes ago   Up 3 minutes
wallet-proxy                concordium/wallet-proxy:0.41.1-0             "/docker-entrypoint.…"   wallet-proxy                4 minutes ago   Up 3 minutes             0.0.0.0:7013->3000/tcp
web3id-proof-explorer       concordium/proof-explorer:1.2.2              "/docker-entrypoint.…"   web3id-proof-explorer       4 minutes ago   Up 4 minutes             0.0.0.0:7018->80/tcp
web3id-verifier             concordium/web3id-verifier:0.7.0             "/bin/bash -c ' unti…"   web3id-verifier             4 minutes ago   Up 4 minutes             0.0.0.0:7017->8080/tcp
webserver                   nginx                                        "/docker-entrypoint.…"   webserver                   4 minutes ago   Up 4 minutes             0.0.0.0:7020->80/tcp
```

### 3.3 Confirm node is producing blocks

Use the local node’s gRPC interface (port `20100`) with `concordium-client`:

```bash
cd ~/Documents/GitHub/concordium-local-stack

concordium-client --grpc-ip 127.0.0.1 --grpc-port 20100 consensus status
```

Example output (truncated):

```text
Best block:                  5aedfc207e741d0623c0c687739229b0b056f053043fe536ab3050067a91b665
Genesis time:                2025-12-10 21:46:51.87 UTC
Best block height:           9683
Last finalized block height: 9682
...
Protocol version:            P9
Genesis index:               0
Current round:               9684
Current epoch:               2
```

As long as **`Best block height`** and **`Last finalized block height`** keep increasing over time, your local node is healthy and finalizing.

### 3.4 Verify wallet-proxy

Check the wallet-proxy health:

```bash
curl -s http://localhost:7013/v0/health | jq .
```

Example:

```json
{
  "healthy": true,
  "lastFinalTime": "2025-12-10T22:22:43.713Z",
  "version": "0.41.1"
}
```

And confirm `ip_info` (identity provider info) is exposed:

```bash
curl -s http://localhost:7013/v0/ip_info | head
```

You should see a large JSON array with `arsInfos` and `ipInfo`.

---

## 4. XCF Concordium Facilitator (CRP) service

The XCF CRP service (`xcf-concordium-facilitator`) is a Node/TypeScript Fastify server exposing:

- Health: `GET /healthz`
- Readiness: `GET /readyz`
- CRP consensus & account reads: `/v1/crp/*`

### 4.1 Start the server

In a fresh Git Bash terminal (**Terminal B**):

```bash
cd ~/Documents/GitHub/xcf-concordium-facilitator

npm install        # first time only, or when deps change
npm run build      # optional during dev; required for fresh clones
npm start
```

Example log:

```text
[DB] Using postgres://postgres:pg@127.0.0.1:5432/postgres
{"level":30,"msg":"Server listening at http://127.0.0.1:8080"}
...
[DB] Connected to postgres 172.17.0.2 5432
```

> Note: XCF connects to the Postgres service on `127.0.0.1:5432`. The `xcf-pg` container publishes port 5432 to the host, so this works even though Postgres itself is in Docker.

### 4.2 Core health checks

In another terminal (**Terminal C**):

```bash
cd ~/Documents/GitHub/xcf-concordium-facilitator

# Core health
curl -s http://localhost:8080/healthz | jq .

# Readiness
curl -s http://localhost:8080/readyz | jq .
```

With the baseline infra running, `healthz` should return:

```json
{ "ok": true }
```

And `readyz` should show both DB and wallet-proxy as **ok**:

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

### 4.3 CRP consensus endpoint

The CRP consensus route reads basic info from the **public Concordium testnet** via the new web-sdk client (`@concordium/web-sdk/nodejs`). This is slightly separate from the local P9 node used by `concordium-local-stack`, but both are useful during development.

Example:

```bash
curl -s http://localhost:8080/v1/crp/consensus | jq .
```

You should see something like:

```json
{
  "ok": true,
  "consensus": {
    "genesisIndex": 6
  },
  "blocks": {
    "best": {
      "hash": "",
      "height": ""
    },
    "finalized": {
      "hash": "",
      "height": ""
    }
  },
  "network": "testnet"
}
```

(The exact block hash/height wiring can evolve as we refine the web-sdk migration.)

---

## 5. Connectivity probes (public testnet & local P9)

XCF ships with two small helper probes that verify connectivity from this repo to Concordium nodes using the modern `@concordium/web-sdk/nodejs` client.

### 5.1 Public testnet probe

This checks connectivity to the **public Concordium testnet** gRPC v2 endpoint:

```bash
npm run probe:web-sdk
```

Expected example output:

```json
{
  "ok": true,
  "endpoint": "grpc.testnet.concordium.com:20000",
  "useTls": true,
  "health": {},
  "consensus": {
    "bestBlockHeight": "…",
    "lastFinalizedBlockHeight": "…",
    "genesisIndex": 6,
    "protocolVersion": "9"
  }
}
```

If `ok` is `true`, the web-sdk client can successfully talk to the public testnet node.

### 5.2 Local P9 node probe (`concordium-local-stack`)

When `concordium-local-stack` is running, you can verify connectivity to the **local P9 node** exposed on `127.0.0.1:20100` using the dedicated script:

```bash
npm run probe:web-sdk:local
```

Under the hood this is equivalent to:

```bash
cross-env   CONCORDIUM_GRPC_HOST=127.0.0.1   CONCORDIUM_GRPC_PORT=20100   CONCORDIUM_GRPC_TLS=0   ts-node scripts/web-sdk-probe.ts
```

Expected example output:

```json
{
  "ok": true,
  "endpoint": "127.0.0.1:20100",
  "useTls": false,
  "health": {},
  "consensus": {
    "bestBlockHeight": "…",
    "lastFinalizedBlockHeight": "…",
    "genesisIndex": 0,
    "protocolVersion": "9"
  }
}
```

If `ok` is `true`, XCF can reach the local Concordium node and read basic consensus info. This is a good quick check before running more advanced CRP / PLT flows or future local integration tests.

---

## 6. Quick recap: “happy path” from clean shell

1. Ensure Docker Desktop is running.
2. Start or verify the `xcf-pg` container:
   ```bash
   docker ps
   # or:
   docker run -d --name xcf-pg -e POSTGRES_PASSWORD=pg -p 5432:5432 -v xcf-pg-data:/var/lib/postgresql/data postgres:16
   ```
3. Start `concordium-local-stack`:
   ```bash
   cd ~/Documents/GitHub/concordium-local-stack
   docker compose up -d
   ```
4. Check the local node:
   ```bash
   concordium-client --grpc-ip 127.0.0.1 --grpc-port 20100 consensus status
   ```
5. Check wallet-proxy:
   ```bash
   curl -s http://localhost:7013/v0/health | jq .
   ```
6. Start XCF:
   ```bash
   cd ~/Documents/GitHub/xcf-concordium-facilitator
   npm install
   npm run build
   npm start
   ```
7. Verify XCF health:
   ```bash
   curl -s http://localhost:8080/healthz | jq .
   curl -s http://localhost:8080/readyz | jq .
   ```
8. Run connectivity probes:
   ```bash
   npm run probe:web-sdk         # public testnet
   npm run probe:web-sdk:local   # local P9 node
   ```

If all of the above return `ok: true`, you have a fully working **local P9 infra baseline** for XCF, ready for further CRP/PLT development and testing.
