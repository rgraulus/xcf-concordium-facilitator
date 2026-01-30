#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3005}"
UPSTREAM_PORT="${UPSTREAM_PORT:-3010}"
NONCE="${NONCE:-bb-test}"

JWKS_HOST="${JWKS_HOST:-127.0.0.1}"
JWKS_PORT="${JWKS_PORT:-8088}"
WAIT_SECS="${WAIT_SECS:-60}"

# Default is to pause after ACTION REQUIRED
WAIT_FOR_USER="${WAIT_FOR_USER:-true}"

echo "[harness] BASE=$BASE"
echo "[harness] NONCE=$NONCE"
echo "[harness] expecting upstream on :$UPSTREAM_PORT"
echo "[harness] starting dev JWKS issuer on $JWKS_HOST:$JWKS_PORT ..."

TMP_HEADERS_1="$(mktemp)"
TMP_BODY_1="$(mktemp)"
TMP_HEADERS_2="$(mktemp)"
TMP_BODY_2="$(mktemp)"
TMP_HEADERS_3="$(mktemp)"
TMP_BODY_3="$(mktemp)"
TMP_ISSUER_LOG="$(mktemp)"
TMP_MINT_JSON="$(mktemp)"

ISSUER_PID=""

cleanup() {
  rm -f "$TMP_HEADERS_1" "$TMP_BODY_1" "$TMP_HEADERS_2" "$TMP_BODY_2" "$TMP_HEADERS_3" "$TMP_BODY_3" \
        "$TMP_ISSUER_LOG" "$TMP_MINT_JSON" || true
  if [[ -n "${ISSUER_PID}" ]]; then
    kill "${ISSUER_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Upstream must be running
curl -sS "http://127.0.0.1:${UPSTREAM_PORT}/" >/dev/null

# Start issuer in background
HOST="${JWKS_HOST}" PORT="${JWKS_PORT}" NONCE="${NONCE}" \
  node scripts/dev_jwks_server.mjs >"$TMP_ISSUER_LOG" 2>&1 &
ISSUER_PID=$!

JWKS_URL="http://${JWKS_HOST}:${JWKS_PORT}/.well-known/jwks.json"
MINT_BASE="http://${JWKS_HOST}:${JWKS_PORT}/mint"

# Wait for JWKS endpoint to respond
for _ in $(seq 1 100); do
  if curl -fsS "$JWKS_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! curl -fsS "$JWKS_URL" >/dev/null 2>&1; then
  echo
  echo "[harness] ERROR: JWKS issuer did not become ready at $JWKS_URL"
  echo "[harness] issuer log:"
  sed 's/^/  /' "$TMP_ISSUER_LOG" || true
  exit 1
fi

echo "[harness] JWKS_URL=$JWKS_URL"

# Helper: extract a header (case-insensitive) from a curl -i output headers file.
get_header() {
  local name="$1"
  grep -i -m1 "^${name}:" "$2" | sed -E "s/^${name}:[[:space:]]*//I" | tr -d '\r'
}

# Helper: base64(JSON({nonce})) for PAYMENT-SIGNATURE
payment_signature_b64() {
  NONCE="$NONCE" node -e 'process.stdout.write(Buffer.from(JSON.stringify({nonce:process.env.NONCE}),"utf8").toString("base64"))'
}

# --------------------------------------------------------------------
# Request #1: expect 402 + PAYMENT-REQUIRED (this gives us the contract)
# --------------------------------------------------------------------
URL1="${BASE}/x402/premium?nonce=${NONCE}"
echo "[harness] request #1 (expect 402): $URL1"
curl -sS -i "$URL1" -D "$TMP_HEADERS_1" -o "$TMP_BODY_1" >/dev/null || true

STATUS1="$(head -n1 "$TMP_HEADERS_1" | awk '{print $2}' | tr -d '\r')"
echo "[harness] status #1=$STATUS1"
if [[ "$STATUS1" != "402" ]]; then
  echo "Expected 402 on request #1"
  echo "--- headers ---"; cat "$TMP_HEADERS_1"
  echo "--- body ---"; cat "$TMP_BODY_1"
  exit 1
fi

PR_B64="$(get_header "PAYMENT-REQUIRED" "$TMP_HEADERS_1")"
if [[ -z "$PR_B64" ]]; then
  echo "Missing PAYMENT-REQUIRED header on request #1"
  echo "--- headers ---"; cat "$TMP_HEADERS_1"
  exit 1
fi

# Decode PAYMENT-REQUIRED b64 -> JSON and build mint URL
MINT_URL="$(
  PR_B64="$PR_B64" MINT_BASE="$MINT_BASE" node - <<'NODE'
function normalizeB64(s){
  s = String(s||"").trim().replace(/-/g,'+').replace(/_/g,'/');
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  return s;
}
const prB64 = process.env.PR_B64;
const mintBase = process.env.MINT_BASE;

const json = Buffer.from(normalizeB64(prB64), 'base64').toString('utf8');
const pr = JSON.parse(json);

const required = [
  pr.contractId, pr.contractVersion,
  pr.merchantId,
  pr.resource?.method, pr.resource?.path,
  pr.network,
  pr.asset?.tokenId,
  pr.asset?.decimals,
  pr.amount,
  pr.payTo,
  pr.nonce,
];
if (required.some(v => v === undefined || v === null || v === "")) {
  throw new Error("PAYMENT-REQUIRED missing required fields");
}
if (typeof pr.isFrozen !== "boolean") {
  throw new Error("PAYMENT-REQUIRED missing isFrozen boolean");
}

const u = new URL(mintBase);
u.searchParams.set('nonce', pr.nonce);
u.searchParams.set('contractId', pr.contractId);
u.searchParams.set('contractVersion', pr.contractVersion);
u.searchParams.set('isFrozen', String(pr.isFrozen));
u.searchParams.set('merchantId', pr.merchantId);
u.searchParams.set('method', String(pr.resource.method).toUpperCase());
u.searchParams.set('path', String(pr.resource.path));
u.searchParams.set('network', pr.network);
u.searchParams.set('tokenId', pr.asset.tokenId);
u.searchParams.set('decimals', String(pr.asset.decimals));
u.searchParams.set('amount', pr.amount);
u.searchParams.set('payTo', pr.payTo);

process.stdout.write(u.toString());
NODE
)"

