import { FastifyInstance } from "fastify";
import { jwks } from "../crypto/signer";

export async function routes(app: FastifyInstance) {
  app.get("/.well-known/jwks.json", async (_req, reply) => {
    return reply.send(jwks());
  });
}
