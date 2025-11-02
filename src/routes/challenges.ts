// src/routes/challenges.ts
import { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { FastifyRequest, FastifyReply } from "fastify";
import { compileChallengeValidator } from "../validation/ajv";
import { repo } from "../store";
import type { Challenge, Status } from "../store";

// ---- Types for request body (explicit & nullable-friendly) ----
type Asset = {
  type: "PLT";
  tokenId: string;
  decimals: number;
};

type ChallengeBody = {
  nonce: string;
  network: string; // e.g., "concordium:testnet"
  asset: Asset;
  amount: string;  // "25.00" (major units)
  pay_to: string;  // recipient address
  expiry: string;  // ISO date-time
  policy?: Record<string, unknown> | null;   // nullable input allowed
  metadata?: Record<string, unknown> | null; // nullable input allowed
};

const validateChallenge = compileChallengeValidator();

export function routes(app: FastifyInstance, _opts: FastifyPluginOptions, done: () => void) {
  // POST /v1/challenges  — upsert with idempotency (nonce scoped per merchant)
  app.post(
    "/v1/challenges",
    async (request: FastifyRequest<{ Body: ChallengeBody }>, reply: FastifyReply) => {
      const merchant_id = String(request.headers["x-merchant-id"] || "").trim();
      if (!merchant_id) {
        return reply.code(400).send({ error: "missing_header", message: "X-Merchant-Id header is required." });
      }

      const body = request.body;

      // Validate against JSON Schema (Ajv)
      const valid = validateChallenge(body as unknown as Record<string, unknown>);
      if (!valid) {
        return reply.code(400).send({ error: "invalid_body", details: validateChallenge.errors || [] });
      }

      // Coerce nullable policy/metadata to plain objects (match repo types)
      const {
        nonce,
        network,
        asset,
        amount,
        pay_to,
        expiry,
        policy = null,
        metadata = null,
      } = body;

      const policyObj = (policy ?? {}) as Record<string, any>;
      const metadataObj = (metadata ?? {}) as Record<string, any>;

      // Payload persisted & compared for idempotency
      const payload: Omit<Challenge,
        "status" | "receipt" | "created_at" | "updated_at"> & { status?: Status } = {
        merchant_id,
        nonce,
        network,
        asset,
        amount,
        pay_to,
        expiry,
        policy: policyObj,
        metadata: metadataObj,
        status: "pending",
      };

      // Helpful debug line while we’re iterating locally
      app.log.info({ merchantId: merchant_id, receivedBody: body }, "DEBUG incoming challenge");

      // Upsert with idempotency
      const result = await repo.upsertChallenge(payload);

      // Read back the row so we can echo the canonical DB view
      const saved = await repo.getChallenge(merchant_id, nonce);

      // Fallback to payload if (unexpectedly) not found
      const challenge = saved ?? {
        merchant_id,
        nonce,
        network,
        asset,
        amount,
        pay_to,
        expiry,
        policy: policyObj,
        metadata: metadataObj,
        status: "pending" as const,
      };

      if (result.created) {
        return reply.code(201).send({ nonce, status: "pending", challenge });
      }
      if (result.samePayload) {
        return reply.code(200).send({ nonce, status: "pending", challenge });
      }
      return reply
        .code(409)
        .send({ error: "conflict", message: "Challenge with the same (merchant_id, nonce) exists with different payload." });
    }
  );

  // GET /v1/challenges/:nonce/status — read current status
  app.get(
    "/v1/challenges/:nonce/status",
    async (
      request: FastifyRequest<{ Params: { nonce: string } }>,
      reply: FastifyReply
    ) => {
      const merchant_id = String(request.headers["x-merchant-id"] || "").trim();
      if (!merchant_id) {
        return reply.code(400).send({ error: "missing_header", message: "X-Merchant-Id header is required." });
      }

      const { nonce } = request.params;
      const row = await repo.getChallenge(merchant_id, nonce);
      if (!row) return reply.code(404).send({ error: "not_found" });

      return reply.code(200).send({
        nonce,
        status: row.status,
        challenge: row,
      });
    }
  );

  done();
}

export default routes;
