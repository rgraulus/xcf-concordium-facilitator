// src/routes/challenges.ts
<<<<<<< Updated upstream
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
=======
import { FastifyInstance, FastifyPluginCallback } from "fastify";
import { compileChallengeValidator } from "../validation/ajv";
import { repo, Asset, Status, Challenge } from "../store";

/** Body shape for POST /v1/challenges (subset of Challenge) */
type NewChallengeInput = {
  nonce: string;
  network: string;
  asset: Asset;
  amount: string;
  pay_to: string;
  expiry: string; // ISO string
  policy?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  // We allow caller to omit; server defaults to "pending"
  status?: Status;
};

export const routes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  const validateChallenge = compileChallengeValidator();

  // Create (idempotent) challenge
  app.post("/v1/challenges", async (request, reply) => {
    const merchant_id = String(request.headers["x-merchant-id"] || "").trim();
    if (!merchant_id) {
      return reply.code(400).send({ error: "missing_header", message: "X-Merchant-Id required" });
    }

    const body = (request.body ?? {}) as Partial<NewChallengeInput>;

    // JSON Schema validation (AJV)
    if (!validateChallenge(body)) {
      return reply.code(400).send({
        error: "invalid_body",
        details: validateChallenge.errors ?? [],
      });
>>>>>>> Stashed changes
    }

<<<<<<< Updated upstream
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
=======
    // Normalize/assemble payload we persist
    const {
      nonce = "",
      network = "",
      asset = {} as Asset,
      amount = "",
      pay_to = "",
      expiry = "",
      policy = {},          // default to empty object instead of null
      metadata = {},        // default to empty object instead of null
      status = "pending",
    } = body as NewChallengeInput;

    // Debug trace of exactly what we received
    app.log.info({ merchantId: merchant_id, receivedBody: { ...body } }, "DEBUG incoming challenge");

    try {
      const upsert = await repo.upsertChallenge({
        merchant_id,
        nonce,
        network,
        asset,
        amount,
        pay_to,
        expiry,
        policy: policy ?? {},
        metadata: metadata ?? {},
        status,
      });

      // For 201/200 responses include the canonical row
      if (upsert.created || upsert.samePayload) {
        const row = upsert.row!;
        const response = {
          nonce: row.nonce,
          status: row.status,
          challenge: row,
        };
        return upsert.created
          ? reply.code(201).send(response)
          : reply.code(200).send(response);
      }

      // Conflict path (payload differs for same merchant_id+nonce)
      return reply.code(409).send({
        error: "conflict",
        message:
          "Challenge with the same (merchant_id, nonce) exists with different payload.",
      });
    } catch (err) {
      app.log.error({ err }, "failed to upsert challenge");
      return reply.code(500).send({ error: "server_error" });
    }
  });

  // Read current status
  app.get<{
    Params: { nonce: string };
  }>("/v1/challenges/:nonce/status", async (request, reply) => {
    const merchant_id = String(request.headers["x-merchant-id"] || "").trim();
    if (!merchant_id) {
      return reply.code(400).send({ error: "missing_header", message: "X-Merchant-Id required" });
    }

    const { nonce } = request.params;

    try {
      const row: Challenge | null = await repo.getStatus(merchant_id, nonce);
      if (!row) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send({
        nonce: row.nonce,
>>>>>>> Stashed changes
        status: row.status,
        challenge: row,
      });
    } catch (err) {
      app.log.error({ err }, "failed to read challenge status");
      return reply.code(500).send({ error: "server_error" });
    }
<<<<<<< Updated upstream
  );

  done();
}

export default routes;
=======
  });

  done();
};

>>>>>>> Stashed changes
