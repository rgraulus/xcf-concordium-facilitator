// src/http/crpExactMatchAlias.ts
//
// Simple alias/stub endpoint for an "exact-tuple" CRP payment match.
// Registered under the /v1/crp prefix by src/server.ts, so the full
// path is: POST /v1/crp/payments/exact-match
//
// For now this does not call into internal CRP services; it simply
// validates the request shape and echoes it back in a stable JSON
// envelope. This keeps the wiring safe and future-proof.

import { FastifyPluginCallback } from "fastify";

export interface ExactMatchRequestBody {
  merchantId: string;
  network: string; // e.g. "concordium:testnet"
  tokenId: string; // e.g. "usd:test"
  payTo: string;   // e.g. "ccd1qexampleaddress"
  amount: string;  // human-readable decimal string, e.g. "25.00"
  nonce: string;   // unique payment nonce
}

export interface ExactMatchAliasResponse {
  ok: boolean;
  kind: "crp.exact-match.alias.demo";
  request: ExactMatchRequestBody;
  notes: string[];
}

const crpExactMatchAliasPlugin: FastifyPluginCallback = (fastify, _opts, done) => {
  // Simple ping route so we can prove the plugin is mounted:
  fastify.get("/payments/exact-match/ping", async () => ({
    ok: true,
    kind: "crp.exact-match.alias.ping",
  }));

  fastify.post<{ Body: ExactMatchRequestBody }>(
    "/payments/exact-match",
    async (request, reply)
      : Promise<ExactMatchAliasResponse | { ok: false; error: string; missing?: string[] }> => {
      const body = request.body;

      // Minimal shape validation: all fields must be non-empty strings.
      const requiredFields: (keyof ExactMatchRequestBody)[] = [
        "merchantId",
        "network",
        "tokenId",
        "payTo",
        "amount",
        "nonce",
      ];

      const missing = requiredFields.filter((key) => {
        const v = body?.[key];
        return typeof v !== "string" || v.trim() === "";
      });

      if (missing.length > 0) {
        reply.code(400);
        return {
          ok: false,
          error: "Missing or invalid required fields",
          missing,
        };
      }

      const notes: string[] = [
        "This is a demo alias endpoint for exact-tuple matches.",
        "In a future revision, this will delegate into the internal CRP payment match/fulfill logic.",
      ];

      // Happy path: echo the request in a stable envelope.
      return {
        ok: true,
        kind: "crp.exact-match.alias.demo",
        request: body,
        notes,
      };
    }
  );

  done();
};

export default crpExactMatchAliasPlugin;
