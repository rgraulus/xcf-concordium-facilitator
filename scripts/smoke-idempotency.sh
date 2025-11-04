#!/usr/bin/env bash
set -euo pipefail
NONCE="n-$(date +%s)"
cat > /tmp/payload_ok.json <<JSON
{
  "nonce": "$NONCE",
  "network": "concordium:testnet",
  "asset": { "type": "PLT", "tokenId": "usd:test", "decimals": 2 },
  "amount": "25.00",
  "pay_to": "ccd1qexampleaddress",
  "expiry": "2025-11-02T12:00:00Z",
  "policy": {},
  "metadata": {}
}
JSON

echo "Using NONCE: $NONCE"

# 201 then 200
curl -s -o /dev/null -w "create %{http_code}\n" \
  -X POST http://localhost:8080/v1/challenges \
  -H "Content-Type: application/json" -H "X-Merchant-Id: demo-merchant" \
  --data-binary @/tmp/payload_ok.json
curl -s -o /dev/null -w "idem %{http_code}\n" \
  -X POST http://localhost:8080/v1/challenges \
  -H "Content-Type: application/json" -H "X-Merchant-Id: demo-merchant" \
  --data-binary @/tmp/payload_ok.json

# 409
sed 's/"25.00"/"30.00"/' /tmp/payload_ok.json > /tmp/payload_bad.json
curl -s -o /dev/null -w "conflict %{http_code}\n" \
  -X POST http://localhost:8080/v1/challenges \
  -H "Content-Type: application/json" -H "X-Merchant-Id: demo-merchant" \
  --data-binary @/tmp/payload_bad.json

# fulfill -> /tmp/fulfill.json
curl -s -X POST http://localhost:8080/v1/admin/fulfill \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON > /tmp/fulfill.json
{
  "merchant_id": "demo-merchant",
  "nonce": "$NONCE",
  "receipt": {
    "nonce": "$NONCE",
    "amount": "25.00",
    "network": "concordium:testnet",
    "asset": { "type": "PLT", "tokenId": "usd:test", "decimals": 2 },
    "paidTo": "ccd1qexampleaddress",
    "finalizedAt": "$(date -u +%FT%TZ)"
  }
}
JSON

# extract JWS without jq
JWS=$(awk -v RS= -v ORS= 'match($0, /"jws":"([^"]+)"/, m) { print m[1] }' /tmp/fulfill.json)
echo "jws_len $(printf %s "$JWS" | wc -c)"

# verify
curl -s -X POST http://localhost:8080/v1/verify \
  -H "Content-Type: application/json" \
  --data "{\"jws\":\"$JWS\"}" | tr -d '\n'; echo
