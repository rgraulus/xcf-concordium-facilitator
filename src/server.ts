// src/server.ts
//
// Fastify server wiring for XCF Concordium Facilitator.
// - Wires health routes
// - Wires /readyz operational readiness route
// - Wires CRP core routes (/v1/crp/*)
// - Wires PLT search route (/v1/crp/plt/search)

import fastify, { FastifyInstance } from "fastify";

// Health + base CRP routes (consensus, account, etc.)
import healthRoute from "./routes/health";
import crpRoutes from "./routes/crp";

// PLT search over crp_plt_events (backed by Postgres)
import crpPltRoute from "./routes/crp.plt";

// Operational readiness (/readyz) – DB + wallet-proxy checks
import readyzRoute from "./http/readyz";

export function buildServer(): FastifyInstance {
  const app = fastify({
    logger: true,
  });

  // Operational readiness first, so orchestrators can probe quickly.
  app.register(readyzRoute);

  // Basic health checks
  app.register(healthRoute);

  // Core CRP routes (consensus, accounts, etc.)
  app.register(crpRoutes);

  // PLT search route: /v1/crp/plt/search
  app.register(crpPltRoute);

  return app;
}

// When run as "node dist/server.js" or "ts-node src/server.ts"
if (require.main === module) {
  const app = buildServer();

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";

  app
    .listen({ port, host })
    .then(() => {
      app.log.info({ port, host }, "Server listening");
    })
    .catch((err) => {
      app.log.error({ err }, "Failed to start server");
      process.exit(1);
    });
}

export default buildServer;
