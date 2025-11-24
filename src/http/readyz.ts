// src/http/readyz.ts
//
// Minimal /readyz endpoint for operational readiness checks.
//
// Semantics:
//   - 200 OK + { ok: true }       -> process is ready; DB is reachable.
//   - 503 Service Unavailable     -> DB is not reachable.
//
// This is intentionally strict: if Postgres is down or misconfigured,
// /readyz should fail so orchestrators can avoid routing traffic here.

import type { FastifyPluginCallback } from "fastify";
import { Client } from "pg";

const readyzPlugin: FastifyPluginCallback = async (server) => {
  server.get("/readyz", async (request, reply) => {
    const databaseUrl =
      process.env.DATABASE_URL ??
      "postgres://postgres:pg@127.0.0.1:5432/postgres";

    const client = new Client({ connectionString: databaseUrl });

    try {
      await client.connect();
      await client.query("SELECT 1");

      // Ready: DB connectivity OK.
      return { ok: true };
    } catch (err) {
      request.log.error(
        { err, databaseUrl },
        "[readyz] database connectivity check failed"
      );

      reply.code(503);
      return {
        ok: false,
        reason: "db_unavailable",
      };
    } finally {
      try {
        await client.end();
      } catch {
        // ignore close errors
      }
    }
  });
};

export default readyzPlugin;
