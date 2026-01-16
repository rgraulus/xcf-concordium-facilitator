// src/routes/health.ts

import { FastifyPluginAsync } from "fastify";

/**
 * Simple health routes for liveness checks + CRP compatibility.
 *
 * Exposes:
 *   GET /healthz       -> { ok: true }
 *   GET /v1/crp/health -> { ok: true }   (alias for older clients/docs)
 */
const healthRoute: FastifyPluginAsync = async (fastify) => {
  const handler = async () => ({ ok: true });

  // Kubernetes / container liveness
  fastify.get("/healthz", handler);

  // CRP versioned alias
  fastify.get("/v1/crp/health", handler);
};

export default healthRoute;
