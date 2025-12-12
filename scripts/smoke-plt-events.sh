#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${XCF_BASE_URL:-http://localhost:8080}"

echo "== PLT Events Smoke =="
echo "Base URL: ${BASE_URL}"
echo

# Feel free to tweak query params over time.
ASSET_ID="concordium:testnet:PLT:EUDemo"
LIMIT="${XCF_PLT_SMOKE_LIMIT:-5}"

echo "-- GET /v1/crp/plt/events?assetId=${ASSET_ID}&limit=${LIMIT}"
curl -s "${BASE_URL}/v1/crp/plt/events?assetId=${ASSET_ID}&limit=${LIMIT}" | jq .
echo
