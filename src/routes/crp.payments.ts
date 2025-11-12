// src/routes/crp.payments.ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";

// Very small filter shape for now (tokenId, from/to, limit)
export type PltSearchFilters = {
  tokenId?: string;
  from?: string; // ISO date
  to?: string;   // ISO date
  limit?: number;
};

// tiny helper – keep filters clean
function parseFilters(q: any): PltSearchFilters {
  const limit =
    typeof q?.limit === "string" ? Number(q.limit) :
    typeof q?.limit === "number" ? q.limit : 25;
  const tokenId = typeof q?.tokenId === "string" ? q.tokenId : undefined;
  const from = typeof q?.from === "string" ? q.from : undefined;
  const to = typeof q?.to === "string" ? q.to : undefined;
  return { tokenId, from, to, limit: Number.isFinite(limit) && limit > 0 ? limit : 25 };
}

export default async function routes(server: FastifyInstance) {
  // GET /v1/crp/payments/search
  server.get(
    "/payments/search",
    async (
      req: FastifyRequest<{ Querystring: Partial<PltSearchFilters> }>,
    ) => {
      const reqId = `plt-${randomUUID().slice(0, 8)}-${randomUUID().slice(0, 6)}`;
      const filters = parseFilters(req.query);

      // Always respond quickly
      server.log.info({ reqId, filters }, "PLT search request received");
      server.log.info({ reqId }, "PLT traversal start");

      // ---- M2: no traversal yet; return empty matches. ----
      // Traversal can happen in the background/task later if desired.
      const matches: any[] = [];
      const stats = { scannedBlocks: 0, scannedEvents: 0 };

      server.log.info({ reqId, matchesCount: matches.length, stats }, "PLT traversal complete");
      return { ok: true, filters, matches };
    }
  );
}
