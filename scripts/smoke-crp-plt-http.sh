#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root (one level up from scripts/)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Base URL for the facilitator HTTP server.
# Default: http://localhost:8080
BASE_URL="${BASE_URL:-http://localhost:8080}"

echo "== CRP PLT HTTP Search Smoke =="
echo "  BASE_URL = ${BASE_URL}"
echo

# Endpoint: PLT search (M3 read path)
PLT_SEARCH_PATH="/v1/crp/plt/search"

echo "-- GET ${PLT_SEARCH_PATH}"
echo

# We don't pass any filters yet; we just want to see
# what the server returns for a bare search.
HTTP_URL="${BASE_URL}${PLT_SEARCH_PATH}"

# Use curl to get the JSON response.
# If python is available, pretty-print; otherwise just echo.
RESPONSE="$(curl -sS -w '\nHTTP_STATUS:%{http_code}\n' "${HTTP_URL}")" || {
  echo "Request failed."
  exit 1
}

HTTP_STATUS="$(echo "${RESPONSE}" | sed -n 's/^HTTP_STATUS://p')"
BODY="$(echo "${RESPONSE}" | sed '/^HTTP_STATUS:/d')"

echo "HTTP status: ${HTTP_STATUS}"
echo

if command -v python >/dev/null 2>&1; then
  echo "${BODY}" | python -m json.tool || {
    echo "Raw body:"
    echo "${BODY}"
  }
else
  echo "${BODY}"
fi
