// src/routes/crp.health.ts
import type { FastifyInstance } from "fastify";
import { getGrpcConfig } from "../crp/grpc";

export default async function crpHealthRoutes(app: FastifyInstance) {
  app.get("/v1/crp/health", async () => {
    // Only reads env/config; does NOT dial gRPC (keeps M1 intact)
    const cfg = getGrpcConfig();
    return {
      ok: true,
      service: "CRP",
      network: cfg.network,
      grpc: {
        host: cfg.host,
        port: cfg.port,
        tls: cfg.tls,
        caFile: cfg.caFile ?? null,
      },
    };
  });
}
