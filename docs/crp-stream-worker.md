# CRP Stream Worker Design

Status: draft  
Owner: Rik / XCF–PayFi integration  
Scope: `xcf-concordium-facilitator` (CRP paths)

---

## 1. Purpose

The **CRP stream worker** is a background component that keeps the CRP payment state in sync with an external event source (eventually: Concordium PLT events).

The worker:

- Subscribes to a payment-related event stream.
- Normalizes events into CRP's internal payment representation.
- Upserts those records into the CRP backing store.
- Ensures `/v1/crp/payments/search|match|fulfill` always see a coherent, up-to-date view.

**Key principle:**  
> *The stream worker is optional and feature-gated. Turning it off must fully preserve today's behavior.*

---

## 2. Design goals

1. **Safety first**
   - Off by default (`CRP_STREAM_WORKER_ENABLED=false`).
   - No behavioral change to existing CRP HTTP endpoints when disabled.
   - Easy to run with a *fake* event source for local/dev.

2. **Pluggable event source**
   - Start with a `FakeEventSource` used for tests and demos.
   - Later plug in a **real Concordium source** (via `@concordium/web-sdk/nodejs` or successor).
   - Switchable via config/env without touching the rest of CRP.

3. **Clear data model**
   - Introduce a small, explicit “normalized payment event” shape.
   - Map one-way: *source event* → *normalized payment* → *CRP payment row*.

4. **Observability**
   - Structured logging for start/stop, errors, and per-event processing.
   - Counters we can later expose via `/metrics` or logs.

5. **Incremental rollout**
   - Phase 1: fake source only, writing to CRP store.
   - Phase 2: real Concordium reader behind a separate mode flag.
   - Phase 3: tuning, backfill, and productionizing.

---

## 3. High-level architecture

### 3.1 Components

- **Stream worker** (`crp/streamWorker.ts`)
  - Main loop responsible for:
    - Acquiring events from an `EventSource`.
    - Transforming to `NormalizedPaymentEvent`.
    - Persisting into the CRP store via a `PaymentSink`.

- **EventSource interface**
  - Abstracts over:
    - Fake generator for local/dev.
    - Future Concordium-based event reader.
  - Example methods:
    - `connect(): Promise<void>`
    - `nextBatch(): Promise<RawEvent[]>`
    - `close(): Promise<void>`

- **PaymentSink interface**
  - Minimal API responsible for applying events:
    - `applyPaymentEvent(event: NormalizedPaymentEvent): Promise<void>`

- **Config & flags**
  - Env-controlled:
    - `CRP_STREAM_WORKER_ENABLED` – `true`/`false` (default: `false`).
    - `CRP_STREAM_WORKER_MODE` – `"fake"` | `"concordium"` (default: `"fake"`).
    - `CRP_STREAM_POLL_INTERVAL_MS` – polling interval for fake/HTTP-based modes (e.g. `5000`).

### 3.2 Flow

When enabled:

1. Server starts.
2. If `CRP_STREAM_WORKER_ENABLED=true`:
   - Resolve `EventSource` based on `CRP_STREAM_WORKER_MODE`.
   - Create a `PaymentSink` bound to the CRP store.
   - Start a background loop:
     - `source.nextBatch()` → `[RawEvent]`.
     - Map each `RawEvent` → `NormalizedPaymentEvent`.
     - `sink.applyPaymentEvent(normalized)`.

When disabled:

- No worker is started.
- CRP HTTP endpoints behave as today (using existing static/demo data).

---

## 4. Data model

### 4.1 NormalizedPaymentEvent

A tentative shape (TypeScript-ish):

```ts
type NormalizedPaymentEvent = {
  id: string;               // unique event id (e.g., hash + index)
  network: string;          // e.g. "concordium:testnet"
  blockHeight?: string;     // optional, for ordering/debugging
  txHash?: string;          // optional
  timestamp?: string;       // ISO8601

  asset: {
    type: "PLT";
    tokenId: string;        // e.g. "usd:test"
    decimals: number;       // from PLT registry
  };

  amount: string;           // human-readable (e.g. "25.00")
  payTo: string;            // Concordium account address
  nonce: string;            // merchant-side nonce if available
  merchantId?: string;      // link to the merchant in CRP
  status: "pending" | "fulfilled" | "failed";

  // Additional metadata we might care about
  raw?: unknown;            // original event payload (for debugging)
};
```

This model is:
- Close to what `/v1/crp/payments/search|match|fulfill` already use.
- Stable enough to support future backends.

