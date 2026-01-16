// src/routes/jwks.ts
import type { FastifyPluginAsync } from "fastify";
import { jwks } from "../crypto/signer";

/**
 * Public JWKS endpoint for verifying facilitator signatures.
 *
 * Canonical:
 *   GET /jwks -> { keys: [...] }
 *
 * Standards-friendly alias:
 *   GET /.well-known/jwks.json -> { keys: [...] }
 */
const jwksRoute: FastifyPluginAsync = async (app) => {
  const handler = async (_req: any, reply: any) => {
    // Optional: cache for a while
    reply.header("cache-control", "public, max-age=300");
    return jwks();
  };

  app.get("/jwks", handler);
  app.get("/.well-known/jwks.json", handler);
};

export default jwksRoute;
