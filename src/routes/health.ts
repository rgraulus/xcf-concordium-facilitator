// src/routes/health.ts

import { FastifyPluginAsync } from "fastify";

/**
 * Simple health route for Kubernetes / container liveness checks.
 * Exposes:
 *   GET /healthz -> { ok: true }
 */
const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/healthz", async () => {
    return { ok: true };
  });
};

export default healthRoute;
