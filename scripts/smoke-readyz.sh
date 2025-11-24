#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"

echo "== /readyz Smoke =="
echo "  BASE_URL = ${BASE_URL}"
echo

URL="${BASE_URL}/readyz"
echo "-- GET /readyz"
echo "   ${URL}"
echo

# Capture response + status
RESPONSE="$(curl -sS -w '\nHTTP_STATUS:%{http_code}\n' "${URL}")" || {
  echo "Request to /readyz failed"
  exit 1
}

HTTP_STATUS="$(echo "${RESPONSE}" | sed -n 's/^HTTP_STATUS://p')"
BODY="$(echo "${RESPONSE}" | sed '/^HTTP_STATUS:/d')"

echo "HTTP status: ${HTTP_STATUS}"
echo

# Pretty-print JSON if python is available; otherwise just echo raw body.
if command -v python >/dev/null 2>&1; then
  echo "${BODY}" | python -m json.tool || {
    echo "Raw body:"
    echo "${BODY}"
  }
else
  echo "${BODY}"
fi
