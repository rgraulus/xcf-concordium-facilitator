#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
TOKEN_ID="${TOKEN_ID:-usd:test}"
TO_ADDR="${TO_ADDR:-demo-to-3}"
AMOUNT_MINOR="${AMOUNT_MINOR:-2500}"  # 25.00 with 2 decimals

echo "== CRP PLT Stream Smoke =="
echo "Base URL:      $BASE_URL"
echo "Token ID:      $TOKEN_ID"
echo "To (address):  $TO_ADDR"
echo "Amount (minor): $AMOUNT_MINOR"
echo

echo "-- /v1/crp/plt/search (recent transfers, no filters)"
curl -s "${BASE_URL}/v1/crp/plt/search?limit=10"
echo
echo

echo "-- /v1/crp/plt/search (exact tuple: tokenId + to + amountMinor)"
curl -s "${BASE_URL}/v1/crp/plt/search?tokenId=${TOKEN_ID}&to=${TO_ADDR}&amountMinor=${AMOUNT_MINOR}&limit=5"
echo
