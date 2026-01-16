// src/server.ts
//
// Fastify server wiring for XCF Concordium Facilitator.

import "dotenv/config";

import fastify, { FastifyInstance } from "fastify";

// Health + base CRP routes (consensus, account, etc.)
import healthRoute from "./routes/health";
import crpReadsRoute from "./routes/crp.reads";

// JWKS + Verify (JWS)
import jwksRoute from "./routes/jwks";
import { routes as verifyRoute } from "./routes/verify";

// PLT search over crp_plt_events (backed by Postgres)
import crpPltRoute from "./routes/crp.plt";

// PLT events HTTP data-plane routes (/v1/crp/plt/events)
import pltEventsRoute from "./http/pltEventsRoute";

// Operational readiness (/readyz) – DB + wallet-proxy checks
import readyzRoute from "./http/readyz";

// JSON metrics endpoint (/metrics)
import metricsRoute from "./http/metrics";

// CRP payments routes (/v1/crp/payments/*)
import crpPaymentsRoute from "./routes/crp.payments";

// Challenges route (/v1/challenges/*)
import { routes as challengesRoute } from "./routes/challenges";


// GET alias for exact match: /v1/crp/payments/exact-match
import crpExactMatchAliasRoute from "./http/crpExactMatchAlias";

export function buildServer(): FastifyInstance {
  const app = fastify({ logger: true });

  // Operational readiness first, so orchestrators can probe quickly.
  app.register(readyzRoute);

  // Basic health checks
  app.register(healthRoute);

  // JWKS + Verify (no prefix unless your route file expects one)
  app.register(jwksRoute);
  app.register(verifyRoute);

  // Metrics endpoint (debug/ops)
  app.register(metricsRoute);

  // Challenges (create + status)
  app.register(challengesRoute);


  // Core CRP routes (consensus, accounts, etc.)
  app.register(crpReadsRoute, { prefix: "/v1/crp" });

  // PLT search route: /v1/crp/plt/search
  app.register(crpPltRoute);

  // PLT events data-plane route: /v1/crp/plt/events
  app.register(pltEventsRoute);

  // CRP payments routes under /v1/crp/payments/*
  app.register(crpPaymentsRoute, { prefix: "/v1/crp" });

  // GET alias route under /v1/crp/payments/exact-match
  app.register(crpExactMatchAliasRoute, { prefix: "/v1/crp" });

  return app;
}

// When run as "node dist/server.js" or "ts-node src/server.ts"
if (require.main === module) {
  const app = buildServer();

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";

  app
    .listen({ port, host })
    .then(() => app.log.info({ port, host }, "Server listening"))
    .catch((err) => {
      app.log.error({ err }, "Failed to start server");
      process.exit(1);
    });
}

export default buildServer;
