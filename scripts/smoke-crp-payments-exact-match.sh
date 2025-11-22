#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root (one level up from scripts/)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Base URL for the facilitator HTTP server (Fastify).
BASE_URL="${BASE_URL:-http://localhost:8080}"

# Tuple fields for the exact-match query.
# These defaults are just placeholders; you should override them
# with real values via environment variables once you have
# actual CRP payment records to match against.
CRP_MERCHANT_ID="${CRP_MERCHANT_ID:-demo-merchant}"
CRP_NONCE="${CRP_NONCE:-demo-nonce-001}"
CRP_NETWORK="${CRP_NETWORK:-concordium:testnet}"
CRP_TOKEN_ID="${CRP_TOKEN_ID:-usd:test}"
CRP_AMOUNT="${CRP_AMOUNT:-25.00}"
CRP_PAY_TO="${CRP_PAY_TO:-demo-payto}"
CRP_DECIMALS="${CRP_DECIMALS:-2}"
CRP_ASSET_TYPE="${CRP_ASSET_TYPE:-PLT}"

echo "== CRP Payments Exact-Match HTTP Smoke =="
echo "  BASE_URL          = ${BASE_URL}"
echo "  merchantId        = ${CRP_MERCHANT_ID}"
echo "  nonce             = ${CRP_NONCE}"
echo "  network           = ${CRP_NETWORK}"
echo "  tokenId           = ${CRP_TOKEN_ID}"
echo "  amount            = ${CRP_AMOUNT}"
echo "  payTo             = ${CRP_PAY_TO}"
echo "  decimals          = ${CRP_DECIMALS}"
echo "  assetType         = ${CRP_ASSET_TYPE}"
echo

ENDPOINT="/v1/crp/payments/exact-match"

# NOTE: we assume these values have no spaces or special chars that
# need URL-encoding. For real-world usage, you can tighten this with
# proper encoding if needed.
QUERY="merchantId=${CRP_MERCHANT_ID}"
QUERY="${QUERY}&nonce=${CRP_NONCE}"
QUERY="${QUERY}&network=${CRP_NETWORK}"
QUERY="${QUERY}&tokenId=${CRP_TOKEN_ID}"
QUERY="${QUERY}&amount=${CRP_AMOUNT}"
QUERY="${QUERY}&payTo=${CRP_PAY_TO}"
QUERY="${QUERY}&decimals=${CRP_DECIMALS}"
QUERY="${QUERY}&assetType=${CRP_ASSET_TYPE}"

URL="${BASE_URL}${ENDPOINT}?${QUERY}"

echo "-- GET ${ENDPOINT}"
echo "   ${URL}"
echo

# Use curl to get the JSON response.
# We append an HTTP_STATUS line so we can split status from body.
RESPONSE="$(curl -sS -w '\nHTTP_STATUS:%{http_code}\n' "${URL}")" || {
  echo "Request failed."
  exit 1;
}

HTTP_STATUS="$(echo "${RESPONSE}" | sed -n 's/^HTTP_STATUS://p')"
BODY="$(echo "${RESPONSE}" | sed '/^HTTP_STATUS:/d')"

echo "HTTP status: ${HTTP_STATUS}"
echo

# Pretty-print JSON if python is available, otherwise print raw.
if command -v python >/dev/null 2>&1; then
  echo "${BODY}" | python -m json.tool || {
    echo "Raw body:"
    echo "${BODY}"
  }
else
  echo "${BODY}"
fi
