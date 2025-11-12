// src/routes/crp.health.ts
import type { FastifyInstance } from "fastify";
import { getGrpcConfig, getTransportDiagnostics } from "../crp/grpc";

export default async function routes(server: FastifyInstance) {
  server.get("/health", async () => {
    const cfg = getGrpcConfig();
    const diag = await getTransportDiagnostics();
    return {
      ok: true,
      grpc: {
        host: cfg.host,
        port: cfg.port,
        tls: cfg.tls,
        network: cfg.network,
        hasCAFile: Boolean(cfg.caFile),
        transport: diag,
      },
    };
  });
}
