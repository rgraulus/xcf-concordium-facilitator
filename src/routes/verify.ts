import { FastifyInstance } from "fastify";
import { verifyJws, getPublicJwk } from "../crypto/signer";

export async function routes(app: FastifyInstance) {
  app.post("/v1/verify", async (req, reply) => {
    const body = req.body as { jws?: string };
    if (!body?.jws) {
      return reply.code(400).send({ error: "invalid_request", message: "jws is required" });
    }

    const res = verifyJws(body.jws);
    if (!res.valid) {
      return reply.code(400).send({ valid: false, error: res.error });
    }

    const pub = getPublicJwk();
    return reply.send({ valid: true, header: res.header, payload: res.payload, kid: pub.kid });
  });
}
