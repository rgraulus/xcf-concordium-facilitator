import { FastifyInstance } from "fastify";
import { repo } from "../store";
import { signJws } from "../crypto/signer";

export async function routes(app: FastifyInstance) {
  app.post("/v1/admin/fulfill", async (req, reply) => {
    const body = req.body as {
      merchant_id?: string;
      nonce?: string;
      receipt?: Record<string, unknown>;
    };

    const merchant_id = body?.merchant_id;
    const nonce = body?.nonce;
    const receipt = body?.receipt;

    if (!merchant_id || !nonce || !receipt) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "merchant_id, nonce and receipt are required",
      });
    }

    const jws = signJws(receipt);
    await repo.markFulfilled(merchant_id, nonce, receipt, jws);

    return reply.code(200).send({ merchant_id, nonce, jws });
  });
}
