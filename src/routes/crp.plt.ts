// src/routes/crp.plt.ts
//
// PLT transfer read endpoints:
//
//   GET /v1/crp/plt/search
//     - generic PLT transfer search by tokenId, to, amountMinor
//
//   GET /v1/crp/plt/match-demo
//     - demo "join" between a CRP payment row and a PLT transfer row,
//       using a shared tuple: (tokenId, amountMinor)
//
// NOTE: This is a demo-only join. In a real deployment, you would
//       typically also align on pay_to / to_addr or other rails-
//       specific identifiers.

import type { FastifyInstance } from "fastify";
import {
  searchPltTransfers,
  type PltTransfer,
} from "../store/plt.pg";
import {
  searchPayments,
  type PaymentSearchFilters,
} from "../store/match.pg";
import type { CrpPaymentRecord } from "../contracts/crpGateway";

/**
 * Convert a human-readable decimal amount (e.g. "25.00")
 * into integer minor units as a string (e.g. "2500" for 2 decimals).
 *
 * This mirrors the logic used by the CRP stream worker.
 */
function humanToMinor(amount: string, decimals: number): string {
  const negative = amount.startsWith("-");
  const stripped = negative ? amount.slice(1) : amount;
  const [rawInt, rawFrac = ""] = stripped.split(".");

  const intPart = rawInt.replace(/^0+/, "") || "0";
  const fracPadded = rawFrac.padEnd(decimals, "0").slice(0, decimals);

  const combined = (intPart + fracPadded).replace(/^0+/, "") || "0";
  return negative ? `-${combined}` : combined;
}

export default async function routes(server: FastifyInstance) {
  //
  // GET /v1/crp/plt/search
  //
  server.get("/plt/search", async (req, _reply) => {
    const q = (req.query || {}) as any;

    const filters = {
      tokenId:
        typeof q.tokenId === "string" && q.tokenId.trim() !== ""
          ? q.tokenId.trim()
          : undefined,
      to:
        typeof q.to === "string" && q.to.trim() !== ""
          ? q.to.trim()
          : undefined,
      amountMinor:
        typeof q.amountMinor === "string" && q.amountMinor.trim() !== ""
          ? q.amountMinor.trim()
          : undefined,
      limit:
        q.limit !== undefined
          ? Number(q.limit)
          : undefined,
    };

    const matches = await searchPltTransfers(filters);

    return {
      ok: true,
      filters: {
        tokenId: filters.tokenId,
        to: filters.to,
        amountMinor: filters.amountMinor,
        limit: filters.limit ?? 10,
      },
      matches,
    };
  });

  //
  // GET /v1/crp/plt/match-demo
  //
  server.get("/plt/match-demo", async (_req, reply) => {
    // 1) Look up a demo payment row (same tuple you’ve been using).
    const paymentFilters: PaymentSearchFilters = {
      merchantId: "demo-merchant",
      network: "concordium:testnet",
      tokenId: "usd:test",
      status: "fulfilled",
      limit: 10,
    };

    const paymentRows = (await searchPayments(paymentFilters)) as CrpPaymentRecord[];

    const payment = paymentRows.find((p) => p.amount === "25.00");

    if (!payment) {
      reply.code(404);
      return {
        ok: false,
        reason: "no_demo_payment",
        message:
          "No demo CRP payment found for (merchantId=demo-merchant, network=concordium:testnet, tokenId=usd:test, amount=25.00).",
        filters: paymentFilters,
      };
    }

    const tokenId = payment.asset?.tokenId ?? "";
    const decimals = Number(payment.asset?.decimals ?? 0);

    if (!tokenId || Number.isNaN(decimals)) {
      reply.code(500);
      return {
        ok: false,
        reason: "bad_demo_payment",
        message:
          "Demo payment row is missing asset.tokenId or decimals; cannot compute amountMinor.",
        payment,
      };
    }

    const amountMinor = humanToMinor(payment.amount, decimals);

    // 2) Look up a PLT transfer row with the same (tokenId, amountMinor).
    const pltMatches: PltTransfer[] = await searchPltTransfers({
      tokenId,
      amountMinor,
      limit: 5,
    });

    const transfer = pltMatches[0] ?? null;

    return {
      ok: true,
      joinKey: {
        tokenId,
        amount: payment.amount,
        amountMinor,
        decimals,
      },
      payment,
      transfer,
      debug: {
        paymentFilters,
        matchCount: pltMatches.length,
      },
    };
  });
}
