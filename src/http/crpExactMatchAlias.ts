// src/http/crpExactMatchAlias.ts
//
// Thin GET alias for the existing exact-tuple match logic in
// POST /v1/crp/payments/match.
//
// Route (with /v1/crp prefix from server.ts):
//   GET /v1/crp/payments/exact-match
//
// Query parameters (we accept BOTH camelCase and snake_case):
//
//   merchantId | merchant_id   (required)
//   nonce                      (required)
//   network                    (required)
//   tokenId   | token_id       (required)
//   amount                     (required, e.g. "25.00")
//   payTo     | pay_to         (required)
//   decimals                   (optional; defaults to 2)
//   assetType                  (optional; defaults to "PLT")
//
// Response shape mirrors POST /v1/crp/payments/match:
//
//   200 OK
//   - on success:
//       { ok: true, reason: "exact_match", count: 1, match: {...} }
//   - on no match:
//       { ok: false, reason: "no_match", count: 0 }
//   - on bad request:
//       400 + { ok: false, reason: "bad_request", error: "..." }

import type { FastifyPluginCallback } from "fastify";
import {
  searchPayments,
  type PaymentSearchFilters,
} from "../store/match.pg";

// Narrow helper: best-effort string extraction.
function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Helper: parse decimals (NaN if useless).
function asNumberOrNaN(value: unknown): number {
  if (value === undefined || value === null) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// Our internal representation of the tuple we want to match.
interface ExactMatchInput {
  merchantId: string;
  nonce: string;
  network: string;
  tokenId: string;
  amount: string;
  payTo: string;
  assetType: string;
  decimals: number;
}

const crpExactMatchAliasPlugin: FastifyPluginCallback = async (server) => {
  server.get("/payments/exact-match", async (req, reply) => {
    const q = (req.query || {}) as Record<string, unknown>;

    // Accept camelCase and snake_case, prefer camelCase if both exist.
    const merchantId =
      asTrimmedString(q.merchantId) || asTrimmedString(q.merchant_id);

    const nonce = asTrimmedString(q.nonce);
    const network = asTrimmedString(q.network);

    const tokenId =
      asTrimmedString(q.tokenId) || asTrimmedString(q.token_id);

    const amount = asTrimmedString(q.amount);

    const payTo =
      asTrimmedString(q.payTo) || asTrimmedString(q.pay_to);

    const decimalsRaw = q.decimals;
    const assetTypeRaw = q.assetType;

    const decimals = !Number.isNaN(asNumberOrNaN(decimalsRaw))
      ? asNumberOrNaN(decimalsRaw)
      : 2; // sensible default for demo tokens like usd:test

    const assetType =
      asTrimmedString(assetTypeRaw) || "PLT";

    const input: ExactMatchInput = {
      merchantId,
      nonce,
      network,
      tokenId,
      amount,
      payTo,
      assetType,
      decimals,
    };

    // Basic validation – same spirit as POST /payments/match.
    if (
      !input.merchantId ||
      !input.nonce ||
      !input.network ||
      !input.tokenId ||
      !input.amount ||
      !input.payTo ||
      Number.isNaN(input.decimals)
    ) {
      reply.code(400);
      return {
        ok: false,
        reason: "bad_request",
        error:
          "Missing or invalid required query parameters. Required: merchantId, nonce, network, tokenId, amount, payTo. Optional: decimals, assetType.",
      };
    }

    // Use the same "first narrow by tuple, then in-memory exact match" pattern
    // as the existing findExactMatch() in src/routes/crp.payments.ts.
    const filters: PaymentSearchFilters = {
      merchantId: input.merchantId,
      network: input.network,
      tokenId: input.tokenId,
      payTo: input.payTo,
      // 100 is plenty for dev/demo and keeps the query bounded.
      limit: 100,
    };

    const rows = (await searchPayments(filters)) as any[];

    const match = rows.find((row) => {
      const asset = row.asset ?? {};
      return (
        row.nonce === input.nonce &&
        row.amount === input.amount &&
        typeof asset.type === "string" &&
        typeof asset.tokenId === "string" &&
        asset.type.trim() === input.assetType &&
        asset.tokenId.trim() === input.tokenId &&
        Number(asset.decimals) === Number(input.decimals)
      );
    });

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
};

export default crpExactMatchAliasPlugin;
