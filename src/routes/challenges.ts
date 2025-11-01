// src/routes/challenges.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { repo, Challenge } from "../store";
import { compileChallengeValidator } from "../validation/ajv";
import crypto from "node:crypto";

function stableStringify(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const keys = Object.keys(v).sort();
  const o: any = {};
  for (const k of keys) o[k] = v[k];
  return JSON.stringify(o);
}

function samePayload(a: any, b: any): boolean {
  return (
    a.network === b.network &&
    a.amount === b.amount &&
    a.pay_to === b.pay_to &&
    a.expiry === b.expiry &&
    stableStringify(a.asset) === stableStringify(b.asset) &&
    stableStringify(a.policy ?? null) === stableStringify(b.policy ?? null) &&
    stableStringify(a.metadata ?? null) === stableStringify(b.metadata ?? null)
  );
}

export async function routes(fastify: FastifyInstance) {
  const validateChallenge = compileChallengeValidator(); // Ajv compiled fn

  // POST /v1/challenges  — create/register challenge (idempotent on merchant_id+nonce)
  fastify.post(
    "/v1/challenges",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as any;

      // 1) Validate schema
      const ok = validateChallenge(body);
      if (!ok) {
        return reply.status(400).send({
          error: "invalid_request",
          details: validateChallenge.errors,
        });
      }

      // 2) Merchant ID from header (adjust if you carry it differently)
      const merchant_id =
        (req.headers["x-merchant-id"] as string) ??
        (req.headers["x-merchant"] as string);
      if (!merchant_id) {
        return reply.status(401).send({ error: "missing_merchant_id" });
      }

      // 3) Canonicalize input
      const incoming: Challenge = {
        merchant_id,
        nonce: body.nonce || crypto.randomUUID(),
        network: body.network,
        asset: body.asset,
        amount: body.amount,
        pay_to: body.pay_to,
        expiry: body.expiry,
        policy: body.policy,
        metadata: body.metadata,
      };

      // 4) Idempotency check
      const existing = await repo.getChallenge(incoming.merchant_id, incoming.nonce);
      if (existing) {
        if (samePayload(existing, incoming)) {
          // identical -> idempotent OK
          return reply.status(200).send({
            nonce: existing.nonce,
            status: existing.status,
            challenge: existing,
          });
        }
        // conflicting -> 409
        return reply.status(409).send({
          error: "conflict",
          message:
            "Challenge with the same (merchant_id, nonce) exists with different payload.",
        });
      }

      // 5) First insert (status defaults to 'pending' in DB)
      const saved = await repo.upsertChallenge(incoming);
      return reply.status(201).send({
        nonce: saved.nonce,
        status: saved.status,
        challenge: saved,
      });
    }
  );

  // GET /v1/challenges/:nonce/status  — poll challenge status
  fastify.get(
    "/v1/challenges/:nonce/status",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const merchant_id =
        (req.headers["x-merchant-id"] as string) ??
        (req.headers["x-merchant"] as string);
      if (!merchant_id) {
        return reply.status(401).send({ error: "missing_merchant_id" });
      }

      const { nonce } = req.params as { nonce: string };
      const row = await repo.getChallenge(merchant_id, nonce);
      if (!row) return reply.status(404).send({ error: "not_found" });

      return reply.send({
        nonce: row.nonce,
        status: row.status,
        challenge: row,
      });
    }
  );
}
