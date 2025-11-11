#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
ACCOUNT="${1:-${ACCOUNT_ADDRESS:-ccd1qexampleaddress}}"

echo "== CRP Reads Smoke =="
echo "Base URL: ${BASE_URL}"
echo

echo "-- /v1/crp/consensus"
curl -s "${BASE_URL}/v1/crp/consensus" | python -m json.tool || {
  echo "Consensus request failed"; exit 1;
}
echo

echo "-- /v1/crp/account/:address"
echo "Address: ${ACCOUNT}"
curl -s -i "${BASE_URL}/v1/crp/account/${ACCOUNT}" | sed -n '1,5p'
echo
