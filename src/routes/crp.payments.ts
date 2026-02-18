// src/routes/crp.payments.ts
//
// CRP Payments routes:
//
//   POST /v1/crp/payments            (create/reset a challenge row as pending)
//   GET  /v1/crp/payments/search
//   POST /v1/crp/payments/match
//   POST /v1/crp/payments/fulfill
//
// Design intent (your “gold tuple” model):
// - Gateway emits PAYMENT-REQUIRED (the gold tuple).
// - Facilitator stores that tuple (pending) via POST /payments.
// - Facilitator fulfills by mirroring the stored tuple into a gateway-proof payload,
//   then signing it (JWS) and persisting it.
// - Gateway verifies signature + payload schema + contract binding.
//
// IMPORTANT:
// - The gateway expects the *proof payload* schema (CcdPltProofV1) inside the receipt JWS payload.
// - That schema is implemented in payfi-gateway-demo/src/proofPayload.ts and is strict.
//
// Webhook behaviour:
// - Merchant-specific env var:
//
//     merchantId: "demo-merchant"
//     => env: CRP_WEBHOOK_URL_DEMO_MERCHANT
//
// - If env var is missing/empty:
//     webhook: { configured: false, attempted: false, ok: false }
//
// - If present and POST succeeds with 2xx:
//     webhook: { configured: true, attempted: true, ok: true, status: 200 }
//
// - On network/timeout/non-2xx:
//     webhook: { configured: true, attempted: true, ok: false, status?, error? }
//
// CHANGE (TX-CORRELATED PLT FULFILL):
// - For PLT fulfillment with requireEvent=true (default), we REQUIRE txHash and use it as the
//   authoritative correlator to select the exact chain event to claim.
// - This prevents ambiguous tuple-only matching when the same (to, amount, token) repeats,
//   which otherwise can select an older event and produce persistent 409 conflicts.
//

import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool";
import { toMinorUnits } from "../crp/decimals-registry";
import { searchPayments, type PaymentSearchFilters } from "../store/match.pg";
import { postPaymentWebhook } from "../webhook";
import type {
  CrpMatchRequest,
  CrpFulfillRequest,
  CrpPaymentRecord,
  CrpWebhookPayload,
  CrpNetwork,
  CrpAsset,
} from "../contracts/crpGateway";
import { getPltAsset, getDefaultNetworkGenesisIndex } from "../store/pltAssets.pg";
import { signJws } from "../crypto/signer";
import { normalizeNetworkId, networkCandidates } from "../lib/networkId";

// For clarity in this module:
type PaymentMatchInput = CrpMatchRequest;

// Narrow helpers for runtime casting.
function toCrpNetwork(value: unknown): CrpNetwork {
  return String(value ?? "").trim() as CrpNetwork;
}

function toCrpAsset(raw: any): CrpAsset {
  return {
    type: String(raw?.type ?? "").trim() as CrpAsset["type"],
    tokenId: String(raw?.tokenId ?? "").trim(),
    decimals: Number(raw?.decimals ?? 0),
  };
}

function toOptionalGenesisIndex(raw: any): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function asBooleanish(value: unknown): boolean {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
}

function toOptionalTxHash(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  // tx hashes are hex strings; be permissive but guard against obvious junk
  const hex = s.toLowerCase();
  if (!/^[0-9a-f]{32,128}$/.test(hex)) return s; // don't hard-fail; may be chain-specific formatting
  return hex;
}

// Keep KID consistent with signer.ts (JWS_KEY_ID preferred, fallback JWS_KID).
function currentKid(): string {
  return String(process.env.JWS_KEY_ID || process.env.JWS_KID || "kid-dev-1");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isoToUnixSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}

type PltEventRow = {
  network: string;
  from_address: string | null;
  to_address: string | null;
  transaction_hash: string;
  block_hash: string;
  occurred_at: string; // ISO
  event_index: number;
  network_genesis_index: number;
  block_height?: number | null;
};

