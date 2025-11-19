// src/server.ts
import "dotenv/config";
import Fastify, { FastifyInstance, FastifyPluginCallback } from "fastify";

// --- Route modules (robust importing: default OR named) ---
import * as jwksMod from "./routes/jwks";
import * as adminMod from "./routes/admin";
import * as verifyMod from "./routes/verify";
import * as challengesMod from "./routes/challenges";

import * as crpReadsMod from "./routes/crp.reads";
import * as crpPaymentsMod from "./routes/crp.payments";
import * as crpHealthMod from "./routes/crp.health";

// New: exact-match alias plugin
import crpExactMatchAliasPlugin from "./http/crpExactMatchAlias";

// --- Small helper to register either default export or the module itself ---
function asPlugin(mod: any): FastifyPluginCallback {
  if (mod && typeof mod.default === "function") return mod.default as FastifyPluginCallback;
  if (typeof mod === "function") return mod as FastifyPluginCallback;
  if (mod && typeof mod.routes === "function") return mod.routes as FastifyPluginCallback;
  throw new Error("Route module is not a Fastify plugin function");
}

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: true,
    disableRequestLogging: false,
  });

  // --- Basic liveness ---
  server.get("/healthz", async () => ({ ok: true }));

  // --- Core routes (no prefix) ---
  server.register(asPlugin(jwksMod));
  server.register(asPlugin(adminMod));
  server.register(asPlugin(verifyMod));
  server.register(asPlugin(challengesMod));

  // --- CRP routes with prefix /v1/crp ---
  server.register(asPlugin(crpHealthMod), { prefix: "/v1/crp" });
  server.register(asPlugin(crpReadsMod), { prefix: "/v1/crp" });
  server.register(asPlugin(crpPaymentsMod), { prefix: "/v1/crp" });

  // NEW: exact-tuple alias endpoint under the same /v1/crp namespace.
  // We register this one directly (no asPlugin wrapper) to avoid ambiguity.
  server.register(crpExactMatchAliasPlugin, { prefix: "/v1/crp" });

  // Not found handler (keeps default Fastify 404 body but ensures logging)
  server.setNotFoundHandler((req, reply) => {
    req.log.info(
      { url: req.raw.url, method: req.raw.method },
      "Route not found"
    );
    reply
      .code(404)
      .send({
        message: `Route ${req.method}:${req.url} not found`,
        error: "Not Found",
        statusCode: 404,
      });
  });

  return server;
}

async function start() {
  try {
    const server = await buildServer();
    const host = process.env.HOST || "0.0.0.0";
    const port = Number(process.env.PORT || 8080);

    await server.listen({ host, port });

    // Convenience log lines to mirror what you’ve been seeing
    const addrs = server.addresses();
    if (Array.isArray(addrs)) {
      for (const addr of addrs) {
        server.log.info(
          `Server listening at http://${(addr as any).address}:${(addr as any).port}`
        );
      }
    }
    server.log.info("UFX listening on :%d", port);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  }
}

// Run only if executed directly
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  start();
}