### 4.2 Mapping to CRP payments

The `PaymentSink` will take `NormalizedPaymentEvent` and upsert into the CRP payment storage that backs CRP HTTP endpoints, e.g.:

- Look up or create a payment record keyed by `(merchantId, network, tokenId, payTo, nonce)`.
- Update:
  - `amount`
  - `status`
  - `receipt`-like data if present
  - `updated_at` timestamp, etc.

Exact schema details should align with the existing CRP payment tables/data-access layer.

---

## 5. Configuration & flags

All behavior is controlled via environment variables:

- `CRP_STREAM_WORKER_ENABLED`  
  - Default: `false`  
  - When `false`: worker is never started.
  - When `true`: worker starts using the mode below.

- `CRP_STREAM_WORKER_MODE`  
  - Default: `"fake"`  
  - `"fake"`: use a `FakeEventSource` that emits synthetic PLT payment events.
  - `"concordium"`: (future) use a real Concordium event source.

- `CRP_STREAM_POLL_INTERVAL_MS`  
  - Default: `5000` (5 seconds) for polling-based sources (fake/HTTP).
  - Can be tuned for testing or production.

---

## 6. Error handling & observability

### 6.1 Error handling

- **Per-batch errors**
  - If `source.nextBatch()` fails:
    - Log error with context (`mode`, last block height, etc.).
    - Backoff (e.g., sleep for `CRP_STREAM_POLL_INTERVAL_MS`).
    - Retry; do **not** crash the main HTTP server.

- **Per-event errors**
  - If mapping or `applyPaymentEvent` fails for a given event:
    - Log the error with event id and minimal payload.
    - Continue with the next event in the batch.
    - Optionally count “dropped events” for metrics.

### 6.2 Logging

Use existing logging infra to emit:

- Worker lifecycle:
  - `crp.streamWorker.start` (mode, interval).
  - `crp.streamWorker.stop`.
- Batch processing:
  - `crp.streamWorker.batch` (batch size, timing).
- Errors:
  - `crp.streamWorker.error` (stage, mode, message).

This keeps alignment with existing log style and allows future `/metrics` or dashboards.

---

## 7. Rollout plan

**Phase A – Skeleton + Fake**

1. Implement `crp/streamWorker.ts`:
   - `startStreamWorker(config)` and `stopStreamWorker()`.
   - `EventSource` + `PaymentSink` interfaces.
   - `FakeEventSource` that emits a few well-known events.

2. Wire the worker into server startup:
   - Respect `CRP_STREAM_WORKER_ENABLED` and `CRP_STREAM_WORKER_MODE`.
   - Default remains `disabled`.

3. Add tests / scripts:
   - Local script that starts worker with `FakeEventSource`.
   - Verify CRP payments table (or in-memory store) gets updated.

**Phase B – Concordium integration (experimental)**

4. Introduce `ConcordiumEventSource`:
   - Uses `@concordium/web-sdk/nodejs` (or recommended SDK).
   - Reads PLT-related events and maps to `NormalizedPaymentEvent`.

5. Gate with `"concordium"` mode:
   - Only used when `CRP_STREAM_WORKER_MODE=concordium`.
   - Still behind `CRP_STREAM_WORKER_ENABLED=true`.

6. Add config for Concordium connection:
   - E.g. `CONCORDIUM_NODE_URL`, `CONCORDIUM_NETWORK`, etc.

**Phase C – Hardening**

7. Tuning:
   - Backoff strategy, batch size, and commit strategy.
   - Idempotency guarantees for repeated events.

8. Observability:
   - Optional metrics endpoint additions.
   - Log-based dashboards/alerts for worker health.

---

## 8. Non-goals (for now)

The initial stream worker **does not**:

- Manage wallet keys or sign transactions.
- Perform any on-chain writes.
- Implement historical backfill or reorg-aware logic.
- Expose new public HTTP endpoints beyond what already exists.

Those may be added later once the basic read-only event pipeline is stable.

---

## 9. Summary

The CRP stream worker is:

- A **feature-gated background pipeline** for feeding CRP from an external event source.
- **Off by default** to preserve existing behavior.
- Designed with:
  - A pluggable `EventSource` abstraction (fake → Concordium).
  - A clear `NormalizedPaymentEvent` data shape.
  - Safe error handling and basic observability.
- The next concrete steps are:
  1. Add the `crp/streamWorker.ts` skeleton with a fake source.
  2. Integrate it into the facilitator startup behind env flags.
  3. Add a small script or test harness to validate the fake pipeline end-to-end.