async function findMatchingPltEvent(args: {
  networkCandidates: string[];
  networkGenesisIndex: number;
  tokenId: string;
  payTo: string;
  amountMinor: string;
}): Promise<PltEventRow | null> {
  const { networkCandidates: nets, networkGenesisIndex, tokenId, payTo, amountMinor } = args;

  const res = await pool.query(
    `
    SELECT
      network,
      from_address,
      to_address,
      transaction_hash,
      block_hash,
      occurred_at,
      event_index,
      network_genesis_index,
      block_height
    FROM public.crp_plt_events
    WHERE network = ANY($1)
      AND network_genesis_index = $2
      AND asset_id = $3
      AND to_address = $4
      AND amount_raw::text = $5
    -- Optional 1-liner upgrade:
    -- Prefer chain-deterministic ordering over occurred_at timestamp ordering.
    ORDER BY block_height DESC, event_index DESC
    LIMIT 1
    `,
    [nets, networkGenesisIndex, tokenId, payTo, amountMinor]
  );

  if ((res.rowCount ?? 0) === 0) return null;

  const r = res.rows[0];
  return {
    network: String(r.network),
    from_address: r.from_address ? String(r.from_address) : null,
    to_address: r.to_address ? String(r.to_address) : null,
    transaction_hash: String(r.transaction_hash),
    block_hash: String(r.block_hash),
    occurred_at: new Date(r.occurred_at).toISOString(),
    event_index: Number(r.event_index ?? 0),
    network_genesis_index: Number(r.network_genesis_index ?? networkGenesisIndex),
    block_height: r.block_height === undefined || r.block_height === null ? null : Number(r.block_height),
  };
}

/**
 * TX-correlated lookup: find a specific PLT transfer event by tx hash.
 *
 * NOTE:
 * - We still filter by to/token/amount/genesis to ensure the tx we claim matches the tuple.
 * - This prevents a tx with multiple events (or unrelated event types) from being used incorrectly.
 */
async function findPltEventByTx(args: {
  networkCandidates: string[];
  networkGenesisIndex: number;
  tokenId: string;
  payTo: string;
  amountMinor: string;
  txHash: string;
}): Promise<PltEventRow | null> {
  const { networkCandidates: nets, networkGenesisIndex, tokenId, payTo, amountMinor, txHash } = args;

  const res = await pool.query(
    `
    SELECT
      network,
      from_address,
      to_address,
      transaction_hash,
      block_hash,
      occurred_at,
      event_index,
      network_genesis_index,
      block_height
    FROM public.crp_plt_events
    WHERE network = ANY($1)
      AND network_genesis_index = $2
      AND asset_id = $3
      AND to_address = $4
      AND amount_raw::text = $5
      AND transaction_hash = $6
      AND event_type = 'transfer'
    ORDER BY event_index ASC
    LIMIT 1
    `,
    [nets, networkGenesisIndex, tokenId, payTo, amountMinor, txHash]
  );

  if ((res.rowCount ?? 0) === 0) return null;

  const r = res.rows[0];
  return {
    network: String(r.network),
    from_address: r.from_address ? String(r.from_address) : null,
    to_address: r.to_address ? String(r.to_address) : null,
    transaction_hash: String(r.transaction_hash),
    block_hash: String(r.block_hash),
    occurred_at: new Date(r.occurred_at).toISOString(),
    event_index: Number(r.event_index ?? 0),
    network_genesis_index: Number(r.network_genesis_index ?? networkGenesisIndex),
    block_height: r.block_height === undefined || r.block_height === null ? null : Number(r.block_height),
  };
}

/**
 * Normalize/validate PLT decimals via registry.
 * - If registry row exists: enforce enabled, validate (if provided), and normalize decimals.
 * - If registry missing: keep backward-compatible behavior.
 */
async function normalizeAssetWithRegistry(
  server: FastifyInstance,
  network: string,
  asset: CrpAsset,
  networkGenesisIndex?: number
): Promise<
  | {
      ok: true;
      asset: CrpAsset;
      networkGenesisIndex: number;
      decimalsSource: "db(crp_plt_assets)" | "provided(decimals)";
    }
  | { ok: false; reason: "asset_disabled" | "bad_request"; error?: string }
