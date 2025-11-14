// src/routes/crp.reads.ts
import type { FastifyInstance } from "fastify";
import { getConsensusSummary, isProbablyAccountAddress } from "../crp/grpc";

export default async function routes(server: FastifyInstance) {
  // GET /v1/crp/consensus
  server.get("/consensus", async (_req, _reply) => {
    // getConsensusSummary() already returns: { ok, consensus, blocks, network }
    return await getConsensusSummary();
  });

  // GET /v1/crp/account/:address (simple validation-only placeholder)
  server.get("/account/:address", async (req, reply) => {
    const addr = (req.params as any).address as string;
    if (!isProbablyAccountAddress(addr)) {
      reply.code(400).send({ error: "Invalid address" });
      return;
    }
    return { ok: true, address: addr };
  });
}
