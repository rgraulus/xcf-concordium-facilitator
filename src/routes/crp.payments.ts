// src/routes/crp.payments.ts
import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { searchPltPayments, type PltSearchFilters } from "../crp/grpc";

export default fp(async function routes(server: FastifyInstance) {
  server.get("/v1/crp/payments/search", async (req, reply) => {
    const q = req.query as Partial<PltSearchFilters>;
    const filters: PltSearchFilters = {
      tokenId: q.tokenId,
      fromBlock: q.fromBlock,
      limit: q.limit ? Math.max(1, Math.min(100, Number(q.limit))) : 25,
    };

    const result = await searchPltPayments(filters);
    reply.send(result);
  });
});
