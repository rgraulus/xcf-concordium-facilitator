// src/routes/crp.payments.ts
import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { PltSearchFilters, searchPltPayments } from "../crp/grpc";

/** BigInt-safe stringify helper */
function safeJson<T>(v: T): any {
  return JSON.parse(
    JSON.stringify(v, (_, val) => (typeof val === "bigint" ? String(val) : val))
  );
}

async function paymentsRoutes(app: FastifyInstance) {
  // GET /v1/crp/payments/search?tokenId=...&to=...&min=...&fromHeight=...&limit=...
  app.get("/v1/crp/payments/search", async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;

    const filters: PltSearchFilters = {
      tokenId: q.tokenId?.trim() || undefined,
      to: q.to?.trim() || undefined,
      min: q.min?.trim() || undefined,
      fromHeight: q.fromHeight?.trim() || undefined,
      limit: q.limit ? Math.max(0, Math.min(100, Number(q.limit))) : 25, // sane cap
    };

    // basic validation
    if (filters.min && !/^\d+$/.test(filters.min)) {
      reply.code(400);
      return { ok: false, error: "invalid_min", message: "min must be an integer string of base units" };
    }
    if (filters.limit && !Number.isFinite(filters.limit)) {
      reply.code(400);
      return { ok: false, error: "invalid_limit", message: "limit must be a number" };
    }

    const matches = await searchPltPayments(filters);
    return safeJson({ ok: true, filters, matches });
  });
}

export const routes = fp(paymentsRoutes);