echo "[harness] minting receipt via: $MINT_URL"
curl -fsS "$MINT_URL" > "$TMP_MINT_JSON"

RECEIPT_JWS="$(node -e 'const fs=require("fs"); const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(o.jws||"")' "$TMP_MINT_JSON")"
if [[ -z "$RECEIPT_JWS" ]]; then
  echo "[harness] ERROR: mint did not return jws"
  cat "$TMP_MINT_JSON"
  exit 1
fi
echo "[harness] got RECEIPT_JWS (len=${#RECEIPT_JWS})"

# --------------------------------------------------------------------
# ACTION REQUIRED: restart gateway with dev harness enabled
# --------------------------------------------------------------------
echo
echo "[harness] ACTION REQUIRED:"
echo "  Restart your gateway (Terminal A) with these env vars set:"
echo
cat <<EOF
  X402_ALLOW_DEV_HARNESS=true \\
  CRP_JWKS_URL="$JWKS_URL" \\
  X402_DEV_RECEIPT_JWS="$RECEIPT_JWS" \\
  X402_DEV_RECEIPT_REQUIRE_SIG=true \\
  npm run dev
EOF
echo

# Pause here so the gateway actually gets restarted with THIS receipt.
if [[ "$WAIT_FOR_USER" == "true" ]]; then
  echo "[harness] Pausing now. Restart the gateway in Terminal A, then press Enter to continue..."
  read -r _
fi

echo "[harness] Waiting up to ${WAIT_SECS}s for /healthz to report devHarness.enabled=true ..."

ok="false"
for _ in $(seq 1 $((WAIT_SECS * 10))); do
  if curl -fsS "${BASE}/healthz" 2>/dev/null | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{ try{
      const j=JSON.parse(d);
      process.exit(j?.devHarness?.enabled===true ? 0 : 1);
    }catch{process.exit(1)}});' >/dev/null 2>&1; then
    ok="true"
    break
  fi
  sleep 0.1
done

if [[ "$ok" != "true" ]]; then
  echo "[harness] ERROR: gateway did not report devHarness.enabled=true in time."
  exit 1
fi

echo "[harness] OK: gateway devHarness.enabled=true"

