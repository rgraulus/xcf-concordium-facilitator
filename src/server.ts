// src/server.ts
import Fastify from "fastify";
import dotenv from "dotenv";

dotenv.config(); // load .env for JWS keys, DB, GRPC, etc.

import { routes as challengeRoutes } from "./routes/challenges";
import { routes as jwksRoutes } from "./routes/jwks";
import { routes as verifyRoutes } from "./routes/verify";
import { routes as adminRoutes } from "./routes/admin";

// Robust imports that support default export, named `routes`, or module-as-plugin
import * as crpHealth from "./routes/crp.health";
import * as crpReads from "./routes/crp.reads";

const app = Fastify({ logger: true });

// Register routes (once each)
app.register(challengeRoutes);
app.register(jwksRoutes);
app.register(verifyRoutes);
app.register(adminRoutes);

// Resolve plugins from whatever the modules export
const crpHealthPlugin =
  (crpHealth as any).default ?? (crpHealth as any).routes ?? (crpHealth as any);
const crpReadsPlugin =
  (crpReads as any).default ?? (crpReads as any).routes ?? (crpReads as any);

if (typeof crpHealthPlugin === "function") {
  app.register(crpHealthPlugin);
} else {
  app.log.warn("crp.health did not export a Fastify plugin (default or `routes`). Skipping.");
}

if (typeof crpReadsPlugin === "function") {
  app.register(crpReadsPlugin);
} else {
  app.log.warn("crp.reads did not export a Fastify plugin (default or `routes`). Skipping.");
}

// Optional: print the mounted route tree on boot
app.ready().then(() => {
  if (process.env.PRINT_ROUTES === "1") {
    app.log.info("\n" + app.printRoutes());
  }
});

// Start server
const port = Number(process.env.PORT || 8080);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`UFX listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
