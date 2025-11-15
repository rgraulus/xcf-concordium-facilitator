// src/routes/crp.plt.ts
//
// /v1/crp/payments/search
//
// Search challenges/payments using the tuple:
//   merchantId, network, tokenId, pay_to, status, limit
//
// This does *not* yet join against PLT transfers. It simply
// returns matching challenges from the `challenges` table.
// Later, once PLT ingestion is wired, we can extend the
// response to include on-chain match info.

import type { FastifyInstance } from "fastify";
import {
  searchPayments,
  type PaymentSearchFilters,
} from "../store/match.pg";

export default async function routes(server: FastifyInstance) {
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
      limit:
        q.limit !== undefined
          ? Number(q.limit)
          : undefined,
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
}