# --------------------------------------------------------------------
# Request #2: expect 200 + PAYMENT-RESPONSE + upstream body
# --------------------------------------------------------------------
SIG_B64="$(payment_signature_b64)"
URL2="${BASE}/x402/premium?nonce=${NONCE}"
echo "[harness] request #2 (expect 200 + proxy content): $URL2"
curl -sS -i -H "PAYMENT-SIGNATURE: ${SIG_B64}" "$URL2" -D "$TMP_HEADERS_2" -o "$TMP_BODY_2" >/dev/null || true

STATUS2="$(head -n1 "$TMP_HEADERS_2" | awk '{print $2}' | tr -d '\r')"
echo "[harness] status #2=$STATUS2"
if [[ "$STATUS2" != "200" ]]; then
  echo "Expected 200 on paid-path request"
  echo "--- headers ---"
  cat "$TMP_HEADERS_2"
  echo
  echo "--- body ---"
  cat "$TMP_BODY_2"
  exit 1
fi

RESP_B64="$(get_header "PAYMENT-RESPONSE" "$TMP_HEADERS_2")"
if [[ -z "$RESP_B64" ]]; then
  echo "Missing PAYMENT-RESPONSE header on request #2"
  echo "--- headers ---"; cat "$TMP_HEADERS_2"
  exit 1
fi

# Validate PAYMENT-RESPONSE decodes and contains the receipt.jws we minted
RESP_B64="$RESP_B64" RECEIPT_JWS="$RECEIPT_JWS" node - <<'NODE'
function normalizeB64(s){
  s = String(s||"").trim().replace(/-/g,'+').replace(/_/g,'/');
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  return s;
}
const respB64 = process.env.RESP_B64;
const want = process.env.RECEIPT_JWS;

const json = Buffer.from(normalizeB64(respB64), 'base64').toString('utf8');
const pr = JSON.parse(json);

const got = pr?.receipt?.jws || pr?.jws;
if (!got) {
  console.error("PAYMENT-RESPONSE missing receipt.jws");
  process.exit(1);
}
if (got !== want) {
  console.error("PAYMENT-RESPONSE receipt.jws mismatch");
  process.exit(1);
}
process.exit(0);
NODE

echo "[harness] PAYMENT-RESPONSE validated"

echo "[harness] body #2:"
sed 's/^/  /' "$TMP_BODY_2"

if ! grep -q "UPSTREAM_OK" "$TMP_BODY_2"; then
  echo "Expected upstream body to contain UPSTREAM_OK"
  exit 1
fi

echo "[harness] PASS: paid-path proxy worked + PAYMENT-RESPONSE validated"

# --------------------------------------------------------------------
# Request #3: Phase C replay test (repeat the same paid request)
# Expect 402 + PAYMENT-REQUIRED + replay error
# --------------------------------------------------------------------
URL3="$URL2"
echo "[harness] request #3 (Phase C replay, expect 402): $URL3"
curl -sS -i -H "PAYMENT-SIGNATURE: ${SIG_B64}" "$URL3" -D "$TMP_HEADERS_3" -o "$TMP_BODY_3" >/dev/null || true

STATUS3="$(head -n1 "$TMP_HEADERS_3" | awk '{print $2}' | tr -d '\r')"
echo "[harness] status #3=$STATUS3"
if [[ "$STATUS3" != "402" ]]; then
  echo "Expected 402 on replay request (#3)"
  echo "--- headers ---"; cat "$TMP_HEADERS_3"
  echo "--- body ---"; cat "$TMP_BODY_3"
  exit 1
fi

PR3="$(get_header "PAYMENT-REQUIRED" "$TMP_HEADERS_3")"
if [[ -z "$PR3" ]]; then
  echo "Missing PAYMENT-REQUIRED header on replay request (#3)"
  echo "--- headers ---"; cat "$TMP_HEADERS_3"
  exit 1
fi

if ! grep -q "Payment already claimed (replay)" "$TMP_BODY_3"; then
  echo "Expected replay response body to contain: Payment already claimed (replay)"
  echo "--- body ---"; cat "$TMP_BODY_3"
  exit 1
fi

echo "[harness] PASS: replay rejected with 402 + PAYMENT-REQUIRED"

echo "[harness] DONE"
