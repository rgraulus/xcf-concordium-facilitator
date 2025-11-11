// src/server.ts
import Fastify from "fastify";
import dotenv from "dotenv";

dotenv.config(); // load .env for JWS keys, etc.

import { routes as challengeRoutes } from "./routes/challenges";
import { routes as jwksRoutes } from "./routes/jwks";
import { routes as verifyRoutes } from "./routes/verify";
import { routes as adminRoutes } from "./routes/admin";
import crpHealthRoutes from "./routes/crp.health";
import { routes as crpReadsRoutes } from "./routes/crp.reads";      // <-- named import
import { routes as crpPaymentsRoutes } from "./routes/crp.payments"; // <-- named import

const app = Fastify({ logger: true });

// Optional: print mounted routes at boot if PRINT_ROUTES=1
if (process.env.PRINT_ROUTES === "1") {
  app.addHook("onReady", async () => {
    // @ts-ignore
    app.log.info("\n" + app.printRoutes());
  });
}

// Register routes (once each)
app.register(challengeRoutes);
app.register(jwksRoutes);
app.register(verifyRoutes);
app.register(adminRoutes);
app.register(crpHealthRoutes);
app.register(crpReadsRoutes);
app.register(crpPaymentsRoutes);

// Start server
const port = Number(process.env.PORT || 8080);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`UFX listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

export default app;