> {
  const ngi = Number.isFinite(Number(networkGenesisIndex))
    ? Math.floor(Number(networkGenesisIndex))
    : getDefaultNetworkGenesisIndex();

  // Only for PLT
  if (asset.type !== "PLT") {
    return { ok: true, asset, networkGenesisIndex: ngi, decimalsSource: "provided(decimals)" };
  }

  const reg = await getPltAsset(network, ngi, asset.tokenId);

  if (!reg) {
    server.log.warn(
      { network, networkGenesisIndex: ngi, tokenId: asset.tokenId },
      "[CRP] PLT decimals registry missing row; proceeding with provided decimals"
    );
    return { ok: true, asset, networkGenesisIndex: ngi, decimalsSource: "provided(decimals)" };
  }

  if (!reg.enabled) {
    return { ok: false, reason: "asset_disabled" };
  }

  // If caller provided decimals (non-NaN/non-zero), validate against registry.
  // NOTE: In older flows decimals may arrive as 0; treat that as "not provided".
  const provided = Number(asset.decimals);
  const providedLooksIntentional = Number.isFinite(provided) && provided > 0;

  if (providedLooksIntentional && provided !== Number(reg.decimals)) {
    return {
      ok: false,
      reason: "bad_request",
      error: `Decimals mismatch for ${asset.tokenId}. Provided=${provided} registry=${reg.decimals}`,
    };
  }

  return {
    ok: true,
    asset: { ...asset, decimals: Number(reg.decimals) },
    networkGenesisIndex: ngi,
    decimalsSource: "db(crp_plt_assets)",
  };
}

// Helper: perform an exact-tuple match by:
// 1) Using searchPayments with a reasonably tight filter.
// 2) Doing an in-memory exact comparison on the remaining fields.
// NOTE: To bridge CAIP-2 <-> legacy network strings, we broaden search when needed.
async function findExactMatch(input: PaymentMatchInput): Promise<CrpPaymentRecord | null> {
  const netCands = networkCandidates(input.network);

  const filters: PaymentSearchFilters = {
    merchantId: input.merchantId,
    // If we have multiple candidates (CAIP-2 + legacy), don't over-constrain search
    network: netCands.length === 1 ? netCands[0] : undefined,
    tokenId: input.asset.tokenId,
    payTo: input.payTo,
    limit: 250,
  };

  const rows = (await searchPayments(filters)) as CrpPaymentRecord[];

  const match = rows.find((row) => {
    const asset = row.asset;
    const rowNetwork = String((row as any).network ?? "").trim();

    return (
      row.nonce === input.nonce &&
      row.amount === input.amount &&
      netCands.includes(rowNetwork) &&
      asset.type === input.asset.type &&
      asset.tokenId === input.asset.tokenId &&
      Number(asset.decimals) === Number(input.asset.decimals)
    );
  });

  return match ?? null;
}

/**
 * Claim a PLT chain event so it can only be used once across all challenges.
 *
 * Table: public.crp_plt_event_claims
 * PK:    (network, network_genesis_index, tx_hash, event_index)
 *
 * Semantics:
 * - If unclaimed: insert (merchant_id, nonce) and succeed.
 * - If already claimed by SAME (merchant_id, nonce): succeed (idempotent).
 * - If already claimed by DIFFERENT (merchant_id, nonce): conflict.
 *
 * IMPORTANT (CAIP-2 migration):
 * - We must treat legacy network keys as equivalent. So we:
 *   1) Insert with a canonicalized network when possible
 *   2) Resolve ownership by looking up with ALL candidate network strings
 */
async function claimPltEvent(args: {
  client: any;
  network: string;
  networkGenesisIndex: number;
  txHash: string;
  eventIndex: number;
  merchantId: string;
  nonce: string;
}): Promise<
  | { ok: true; claimedBySelf: true; inserted: boolean }
  | { ok: false; reason: "event_claimed"; owner: { merchantId: string; nonce: string } }
  | { ok: false; reason: "internal_error"; error: string }
> {
  const { client, network, networkGenesisIndex, txHash, eventIndex, merchantId, nonce } = args;

  const canonical = normalizeNetworkId(network);
  const netCands = networkCandidates(canonical);

  const res = await client.query(
    `
    WITH ins AS (
      INSERT INTO public.crp_plt_event_claims
        (network, network_genesis_index, tx_hash, event_index, merchant_id, nonce)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (network, network_genesis_index, tx_hash, event_index)
      DO NOTHING
      RETURNING merchant_id, nonce
    )
    SELECT merchant_id, nonce, true AS inserted FROM ins
    UNION ALL
    SELECT merchant_id, nonce, false AS inserted
    FROM public.crp_plt_event_claims
    WHERE network = ANY($7)
      AND network_genesis_index = $2
      AND tx_hash = $3
      AND event_index = $4
    LIMIT 1;
    `,
    [canonical, networkGenesisIndex, txHash, eventIndex, merchantId, nonce, netCands]
  );

  if ((res.rowCount ?? 0) === 0) {
    return { ok: false, reason: "internal_error", error: "claim_lookup_failed" };
  }

  const row = res.rows[0] as any;
  const ownerMerchant = String(row.merchant_id ?? "");
  const ownerNonce = String(row.nonce ?? "");
  const inserted = Boolean(row.inserted);

  if (ownerMerchant === merchantId && ownerNonce === nonce) {
    return { ok: true, claimedBySelf: true, inserted };
  }

  return {
    ok: false,
    reason: "event_claimed",
    owner: { merchantId: ownerMerchant, nonce: ownerNonce },
  };
}

