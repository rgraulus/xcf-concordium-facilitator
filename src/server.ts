// src/server.ts
import Fastify from "fastify";
import dotenv from "dotenv";

dotenv.config(); // load .env for JWS keys, etc.

import { routes as challengeRoutes } from "./routes/challenges";
import { routes as jwksRoutes } from "./routes/jwks";
import { routes as verifyRoutes } from "./routes/verify";
import { routes as adminRoutes } from "./routes/admin";
// Robust import that supports default export OR { routes } OR module-as-function
import * as crpHealth from "./routes/crp.health";

const app = Fastify({ logger: true });

// Register routes (once each)
app.register(challengeRoutes);
app.register(jwksRoutes);
app.register(verifyRoutes);
app.register(adminRoutes);

// Resolve the health plugin from whatever the module exports
const crpHealthPlugin =
  (crpHealth as any).default ?? (crpHealth as any).routes ?? (crpHealth as any);

if (typeof crpHealthPlugin === "function") {
  app.register(crpHealthPlugin);
} else {
  app.log.warn(
    "crp.health did not export a Fastify plugin (default or `routes`). Skipping registration."
  );
}

// Start server
const port = Number(process.env.PORT || 8080);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`UFX listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
