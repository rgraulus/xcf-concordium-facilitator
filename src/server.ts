// src/server.ts
import Fastify from "fastify";
import { routes as challengeRoutes } from "./routes/challenges";
// (later) import receipts, jwks, etc.

const app = Fastify({ logger: true });

app.register(challengeRoutes);

// (later) app.register(receiptRoutes); app.register(jwksRoutes);

const port = Number(process.env.PORT || 8080);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`UFX listening on :${port}`);
});

