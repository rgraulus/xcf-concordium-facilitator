// src/routes/challenges.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { repo, type Asset, type Status, type Challenge } from "../store";
import { normalizeNetworkId } from "../lib/networkId";

type ChallengeBody = {
  nonce: string;
  network: string;
  asset: Asset;
  amount: string;
  pay_to: string;
  expiry: string; // ISO8601
  policy?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

function normalizeObj<T extends object | null | undefined>(v: T): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  return (typeof v === "object" ? (v as Record<string, unknown>) : {}) || {};
}

function toIso(s: string): string {
  return new Date(s).toISOString();
}

export async function routes(app: FastifyInstance) {
  // POST /v1/challenges
  app.post(
    "/v1/challenges",
    async (
      request: FastifyRequest<{ Body: ChallengeBody }>,
      reply: FastifyReply
    ) => {
      const merchant_id = request.headers["x-merchant-id"] as string | undefined;
      if (!merchant_id || !merchant_id.trim()) {
        return reply.code(400).send({ error: "missing_header", message: "X-Merchant-Id required" });
      }

      const b = request.body;
      if (!b || !b.nonce || !b.network || !b.asset || !b.amount || !b.pay_to || !b.expiry) {
        return reply.code(400).send({ error: "invalid_body", message: "Missing required fields" });
      }

      // Canonicalize network id (CAIP-2 for Concordium when applicable)
      const network = normalizeNetworkId(String(b.network ?? "").trim());

      app.log.info(
        { merchantId: merchant_id, receivedBody: b, normalizedNetwork: network },
        "DEBUG incoming challenge"
      );

      const payload: Omit<Challenge, "status" | "receipt" | "created_at" | "updated_at"> & {
        status?: Status;
      } = {
        merchant_id,
        nonce: b.nonce,
        network,
        asset: b.asset,
        amount: b.amount,
        pay_to: b.pay_to,
        expiry: toIso(b.expiry),
        policy: normalizeObj(b.policy ?? {}),
        metadata: normalizeObj(b.metadata ?? {}),
        status: "pending",
      };

      const result = await repo.upsertChallenge(payload);

      // Narrow the union by checking 'row' existence
      if ("row" in result && result.row) {
        const ch = result.row;
        if (result.created) {
          // First insert → 201
          return reply.code(201).send({
            nonce: ch.nonce,
            status: ch.status,
            challenge: ch,
          });
        }
        if (result.samePayload) {
          // Idempotent re-post → 200
          return reply.code(200).send({
            nonce: ch.nonce,
            status: ch.status,
            challenge: ch,
          });
        }
      }

      // Otherwise: existing row differs → 409
      return reply.code(409).send({
        error: "conflict",
        message: "Challenge with the same (merchant_id, nonce) exists with different payload.",
      });
    }
  );

  // GET /v1/challenges/:nonce/status
  app.get(
    "/v1/challenges/:nonce/status",
    async (
      request: FastifyRequest<{ Params: { nonce: string } }>,
      reply: FastifyReply
    ) => {
      const merchant_id = request.headers["x-merchant-id"] as string | undefined;
      if (!merchant_id || !merchant_id.trim()) {
        return reply.code(400).send({ error: "missing_header", message: "X-Merchant-Id required" });
      }

      const { nonce } = request.params;
      const row = await repo.getStatus?.(merchant_id, nonce);
      if (!row) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send({
        nonce: row.nonce,
        status: row.status,
        challenge: row,
      });
    }
  );
}
