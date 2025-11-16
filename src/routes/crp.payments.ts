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
// - fulfill: exact match + webhook POST (if configured)
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
import {
  searchPayments,
  type PaymentSearchFilters,
} from "../store/match.pg";
import { postPaymentWebhook } from "../webhook";
import type {
  CrpMatchRequest,
  CrpFulfillRequest,
  CrpPaymentRecord,
  CrpWebhookPayload,
  CrpNetwork,
  CrpAsset,
} from "../contracts/crpGateway";

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

// Helper: perform an exact-tuple match by:
// 1) Using searchPayments with a reasonably tight filter.
// 2) Doing an in-memory exact comparison on the remaining fields.
async function findExactMatch(
  input: PaymentMatchInput
): Promise<CrpPaymentRecord | null> {
  const filters: PaymentSearchFilters = {
    merchantId: input.merchantId,
    network: input.network,
    tokenId: input.asset.tokenId,
    payTo: input.payTo,
    // We can tighten/expand this later; 100 is plenty for dev/demo.
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
      return {
        ok: false,
        reason: "bad_request",
        error: "Missing or invalid required fields",
      };
    }

    const match = await findExactMatch(input);

    if (!match) {
      return {
        ok: false,
        reason: "no_match",
        count: 0,
      };
    }

    return {
      ok: true,
      reason: "exact_match",
      count: 1,
      match,
    };
  });

  //
  // POST /v1/crp/payments/fulfill
  //
  // Uses the same exact-tuple match as /payments/match, but:
  // - Intended as the "fulfill" entrypoint for the gateway.
  // - Triggers a webhook POST (if configured) with the matched payment.
  //
  server.post("/payments/fulfill", async (req, reply) => {
    const body = (req.body || {}) as Partial<CrpFulfillRequest> & { [k: string]: unknown };

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
      return {
        ok: false,
        reason: "bad_request",
        error: "Missing or invalid required fields",
      };
    }

    const match = await findExactMatch(input);

    if (!match) {
      return {
        ok: false,
        reason: "no_match",
        count: 0,
        webhook: {
          configured: false,
          attempted: false,
          ok: false,
        },
      };
    }

    const webhookPayload: CrpWebhookPayload = {
      kind: "crp.payment.fulfilled",
      payment: match,
    };

    const webhook = await postPaymentWebhook(input.merchantId, webhookPayload);

    return {
      ok: true,
      reason: "exact_match",
      count: 1,
      match,
      webhook,
    };
  });
}
