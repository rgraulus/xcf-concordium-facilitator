// src/routes/crp.reads.ts
import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { getBestAndFinalized, getGrpcConfig } from "../crp/grpc";

export default fp(async function routes(server: FastifyInstance) {
  server.get("/v1/crp/consensus", async (_req, reply) => {
    const cfg = getGrpcConfig();
    const data = await getBestAndFinalized();

    // Keep the response shape you’ve been using in smoke scripts.
    return reply.send({
      ok: true,
      consensus: {
        genesisIndex: data.consensus?.genesisIndex,
        bestBlock: data.consensus?.bestBlock,
      },
      blocks: data.blocks, // { best: {hash,height}, finalized: {hash,height} }
      network: cfg.network,
    });
  });

  server.get("/v1/crp/account/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    // We keep the validation behavior (400 on bad format) via your existing AJV schema.
    // If validation already catches INVALID, we just return 400 automatically via Fastify.
    // No body is required here.
    reply.code(400).send({ error: "Bad Request" });
  });
});
