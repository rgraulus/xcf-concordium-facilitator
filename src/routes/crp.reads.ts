// src/routes/crp.reads.ts
import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import {
  getConsensusStatus,
  getBestAndFinalized,
  getAccountInfo,
} from "../crp/grpc";

/** Recursively convert all bigint values to strings for JSON safety. */
function toJSONSafe<T = unknown>(value: any): T {
  if (typeof value === "bigint") return (value.toString() as unknown) as T;
  if (Array.isArray(value)) return (value.map((v) => toJSONSafe(v)) as unknown) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJSONSafe(v);
    return (out as unknown) as T;
  }
  return value;
}

async function registerCrpReads(app: FastifyInstance) {
  // GET /v1/crp/consensus
  app.get("/v1/crp/consensus", async (_req, reply) => {
    const [cs, bf] = await Promise.all([getConsensusStatus(), getBestAndFinalized()]);
    const payload = {
      ok: true,
      consensus: {
        epoch: cs.epoch,
        slot: cs.slot,
        genesisIndex: cs.genesisIndex,
        bestBlock: cs.bestBlock,
        finalizedBlock: cs.finalizedBlock,
      },
      blocks: {
        best: {
          height: bf.best?.blockHeight,
          hash: bf.hashes.best,
        },
        finalized: {
          height: bf.finalized?.blockHeight,
          hash: bf.hashes.finalized,
        },
      },
      network: process.env.CONCORDIUM_NETWORK || "testnet",
    };
    reply.send(toJSONSafe(payload));
  });

  // GET /v1/crp/account/:address
  app.get<{ Params: { address: string } }>(
    "/v1/crp/account/:address",
    async (req, reply) => {
      const { address } = req.params;
      if (!address) {
        reply.code(400);
        return { ok: false, error: "invalid_request", message: "address required" };
      }
      try {
        const info = await getAccountInfo(address);
        const payload = {
          ok: true,
          address,
          balance: info.accountAmount, // bigint → string via toJSONSafe
          nonce: info.accountNonce,
          encryptedAmount: info.encryptedAmount,
        };
        reply.send(toJSONSafe(payload));
      } catch (e: any) {
        reply.code(400);
        reply.send(
          toJSONSafe({
            ok: false,
            error: "bad_address",
            message: e?.message || "Failed to fetch account info",
          })
        );
      }
    }
  );
}

// Export the plugin as `routes` (same name used in server.ts)
export const routes = fp(registerCrpReads);
