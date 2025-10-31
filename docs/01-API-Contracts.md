```md

\# XCF (UFX + CRP) — API Contracts



\*\*Scope:\*\* Public API for the Universal x402 Facilitator (UFX).  

\*\*Note:\*\* The Concordium Rail Plugin (CRP) is an internal adapter (no public HTTP).



\## Conventions

\- \*\*Media type:\*\* `application/json; charset=utf-8`

\- \*\*Auth:\*\* `Authorization: Bearer <token>` on \*\*all\*\* endpoints

\- \*\*Timestamps:\*\* RFC 3339 (`date-time`)

\- \*\*Amounts:\*\* strings in \*\*major units\*\* (e.g., `"25.00"`). Equality checks use `decimals` to convert to minor units.

\- \*\*Idempotency:\*\* `nonce` is unique per merchant. See rules below.



---



\## Endpoints



\### 1) `POST /v1/challenges`

Registers (or reuses) a payment challenge.



\*\*Headers\*\*

```



Authorization: Bearer <token>

Content-Type: application/json



````



\*\*Request (Challenge)\*\*

```json

{

&nbsp; "network": "concordium:testnet",

&nbsp; "asset": { "type": "PLT", "tokenId": "USDQ", "decimals": 2 },

&nbsp; "amount": "25.00",

&nbsp; "pay\_to": "<recipientAddress>",

&nbsp; "expiry": "2099-12-31T23:59:00Z",

&nbsp; "nonce": "demo-001",

&nbsp; "policy": {},

&nbsp; "metadata": {}

}

````



\*\*Response 200\*\*



```json

{ "ok": true, "nonce": "demo-001", "status": "pending" }

```



\*\*Errors\*\*



\* `400` invalid schema

\* `401` unauthorized

\* `409` same `nonce` but different \*\*immutable\*\* fields (see Idempotency)

\* `422` policy failed (if evaluated synchronously)



---



\### 2) `POST /v1/verify`



Inline verify without prior registration (same body as `/v1/challenges`). Returns \*\*202\*\* and processes asynchronously.



\*\*Response 202\*\*



```json

{ "ok": true, "nonce": "demo-001", "status": "pending" }

```



\*\*Errors:\*\* same as `/v1/challenges`.



---



\### 3) `GET /v1/challenges/:nonce/status`



Poll the status (and fetch receipt when ready).



\*\*Response 200\*\*



```json

{

&nbsp; "nonce": "demo-001",

&nbsp; "status": "pending",     // or: fulfilled | expired | invalid | policy\_failed

&nbsp; "receipt": null          // object when fulfilled

}

```



\*\*Errors\*\*



\* `401` unauthorized

\* `404` unknown nonce



---



\### 4) `POST /v1/receipts/verify`



Verify a compact JWS receipt.



\*\*Request\*\*



```json

{ "jws": "<compact-jws>" }

```



\*\*Response 200\*\*



```json

{ "valid": true }

```



\*\*Errors\*\*



\* `400` missing or malformed body

\* `401` unauthorized

\* `422` invalid signature / claims



---



\### 5) `GET /.well-known/jwks.json`



JWKS for verifying `facilitator\_sig`.



\*\*Response 200 (example)\*\*



```json

{

&nbsp; "keys": \[

&nbsp;   { "kty":"OKP","crv":"Ed25519","x":"…","kid":"fac-v1","alg":"EdDSA","use":"sig" }

&nbsp; ]

}

```



---



\### 6) `GET /supported`



Discovery of supported networks/assets.



\*\*Response 200 (example)\*\*



```json

{

&nbsp; "schemes": \["exact"],

&nbsp; "networks": \["concordium:testnet","concordium:mainnet"],

&nbsp; "assets": \[{ "type":"PLT","tokenId":"USDQ","decimals":2 }]

}

```



---



\### 7) Health \& Metrics



\* `GET /healthz` → `{ "ok": true }`

\* `GET /readyz` → `{ "ok": true }` (only after DB/Redis/CCD reachable)

\* `GET /metrics` → Prometheus text



---



\## Idempotency \& States



\*\*Immutable fields\*\*: `network`, `asset`, `amount`, `pay\_to`, `expiry`.

\*\*Mutable while pending\*\*: `policy`, `metadata`.



\*\*Rules (per merchant):\*\*



\* Same `nonce` + \*\*identical payload\*\* ⇒ return same outcome (idempotent).

\* Same `nonce` + \*\*different immutable fields\*\* ⇒ \*\*409 Conflict\*\*.

\* Terminal states are immutable.



\*\*State machine\*\*



```

pending → fulfilled | expired | invalid | policy\_failed

```



\* `fulfilled`: exact on-chain match found and finalized.

\* `expired`: `now > expiry` with no match (finality-aware).

\* `invalid`: schema/format failure after acceptance (rare; typically 400 at ingress).

\* `policy\_failed`: policy/allowlist/identity gate failed.



---



\## Receipt (JWS payload contract)



```json

{

&nbsp; "v": "1",

&nbsp; "challenge\_nonce": "demo-001",

&nbsp; "network": "concordium:testnet",

&nbsp; "asset": { "type": "PLT", "tokenId": "USDQ", "decimals": 2 },

&nbsp; "amount": "25.00",

&nbsp; "from": "<payer>",

&nbsp; "to": "<recipient>",

&nbsp; "tx\_hash": "0x…",

&nbsp; "block\_hash": "0x…",

&nbsp; "finalized\_at": "2099-12-31T23:59:30Z",

&nbsp; "compliance": { "passed": true }

}

```



\*\*Protected header\*\*: `{ "alg":"EdDSA","kid":"fac-v1" }`

\*\*Merchant verification\*\*:



1\. Verify signature against `/.well-known/jwks.json`.

2\. Assert equality on: `network`, `asset`, `amount`, `to`, and \*\*nonce\*\*.

3\. Optionally assert block finality time ≤ `expiry`.



---



\## Errors (canonical)



\* `400` Bad request (schema)

\* `401` Unauthorized

\* `404` Not found (nonce)

\* `408` Request timeout (optional for long-poll)

\* `409` Conflict (idempotency breach)

\* `422` Unprocessable (policy failed / mismatch)

\* `503/504` Upstream unavailable / timed out



````



