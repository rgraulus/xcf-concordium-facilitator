#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"

echo "== CRP PLT Search Smoke =="
echo "Base URL: ${BASE_URL}"
echo

echo "-- /v1/crp/payments/search (no filters, default limit)"
curl -sS "${BASE_URL}/v1/crp/payments/search" | python -m json.tool || true
echo

echo "-- /v1/crp/payments/search?tokenId=usd:test&limit=1 (example)"
curl -sS "${BASE_URL}/v1/crp/payments/search?tokenId=usd:test&limit=1" | python -m json.tool || true
echo
