// src/server.ts
//
// Fastify server wiring for XCF Concordium Facilitator.
// - Wires health routes
// - Wires /readyz operational readiness route
// - Wires /metrics JSON metrics endpoint
// - Wires CRP core routes (/v1/crp/*)
// - Wires PLT search route (/v1/crp/plt/search)
// - Wires CRP payments routes (/v1/crp/payments/*)

import fastify, { FastifyInstance } from "fastify";

// Health + base CRP routes (consensus, account, etc.)
import healthRoute from "./routes/health";
import crpRoutes from "./routes/crp";

// PLT search over crp_plt_events (backed by Postgres)
import crpPltRoute from "./routes/crp.plt";

// Operational readiness (/readyz) – DB + wallet-proxy checks
import readyzRoute from "./http/readyz";

// JSON metrics endpoint (/metrics)
import metricsRoute from "./http/metrics";

// CRP payments routes (/v1/crp/payments/*)
import crpPaymentsRoute from "./routes/crp.payments";

export function buildServer(): FastifyInstance {
  const app = fastify({
    logger: true,
  });

  // Operational readiness first, so orchestrators can probe quickly.
  app.register(readyzRoute);

  // Basic health checks
  app.register(healthRoute);

  // Metrics endpoint (debug/ops)
  app.register(metricsRoute);

  // Core CRP routes (consensus, accounts, etc.)
  app.register(crpRoutes);

  // PLT search route: /v1/crp/plt/search
  app.register(crpPltRoute);

  // CRP payments routes under /v1/crp/payments/*
  // The plugin itself mounts under /payments, so we prefix it with /v1/crp.
  app.register(crpPaymentsRoute, { prefix: "/v1/crp" });

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
