// src/routes/crp.payments.ts
//
// CRP Payments routes:
//
//   GET  /v1/crp/payments/search
//   POST /v1/crp/payments/match
//   POST /v1/crp/payments/fulfill
//
// - search:  query challenges/payments by tuple filters
// - match:   pure read, exact tuple match for a payment receipt
// - fulfill: exact match + (M4.2 event-proof gating) + (M4.3 receipt+persist+status flip) + webhook POST (if configured)
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

// Keep KID consistent with signer.ts (JWS_KEY_ID preferred, fallback JWS_KID).
function currentKid(): string {
  return String(process.env.JWS_KEY_ID || process.env.JWS_KID || "kid-dev-1");
}

type PltEventRow = {
  from_address: string | null;
  to_address: string | null;
  transaction_hash: string;
  block_hash: string;
  occurred_at: string; // ISO
  event_index: number;
  network_genesis_index: number;
};

async function findMatchingPltEvent(args: {
  network: string;
  networkGenesisIndex: number;
  tokenId: string;
  payTo: string;
  amountMinor: string;
}): Promise<PltEventRow | null> {
  const { network, networkGenesisIndex, tokenId, payTo, amountMinor } = args;

  const res = await pool.query(
    `
    SELECT
      from_address,
      to_address,
      transaction_hash,
      block_hash,
      occurred_at,
      event_index,
      network_genesis_index
    FROM public.crp_plt_events
    WHERE network = $1
      AND network_genesis_index = $2
      AND asset_id = $3
      AND to_address = $4
      AND amount_raw::text = $5
    ORDER BY occurred_at DESC
    LIMIT 1
    `,
    [network, networkGenesisIndex, tokenId, payTo, amountMinor]
  );

  if ((res.rowCount ?? 0) === 0) return null;

  const r = res.rows[0];
  return {
    from_address: r.from_address ? String(r.from_address) : null,
    to_address: r.to_address ? String(r.to_address) : null,
    transaction_hash: String(r.transaction_hash),
    block_hash: String(r.block_hash),
    occurred_at: new Date(r.occurred_at).toISOString(),
    event_index: Number(r.event_index ?? 0),
    network_genesis_index: Number(r.network_genesis_index ?? networkGenesisIndex),
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
  | { ok: true; asset: CrpAsset; networkGenesisIndex: number; decimalsSource: "db(crp_plt_assets)" | "provided(decimals)" }
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
async function findExactMatch(input: PaymentMatchInput): Promise<CrpPaymentRecord | null> {
  const filters: PaymentSearchFilters = {
    merchantId: input.merchantId,
    network: input.network,
    tokenId: input.asset.tokenId,
    payTo: input.payTo,
    limit: 100,
  };

  const rows = (await searchPayments(filters)) as CrpPaymentRecord[];

  const match = rows.find((row) => {
    const asset = row.asset;
    return (
      row.nonce === input.nonce &&
      row.amount === input.amount &&
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
    WHERE network = $1
      AND network_genesis_index = $2
      AND tx_hash = $3
      AND event_index = $4
    LIMIT 1;
    `,
    [network, networkGenesisIndex, txHash, eventIndex, merchantId, nonce]
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
          ? q.network.trim()
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

    const input: CrpMatchRequest = {
      merchantId: String(body.merchantId ?? "").trim(),
      nonce: String(body.nonce ?? "").trim(),
      network: toCrpNetwork(body.network),
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
  // Uses the same exact-tuple match as /payments/match, but:
  // - Intended as the "fulfill" entrypoint for the gateway.
  // - M4.2: event-proof gating (default ON unless requireEvent=false/0).
  // - M4.3: generate receipt + persist receipt + flip status to fulfilled.
  // - NEW: claim chain event in public.crp_plt_event_claims so it can't be reused across nonces.
  // - Triggers a webhook POST (if configured) with the updated payment.
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

    const input: CrpFulfillRequest = {
      merchantId: String(body.merchantId ?? "").trim(),
      nonce: String(body.nonce ?? "").trim(),
      network: toCrpNetwork(body.network),
      asset: toCrpAsset(body.asset),
      amount: String(body.amount ?? "").trim(),
      payTo: String(body.payTo ?? "").trim(),
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

    // ---- M4.2 + M4.3: Event-proof gating (default ON) + receipt persistence + event claiming ----
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

      pltEvent = await findMatchingPltEvent({
        network: input.network,
        networkGenesisIndex: norm.networkGenesisIndex,
        tokenId: input.asset.tokenId,
        payTo: input.payTo,
        amountMinor,
      });

      if (!pltEvent) {
        return {
          ok: false,
          reason: "no_event",
          count: 0,
          match, // tuple match exists, but event proof missing
          required: {
            network: input.network,
            networkGenesisIndex: norm.networkGenesisIndex,
            tokenId: input.asset.tokenId,
            to: input.payTo,
            amountMinor,
          },
          resolved: {
            decimals: input.asset.decimals,
            networkGenesisIndex: norm.networkGenesisIndex,
            decimalsSource: norm.decimalsSource,
          },
          webhook: { configured: false, attempted: false, ok: false },
        };
      }

      // Generate canonical receipt payload + sign
      const kid = currentKid();

      const unsignedPayload = {
        v: "1",
        challenge_nonce: input.nonce,
        network: input.network,
        asset: {
          type: input.asset.type,
          tokenId: input.asset.tokenId,
          decimals: input.asset.decimals,
        },
        amount: input.amount,
        from: pltEvent.from_address ?? "",
        to: pltEvent.to_address ?? input.payTo,
        tx_hash: pltEvent.transaction_hash,
        block_hash: pltEvent.block_hash,
        finalized_at: pltEvent.occurred_at,
        compliance: {
          standard: "x402",
          source: "crp_plt_events",
          networkGenesisIndex: pltEvent.network_genesis_index,
          eventIndex: pltEvent.event_index,
        },
      };

      const jws = signJws(unsignedPayload);

      const fullPayload = {
        ...unsignedPayload,
        facilitator_sig: jws,
        facilitator_key_id: kid,
      };

      // IMPORTANT: claim the chain event, then persist receipt + status in the SAME DB transaction.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const claim = await claimPltEvent({
          client,
          network: input.network,
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
                network: input.network,
                networkGenesisIndex: norm.networkGenesisIndex,
                tx_hash: pltEvent.transaction_hash,
                event_index: pltEvent.event_index,
                claimed_by: claim.owner,
              },
              match, // tuple match exists but event is already consumed
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

        const receiptObj = { jws, payload: fullPayload };

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
