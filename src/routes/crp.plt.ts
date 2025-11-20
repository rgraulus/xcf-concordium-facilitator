// src/routes/crp.plt.ts
//
// /v1/crp/plt/search
//
// Search PLT transfers using:
//   tokenId, to, amountMinor, limit
//
// Backed by the M3 tables defined in db/migrations/002_m3_stream.sql:
//   - blocks_finalized
//   - plt_transfers
//
// This does NOT (yet) join back to CRP payments; it’s purely a view
// on the PLT transfer stream so we can sanity-check M3.

import type { FastifyInstance } from "fastify";
import { searchPltTransfers } from "../store/plt.pg";

export default async function routes(server: FastifyInstance) {
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
        q.limit !== undefined && q.limit !== null
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
        limit: filters.limit ?? 25,
      },
      matches,
    };
  });
}
