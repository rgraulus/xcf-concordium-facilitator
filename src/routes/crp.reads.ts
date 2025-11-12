import type { FastifyInstance } from "fastify";
import { getQueriesClient, mapConsensusInfoToSummary, isProbablyAccountAddress } from "../crp/grpc";

export default async function routes(server: FastifyInstance) {
  // GET /v1/crp/consensus
  server.get("/consensus", async (_req, _reply) => {
    const q = getQueriesClient();
    // v2 QueriesClient method:
    const { response } = await q.getConsensusInfo({}, {});
    const summary = mapConsensusInfoToSummary(response);
    return {
      ok: true,
      consensus: summary.consensus,
      blocks: summary.blocks,
      network: process.env.CONCORDIUM_NETWORK || "unknown",
    };
  });

  // GET /v1/crp/account/:address (simple validation-only placeholder)
  server.get("/account/:address", async (req, reply) => {
    const addr = (req.params as any).address as string;
    if (!isProbablyAccountAddress(addr)) {
      reply.code(400).send({ error: "Invalid address" });
      return;
    }
    // Minimal success placeholder (you can flesh this out later)
    return { ok: true, address: addr };
  });
}
