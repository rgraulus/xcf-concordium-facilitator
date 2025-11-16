#!/usr/bin/env bash
set -u

BASE_URL="${CRP_BASE_URL:-http://localhost:8080}"
MERCHANT_ID="${CRP_MERCHANT_ID:-demo-merchant}"
NETWORK="${CRP_NETWORK:-concordium:testnet}"
TOKEN_ID="${CRP_TOKEN_ID:-usd:test}"
PAY_TO="${CRP_PAY_TO:-ccd1qexampleaddress}"
STATUS="${CRP_STATUS:-fulfilled}"

echo "== CRP ↔ Gateway Contract Smoke =="
echo "Base URL:     $BASE_URL"
echo "Merchant ID:  $MERCHANT_ID"
echo "Network:      $NETWORK"
echo "Token ID:     $TOKEN_ID"
echo "Pay To:       $PAY_TO"
echo "Status:       $STATUS"
echo

echo "-- Step 1: GET /v1/crp/payments/search (sample fulfilled payment)"

SEARCH_URL="${BASE_URL}/v1/crp/payments/search?merchantId=${MERCHANT_ID}&network=${NETWORK}&tokenId=${TOKEN_ID}&payTo=${PAY_TO}&status=${STATUS}&limit=1"

SEARCH_JSON="$(curl -sS "$SEARCH_URL" || echo "")"

if [ -z "$SEARCH_JSON" ]; then
  echo "ERROR: empty response from $SEARCH_URL"
  exit 1
fi

# Save raw response for debugging
echo "$SEARCH_JSON" > .crp-gateway-raw.json

# Use Node to transform raw search JSON into a gateway-style tuple.
node <<'NODEEOF'
const fs = require("fs");

try {
  const raw = fs.readFileSync(".crp-gateway-raw.json", "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || !Array.isArray(parsed.matches) || parsed.matches.length === 0) {
    console.error("No matches in response; cannot build sample.");
    process.exit(1);
  }

  const m = parsed.matches[0];

  const sample = {
    merchantId: m.merchant_id,
    nonce: m.nonce,
    network: m.network,
    asset: m.asset,
    amount: m.amount,
    payTo: m.pay_to,
  };

  fs.writeFileSync(".crp-gateway-sample.json", JSON.stringify(sample, null, 2));
  console.error("Wrote .crp-gateway-sample.json");
} catch (err) {
  console.error("Failed to parse/transform JSON:", err && err.message ? err.message : String(err));
  process.exit(1);
}
NODEEOF

if [ ! -f .crp-gateway-sample.json ]; then
  echo "ERROR: .crp-gateway-sample.json was not created; aborting."
  echo "Check .crp-gateway-raw.json for the raw API response."
  exit 1
fi

echo
echo "-- Step 2: POST /v1/crp/payments/match (exact tuple)"

curl -sS -X POST "${BASE_URL}/v1/crp/payments/match" \
  -H "content-type: application/json" \
  --data-binary "@.crp-gateway-sample.json"
echo
echo

echo "-- Step 3: POST /v1/crp/payments/fulfill (exact tuple + webhook)"

curl -sS -X POST "${BASE_URL}/v1/crp/payments/fulfill" \
  -H "content-type: application/json" \
  --data-binary "@.crp-gateway-sample.json"
echo
