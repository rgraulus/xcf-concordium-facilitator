// src/http/crpExactMatchAlias.ts
//
// Thin GET alias for the existing exact-tuple match logic in
// POST /v1/crp/payments/match, with optional event-proof gating.
//
// Mounted with /v1/crp prefix from server.ts:
//   GET /v1/crp/payments/exact-match
//
// Query parameters (accept BOTH camelCase and snake_case):
//
//   merchantId | merchant_id   (required)
//   nonce                      (required)
//   network                    (required)
//   tokenId   | token_id       (required)
//   amount                     (required, e.g. "25.00")
//   payTo     | pay_to         (required)
//   decimals                   (optional; if omitted, resolve from crp_plt_assets)
//   assetType                  (optional; defaults to "PLT")
//   requireEvent               (optional; default TRUE; if truthy, require matching crp_plt_events row)
//
// Response mirrors POST /v1/crp/payments/match, with extra `resolved` when helpful.

import type { FastifyPluginCallback } from "fastify";
import { pool } from "../db/pool";
import { toMinorUnits } from "../crp/decimals-registry";
import { normalizeNetworkId, networkCandidates } from "../lib/networkId";
import { searchPayments, type PaymentSearchFilters } from "../store/match.pg";

// Narrow helper: best-effort string extraction.
function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Helper: parse number (NaN if useless).
function asNumberOrNaN(value: unknown): number {
  if (value === undefined || value === null) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function asBooleanish(value: unknown): boolean {
  const s = asTrimmedString(value).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
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
  requireEvent: boolean;
}

type ResolvedInfo = {
  decimals: number;
  networkGenesisIndex: number;
  decimalsSource: "query(decimals)" | "db(crp_plt_assets)" | "default(2)";
};

async function resolveDecimalsAndGenesisIndex(
  network: string,
  tokenId: string,
  decimalsFromQuery: number | null
): Promise<ResolvedInfo> {
  const netCands = networkCandidates(network);

  // If caller provided decimals explicitly, we still try to resolve genesis index from DB
  // (best-effort), but we won't override decimals.
  if (decimalsFromQuery !== null && Number.isFinite(decimalsFromQuery)) {
    let ng = 0;
    try {
      const r = await pool.query(
        `
        SELECT network_genesis_index
        FROM public.crp_plt_assets
        WHERE network = ANY($1)
          AND asset_id = $2
        ORDER BY network_genesis_index DESC
        LIMIT 1
        `,
        [netCands, tokenId]
      );
      if ((r.rowCount ?? 0) > 0) {
        ng = Number(r.rows[0].network_genesis_index);
      }
    } catch {
      // ignore: genesis index remains 0
    }

    return {
      decimals: Number(decimalsFromQuery),
      networkGenesisIndex: Number.isFinite(ng) ? ng : 0,
      decimalsSource: "query(decimals)",
    };
  }

  // Otherwise, resolve from DB registry.
  const res = await pool.query(
    `
    SELECT decimals, network_genesis_index
    FROM public.crp_plt_assets
    WHERE network = ANY($1)
      AND asset_id = $2
      AND enabled = TRUE
    ORDER BY network_genesis_index DESC
    LIMIT 1
    `,
    [netCands, tokenId]
  );

  if ((res.rowCount ?? 0) > 0) {
    const row = res.rows[0];
    return {
      decimals: Number(row.decimals),
      networkGenesisIndex: Number(row.network_genesis_index),
      decimalsSource: "db(crp_plt_assets)",
    };
  }

  // Final fallback (keeps old behavior for demo tokens that aren't seeded).
  return {
    decimals: 2,
    networkGenesisIndex: 0,
    decimalsSource: "default(2)",
  };
}

async function hasMatchingPltEvent(args: {
  networkCandidates: string[];
  networkGenesisIndex: number;
  tokenId: string;
  payTo: string;
  amountMinor: string;
}): Promise<boolean> {
  const { networkCandidates: nets, networkGenesisIndex, tokenId, payTo, amountMinor } = args;

  const res = await pool.query(
    `
    SELECT 1
    FROM public.crp_plt_events
    WHERE network = ANY($1)
      AND network_genesis_index = $2
      AND asset_id = $3
      AND to_address = $4
      AND amount_raw::text = $5
    LIMIT 1
    `,
    [nets, networkGenesisIndex, tokenId, payTo, amountMinor]
  );

  return (res.rowCount ?? 0) > 0;
}

const crpExactMatchAliasPlugin: FastifyPluginCallback = async (server) => {
  server.get("/payments/exact-match", async (req, reply) => {
    const q = (req.query || {}) as Record<string, unknown>;

    // Accept camelCase and snake_case, prefer camelCase if both exist.
    const merchantId =
      asTrimmedString(q.merchantId) || asTrimmedString(q.merchant_id);

    const nonce = asTrimmedString(q.nonce);
    const rawNetwork = asTrimmedString(q.network);
    const network = normalizeNetworkId(rawNetwork);
    const netCands = networkCandidates(network);

    const tokenId =
      asTrimmedString(q.tokenId) || asTrimmedString(q.token_id);

    const amount = asTrimmedString(q.amount);

    const payTo =
      asTrimmedString(q.payTo) || asTrimmedString(q.pay_to);

    const decimalsRaw = q.decimals;
    const assetTypeRaw = q.assetType ?? q.asset_type;

    // Default requireEvent = TRUE unless explicitly provided as 0/false.
    const requireEventRaw = q.requireEvent ?? q.require_event;
    const requireEvent =
      requireEventRaw === undefined ? true : asBooleanish(requireEventRaw);

    const decimalsFromQuery =
      !Number.isNaN(asNumberOrNaN(decimalsRaw)) ? asNumberOrNaN(decimalsRaw) : null;

    const assetType = asTrimmedString(assetTypeRaw) || "PLT";

    // Basic validation – same spirit as POST /payments/match.
    if (!merchantId || !nonce || !network || !tokenId || !amount || !payTo) {
      reply.code(400);
      return {
        ok: false,
        reason: "bad_request",
        error:
          "Missing required query parameters. Required: merchantId, nonce, network, tokenId, amount, payTo. Optional: decimals, assetType, requireEvent.",
      };
    }

    // Resolve decimals + genesis index (DB-first when decimals omitted).
    const resolved = await resolveDecimalsAndGenesisIndex(network, tokenId, decimalsFromQuery);

    const input: ExactMatchInput = {
      merchantId,
      nonce,
      network,
      tokenId,
      amount,
      payTo,
      assetType,
      decimals: resolved.decimals,
      requireEvent,
    };

    // Search by the “narrow” tuple first (same pattern as crp.payments.ts).
    const filters: PaymentSearchFilters = {
      merchantId: input.merchantId,
      network: input.network,
      networkCandidates: netCands,
      tokenId: input.tokenId,
      payTo: input.payTo,
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
        resolved,
      };
    }

    // Optional event-proof gating (default ON).
    if (input.requireEvent) {
      let amountMinor: string;
      try {
        amountMinor = toMinorUnits(input.amount, input.decimals);
      } catch (err: any) {
        reply.code(400);
        return {
          ok: false,
          reason: "bad_request",
          error: String(err?.message ?? err ?? "Invalid amount/decimals"),
          resolved,
        };
      }

      const found = await hasMatchingPltEvent({
        networkCandidates: netCands,
        networkGenesisIndex: resolved.networkGenesisIndex,
        tokenId: input.tokenId,
        payTo: input.payTo,
        amountMinor,
      });

      if (!found) {
        return {
          ok: false,
          reason: "no_event",
          count: 0,
          match, // tuple match exists, but event proof missing
          required: {
            network: input.network,
            networkGenesisIndex: resolved.networkGenesisIndex,
            tokenId: input.tokenId,
            to: input.payTo,
            amountMinor,
          },
          resolved,
        };
      }
    }

    return {
      ok: true,
      reason: "exact_match",
      count: 1,
      match,
      resolved,
    };
  });
};

export default crpExactMatchAliasPlugin;