export default async function routes(server: FastifyInstance) {
  //
  // POST /v1/crp/payments
  //
  // Create/reset a pending challenge row from the “gold tuple” emitted by the gateway.
  //
  server.post("/payments", async (req, reply) => {
    const body = (req.body || {}) as any;

    const ngi =
      toOptionalGenesisIndex(body.networkGenesisIndex) ??
      toOptionalGenesisIndex(body.network_genesis_index) ??
      undefined;

    const rawNetwork = toCrpNetwork(body.network);
    const network = normalizeNetworkId(rawNetwork);

    const input = {
      merchantId: String(body.merchantId ?? "").trim(),
      nonce: String(body.nonce ?? "").trim(),
      network,
      asset: toCrpAsset(body.asset),
      amount: String(body.amount ?? "").trim(),
      payTo: String(body.payTo ?? "").trim(),
      expiry: body.expiry === undefined || body.expiry === null ? null : String(body.expiry).trim(),
      policy: isPlainObject(body.policy) ? body.policy : {},
      metadata: isPlainObject(body.metadata) ? body.metadata : {},
    };

    if (
      !input.merchantId ||
      !input.nonce ||
      !input.network ||
      !input.asset.type ||
      !input.asset.tokenId ||
      Number.isNaN(input.asset.decimals) ||
      !input.amount ||
      !input.payTo
    ) {
      reply.code(400);
      return { ok: false, reason: "bad_request", error: "Missing or invalid required fields" };
    }

    // Normalize/validate decimals via registry if possible.
    const norm = await normalizeAssetWithRegistry(server, input.network, input.asset, ngi);
    if (!norm.ok) {
      if (norm.reason === "asset_disabled") {
        reply.code(409);
        return { ok: false, reason: "asset_disabled" };
      }
      reply.code(400);
      return { ok: false, reason: "bad_request", error: norm.error ?? "Invalid asset tuple" };
    }
    input.asset = norm.asset;

    // Upsert into challenges as pending + clear receipt.
    // Assumes uniqueness on (merchant_id, nonce).
    const res = await pool.query(
      `
      INSERT INTO public.challenges
        (merchant_id, nonce, network, asset, amount, pay_to, expiry, policy, metadata, status, receipt, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9::jsonb, 'pending', NULL, now(), now())
      ON CONFLICT (merchant_id, nonce)
      DO UPDATE SET
        network = EXCLUDED.network,
        asset = EXCLUDED.asset,
        amount = EXCLUDED.amount,
        pay_to = EXCLUDED.pay_to,
        expiry = EXCLUDED.expiry,
        policy = EXCLUDED.policy,
        metadata = EXCLUDED.metadata,
        status = 'pending',
        receipt = NULL,
        updated_at = now()
      RETURNING
        merchant_id, nonce, network, asset, amount, pay_to, expiry, policy, metadata, status, receipt, created_at, updated_at
      `,
      [
        input.merchantId,
        input.nonce,
        input.network,
        JSON.stringify(input.asset),
        input.amount,
        input.payTo,
        input.expiry,
        JSON.stringify(input.policy),
        JSON.stringify(input.metadata),
      ]
    );

    return { ok: true, reason: "created", payment: res.rows[0] };
  });

  //
  // GET /v1/crp/payments/search
  //
  server.get("/payments/search", async (req, _reply) => {
    const q = (req.query || {}) as any;

    const filters: PaymentSearchFilters = {
      merchantId:
        typeof q.merchantId === "string" && q.merchantId.trim() !== ""
          ? q.merchantId.trim()
          : undefined,
      network:
        typeof q.network === "string" && q.network.trim() !== ""
          ? normalizeNetworkId(q.network.trim())
          : undefined,
      tokenId:
        typeof q.tokenId === "string" && q.tokenId.trim() !== ""
          ? q.tokenId.trim()
          : undefined,
      payTo:
        typeof q.payTo === "string" && q.payTo.trim() !== ""
          ? q.payTo.trim()
          : undefined,
      status:
        typeof q.status === "string" && q.status.trim() !== ""
          ? (q.status.trim() as any)
          : undefined,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    };

    const matches = await searchPayments(filters);

    return {
      ok: true,
      filters: {
        merchantId: filters.merchantId,
        network: filters.network,
        tokenId: filters.tokenId,
        payTo: filters.payTo,
        status: filters.status,
        limit: filters.limit ?? 25,
      },
      matches,
    };
  });

  //
  // POST /v1/crp/payments/match
  //
  // Exact-tuple match, read-only. No webhook.
  //
  server.post("/payments/match", async (req, reply) => {
    const body = (req.body || {}) as Partial<CrpMatchRequest> & { [k: string]: unknown };

    // Optional genesis index (does not change contract; tolerated if present)
    const ngi =
      toOptionalGenesisIndex((body as any).networkGenesisIndex) ??
      toOptionalGenesisIndex((body as any).network_genesis_index) ??
      undefined;

    const rawNetwork = toCrpNetwork(body.network);
    const network = normalizeNetworkId(rawNetwork);

    const input: CrpMatchRequest = {
      merchantId: String(body.merchantId ?? "").trim(),
      nonce: String(body.nonce ?? "").trim(),
      network: network as CrpNetwork,
      asset: toCrpAsset(body.asset),
      amount: String(body.amount ?? "").trim(),
      payTo: String(body.payTo ?? "").trim(),
    };

    // Basic validation to avoid nonsense tuples.
    if (
      !input.merchantId ||
      !input.nonce ||
      !input.network ||
      !input.asset.type ||
      !input.asset.tokenId ||
      Number.isNaN(input.asset.decimals) ||
      !input.amount ||
      !input.payTo
    ) {
      reply.code(400);
      return { ok: false, reason: "bad_request", error: "Missing or invalid required fields" };
    }

    // Normalize/validate decimals via registry if possible.
    const norm = await normalizeAssetWithRegistry(server, input.network, input.asset, ngi);
    if (!norm.ok) {
      if (norm.reason === "asset_disabled") {
        return { ok: false, reason: "asset_disabled", count: 0 };
      }
      reply.code(400);
      return { ok: false, reason: "bad_request", error: norm.error ?? "Invalid asset tuple" };
    }
    input.asset = norm.asset;

    const match = await findExactMatch(input);

    if (!match) {
      return { ok: false, reason: "no_match", count: 0 };
    }

    return { ok: true, reason: "exact_match", count: 1, match };
  });

  //
  // POST /v1/crp/payments/fulfill
  //
  server.post("/payments/fulfill", async (req, reply) => {
    const body = (req.body || {}) as Partial<CrpFulfillRequest> & { [k: string]: unknown };

    // Default requireEvent = TRUE unless explicitly provided as 0/false.
    const requireEventRaw = (body as any).requireEvent ?? (body as any).require_event;
    const requireEvent = requireEventRaw === undefined ? true : asBooleanish(requireEventRaw);

    const ngi =
      toOptionalGenesisIndex((body as any).networkGenesisIndex) ??
      toOptionalGenesisIndex((body as any).network_genesis_index) ??
      undefined;

    const rawNetwork = toCrpNetwork(body.network);
    const network = normalizeNetworkId(rawNetwork);
    const netCands = networkCandidates(network);

    // txHash is REQUIRED for PLT fulfill when requireEvent=true
    const txHash = toOptionalTxHash((body as any).txHash ?? (body as any).tx_hash);

    const input: CrpFulfillRequest = {
      merchantId: String(body.merchantId ?? "").trim(),
      nonce: String(body.nonce ?? "").trim(),
      network: network as CrpNetwork,
      asset: toCrpAsset(body.asset),
      amount: String(body.amount ?? "").trim(),
      payTo: String(body.payTo ?? "").trim(),
      // NOTE: CrpFulfillRequest may not include txHash in its type; we read it from body above.
    } as any;

    if (
      !input.merchantId ||
      !input.nonce ||
      !input.network ||
      !input.asset.type ||
      !input.asset.tokenId ||
      Number.isNaN(input.asset.decimals) ||
      !input.amount ||
      !input.payTo
    ) {
      reply.code(400);
      return { ok: false, reason: "bad_request", error: "Missing or invalid required fields" };
    }

    // Enforce txHash for PLT when event-proof gating is on.
    if (requireEvent && input.asset.type === "PLT" && !txHash) {
      reply.code(400);
      return {
        ok: false,
        reason: "bad_request",
        error: "txHash is required for PLT fulfillment when requireEvent=true",
        webhook: { configured: false, attempted: false, ok: false },
      };
    }

    const norm = await normalizeAssetWithRegistry(server, input.network, input.asset, ngi);
    if (!norm.ok) {
      if (norm.reason === "asset_disabled") {
        return {
          ok: false,
          reason: "asset_disabled",
          count: 0,
          webhook: { configured: false, attempted: false, ok: false },
        };
      }
      reply.code(400);
      return { ok: false, reason: "bad_request", error: norm.error ?? "Invalid asset tuple" };
    }
    input.asset = norm.asset;

    const match = await findExactMatch(input);

    if (!match) {
      return {
        ok: false,
        reason: "no_match",
        count: 0,
        webhook: { configured: false, attempted: false, ok: false },
      };
    }

    // If already fulfilled with a receipt, treat as idempotent success.
    if (match.status === "fulfilled" && (match as any)?.receipt?.jws) {
      const webhookPayload: CrpWebhookPayload = {
        kind: "crp.payment.fulfilled",
        payment: match,
      };
      const webhook = await postPaymentWebhook(input.merchantId, webhookPayload);
      return { ok: true, reason: "exact_match", count: 1, match, webhook };
    }

    // ---- Event-proof gating (default ON) + receipt persistence + event claiming ----
    let pltEvent: PltEventRow | null = null;

    if (requireEvent && input.asset.type === "PLT") {
      let amountMinor: string;
      try {
        amountMinor = toMinorUnits(input.amount, input.asset.decimals);
      } catch (err: any) {
        reply.code(400);
        return {
          ok: false,
          reason: "bad_request",
          error: String(err?.message ?? err ?? "Invalid amount/decimals"),
          webhook: { configured: false, attempted: false, ok: false },
        };
      }

      // TX-correlated event selection (authoritative)
      pltEvent = await findPltEventByTx({
        networkCandidates: netCands,
        networkGenesisIndex: norm.networkGenesisIndex,
        tokenId: input.asset.tokenId,
        payTo: input.payTo,
        amountMinor,
        txHash: txHash!,
      });

      if (!pltEvent) {
        return {
          ok: false,
          reason: "no_event",
          count: 0,
          match,
          required: {
            network: input.network,
            networkGenesisIndex: norm.networkGenesisIndex,
            tokenId: input.asset.tokenId,
            to: input.payTo,
            amountMinor,
            txHash: txHash!,
          },
          resolved: {
            decimals: input.asset.decimals,
            networkGenesisIndex: norm.networkGenesisIndex,
            decimalsSource: norm.decimalsSource,
          },
          webhook: { configured: false, attempted: false, ok: false },
        };
      }

      // Canonicalize the event’s network for receipts/claims (bridges legacy rows)
      const eventNetworkCanonical = normalizeNetworkId(pltEvent.network);

      // Pull the “gold tuple” contract from metadata if present (gateway-originated),
      // but ALWAYS enforce the required fields for gateway validation.
      const metaContractRaw = (match as any)?.metadata?.contract;
      const metaContract = isPlainObject(metaContractRaw) ? metaContractRaw : {};

      const contract = {
        contractId: String(
          (metaContract as any).contractId ?? (match as any)?.metadata?.contract?.contractId ?? ""
        ),
        contractVersion: String(
          (metaContract as any).contractVersion ??
            (match as any)?.metadata?.contract?.contractVersion ??
            ""
        ),
        isFrozen: Boolean((metaContract as any).isFrozen ?? true),

        merchantId: String((metaContract as any).merchantId ?? input.merchantId).trim(),
        resource: {
          method: String(
            (metaContract as any)?.resource?.method ??
              (match as any)?.metadata?.contract?.resource?.method ??
              ""
          ).trim(),
          path: String(
            (metaContract as any)?.resource?.path ??
              (match as any)?.metadata?.contract?.resource?.path ??
              ""
          ).trim(),
        },

        // REQUIRED by gateway validator
        network: String((metaContract as any).network ?? input.network ?? eventNetworkCanonical).trim(),
        asset: {
          type: "PLT",
          tokenId: input.asset.tokenId,
          decimals: input.asset.decimals,
        },
        amount: String((metaContract as any).amount ?? input.amount).trim(),
        payTo: String((metaContract as any).payTo ?? input.payTo).trim(),
      };

      // settlement: finalized + timestamps (unix seconds)
      const settledAt = isoToUnixSeconds(pltEvent.occurred_at);
      const expiresAt = (match as any)?.expiry ? isoToUnixSeconds(String((match as any).expiry)) : undefined;

      // Build the gateway-proof payload (CcdPltProofV1 shape)
      const proofPayload = {
        proofVersion: "ccd-plt-proof@v1",
        contract,
        nonce: input.nonce,
        settlement: {
          status: "finalized",
          settledAt,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
        chain: {
          transactionHash: pltEvent.transaction_hash,
          blockHash: pltEvent.block_hash,
          ...(pltEvent.block_height !== undefined && pltEvent.block_height !== null
            ? { blockHeight: pltEvent.block_height }
            : {}),
        },
        paymentEvent: {
          kind: "plt.transfer",
          tokenId: input.asset.tokenId,
          amountRaw: amountMinor,
          ...(pltEvent.from_address ? { from: pltEvent.from_address } : {}),
          to: input.payTo,
        },
      };

      // Sign JWS over the proof payload
      const jws = signJws(proofPayload);
      const kid = currentKid();

      // What we store in DB: keep existing receipt object shape,
      // but payload MUST be what gateway verifies.
      // Cast as any to avoid TS type mismatch if your CrpReceiptPayloadV1 still reflects the older schema.
      const receiptObj: any = {
        jws,
        payload: proofPayload,
        facilitator_key_id: kid,
      };

      // IMPORTANT: claim the chain event, then persist receipt + status in the SAME DB transaction.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const claim = await claimPltEvent({
          client,
          network: eventNetworkCanonical,
          networkGenesisIndex: norm.networkGenesisIndex,
          txHash: pltEvent.transaction_hash,
          eventIndex: pltEvent.event_index,
          merchantId: input.merchantId,
          nonce: input.nonce,
        });

        if (!claim.ok) {
          await client.query("ROLLBACK");

          if (claim.reason === "event_claimed") {
            reply.code(409);
            return {
              ok: false,
              reason: "event_claimed",
              count: 0,
              conflict: {
                network: eventNetworkCanonical,
                networkGenesisIndex: norm.networkGenesisIndex,
                tx_hash: pltEvent.transaction_hash,
                event_index: pltEvent.event_index,
                claimed_by: claim.owner,
              },
              match,
              webhook: { configured: false, attempted: false, ok: false },
            };
          }

          reply.code(500);
          return {
            ok: false,
            reason: "internal_error",
            error: claim.error ?? "claim_failed",
            webhook: { configured: false, attempted: false, ok: false },
          };
        }

        const upd = await client.query(
          `
          UPDATE public.challenges
          SET status = 'fulfilled',
              receipt = $3::jsonb,
              updated_at = now()
          WHERE merchant_id = $1 AND nonce = $2
          `,
          [input.merchantId, input.nonce, JSON.stringify(receiptObj)]
        );

        if ((upd.rowCount ?? 0) !== 1) {
          await client.query("ROLLBACK");
          reply.code(500);
          return {
            ok: false,
            reason: "internal_error",
            error: "challenge_update_failed",
            webhook: { configured: false, attempted: false, ok: false },
          };
        }

        await client.query("COMMIT");
      } catch (err: any) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore
        }
        server.log.error({ err }, "[CRP] fulfill transaction failed");
        reply.code(500);
        return {
          ok: false,
          reason: "internal_error",
          error: String(err?.message ?? err ?? "fulfill_failed"),
          webhook: { configured: false, attempted: false, ok: false },
        };
      } finally {
        client.release();
      }
    }

    // Re-read so response reflects fulfilled/receipt if we just updated it.
    const updated = await findExactMatch(input);
    const paymentToSend = updated ?? match;

    const webhookPayload: CrpWebhookPayload = {
      kind: "crp.payment.fulfilled",
      payment: paymentToSend,
    };

    const webhook = await postPaymentWebhook(input.merchantId, webhookPayload);

    return { ok: true, reason: "exact_match", count: 1, match: paymentToSend, webhook };
  });
}
