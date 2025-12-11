#!/usr/bin/env bash
# scripts/infra-smoke.sh
#
# One-button XCF infra check:
# - XCF facilitator /healthz + /readyz
# - Public testnet via @concordium/web-sdk
# - Local P9 node via @concordium/web-sdk (concordium-local-stack)
# - Optional: xcf-pg.transaction-outcome.summaries row count

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"

banner() {
  echo
  echo "== $1 =="
}

echo
echo "########################################################"
echo "# XCF Infra Smoke (facilitator + public + local P9)    #"
echo "########################################################"
echo

########################################
# 1) XCF facilitator health / readiness
########################################
banner "1) XCF facilitator /healthz and /readyz (${BASE_URL})"

echo "-- /healthz"
curl -s "${BASE_URL}/healthz" | jq .

echo "-- /readyz"
curl -s "${BASE_URL}/readyz" | jq .

########################################
# 2) Public testnet via @concordium/web-sdk
########################################
banner "2) Public Concordium testnet probe (grpc.testnet.concordium.com:20000)"

npm run probe:web-sdk

########################################
# 3) Local P9 node (concordium-local-stack)
########################################
banner "3) Local P9 node probe (127.0.0.1:20100)"

npm run probe:web-sdk:local

########################################
# 4) Optional: xcf-pg transaction-outcome.summaries
########################################
banner "4) xcf-pg transaction-outcome.summaries row count (best effort)"

if docker ps --format '{{.Names}}' | grep -q '^xcf-pg$'; then
  docker exec xcf-pg psql -U postgres -d transaction-outcome \
    -c "SELECT COUNT(*) FROM summaries;" || {
    echo "[WARN] Query to xcf-pg.transaction-outcome.summaries failed (psql error)."
  }
else
  echo "[WARN] xcf-pg container not running; skipping summaries row count."
fi

echo
echo "✅ XCF infra smoke completed."
echo
