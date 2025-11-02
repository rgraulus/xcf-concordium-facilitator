#!/usr/bin/env bash
set -euo pipefail

# Generate a fresh nonce each run to avoid DB conflicts
NONCE="n-$(date +%s)"

# Build a payload in a temp file
PAYLOAD="$(mktemp 2>/dev/null || echo ./payload.$$)"
cat > "$PAYLOAD" <<JSON
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

echo "Using nonce: $NONCE"
echo
echo "A) Create (expect 201)"
curl -i -X POST http://localhost:8080/v1/challenges \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: demo-merchant" \
  --data-binary @"$PAYLOAD" | sed -n '1,10p'

echo
echo "B) Re-POST same payload (expect 200)"
curl -i -X POST http://localhost:8080/v1/challenges \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: demo-merchant" \
  --data-binary @"$PAYLOAD" | sed -n '1,10p'

# Make a conflicting copy (change amount)
PAYLOAD_CONFLICT="$(mktemp 2>/dev/null || echo ./payload_conflict.$$)"
sed 's/"25.00"/"30.00"/' "$PAYLOAD" > "$PAYLOAD_CONFLICT"

echo
echo "C) Same nonce, different payload (expect 409)"
curl -i -X POST http://localhost:8080/v1/challenges \
  -H "Content-Type: application/json" \
  -H "X-Merchant-Id: demo-merchant" \
  --data-binary @"$PAYLOAD_CONFLICT" | sed -n '1,10p'

echo
echo "D) Status probe (expect JSON with status=pending)"
curl -s "http://localhost:8080/v1/challenges/$NONCE/status" \
  -H "X-Merchant-Id: demo-merchant" | sed -n '1,5p'

# Cleanup temp files
rm -f "$PAYLOAD" "$PAYLOAD_CONFLICT" || true
