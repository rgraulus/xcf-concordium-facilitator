// src/routes/challenges.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { repo, Challenge } from "../store";
import { compileChallengeValidator } from "../validation/ajv";
import crypto from "node:crypto";

type ChallengeBody = {
  network: string;
  asset: any;
  amount: string;      // major units as string (e.g., "25.00")
  pay_to: string;
  expiry: string;      // ISO 8601
  nonce?: string;
  policy?: any;
  metadata?: any;
};


function normExpiry(v: unknown): number | null {
  if (v instanceof Date) {
    return v.getTime();                // DB row via pg → Date
  }
  if (typeof v === "string") {
    const t = Date.parse(v);           // request body → ISO string
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function stableStringifyDeep(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringifyDeep).join(",")}]`;
  const keys = Object.keys(v).sort();
  const o: any = {};
  for (const k of keys) o[k] = v[k];
  return JSON.stringify(o);
}

function samePayload(a: any, b: any): boolean {
  // Simple scalars
  if (String(a.network) !== String(b.network)) return false;
  if (String(a.amount) !== String(b.amount)) return false;
  if (String(a.pay_to) !== String(b.pay_to)) return false;

  // Normalize expiry (handles "…Z" vs "…000Z")
  if (normExpiry(a.expiry) !== normExpiry(b.expiry)) return false;

  // Structured fields
  if (stableStringifyDeep(a.asset)    !== stableStringifyDeep(b.asset))    return false;
  if (stableStringifyDeep(a.policy ?? null)   !== stableStringifyDeep(b.policy ?? null))   return false;
  if (stableStringifyDeep(a.metadata ?? null) !== stableStringifyDeep(b.metadata ?? null)) return false;

  return true;
}

export async function routes(fastify: FastifyInstance) {
  const validateChallenge = compileChallengeValidator(); // Ajv compiled fn

  // POST /v1/challenges  — create/register challenge (idempotent on merchant_id+nonce)
  fastify.post(
    "/v1/challenges",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as ChallengeBody;

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
