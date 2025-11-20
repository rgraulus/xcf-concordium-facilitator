#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"

echo "== CRP PLT Join Demo Smoke =="
echo "Base URL: ${BASE_URL}"
echo

echo "-- /v1/crp/plt/match-demo"
curl -s "${BASE_URL}/v1/crp/plt/match-demo" | jq .
echo
