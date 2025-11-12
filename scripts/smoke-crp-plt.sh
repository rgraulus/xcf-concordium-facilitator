#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
TOKEN_ID="${TOKEN_ID:-}"   # optional, e.g. usd:test
LIMIT="${LIMIT:-25}"       # default 25

echo "== CRP PLT Search Smoke =="
echo "Base URL: $BASE_URL"
echo

echo "-- /v1/crp/payments/search (no filters, default limit)"
curl -sS "$BASE_URL/v1/crp/payments/search" | python -m json.tool || true
echo

# Build querystring only if values are provided
qs=()
[[ -n "$TOKEN_ID" ]] && qs+=("tokenId=$(printf %s "$TOKEN_ID")")
[[ -n "$LIMIT" ]] && qs+=("limit=$(printf %s "$LIMIT")")
qs_joined=""
if (( ${#qs[@]} )); then
  IFS='&' read -r -d '' qs_joined <<<"${qs[*]}"$'\0'
fi

echo "-- /v1/crp/payments/search?${qs_joined:-tokenId=&limit=1} (example)"
curl -sS "$BASE_URL/v1/crp/payments/search${qs_joined:+?${qs_joined}}" | python -m json.tool || true
echo
