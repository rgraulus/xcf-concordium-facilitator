import Fastify from "fastify";
const app = Fastify({ logger: true });

import { routes as challengeRoutes } from "./routes/challenges";
app.register(challengeRoutes);


const port = Number(process.env.PORT || 8080);
app.listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`UFX listening on :${port}`))
  .catch(err => { app.log.error(err); process.exit(1); });

