// src/http/readyz.ts
//
// Operational /readyz endpoint for readiness checks.
//
// Semantics:
//   - 200 OK + { ok: true, dbOk: true, walletProxyOk: true, ... }
//       -> process is "ready": DB reachable, wallet-proxy reachable (if enabled).
//   - 503 Service Unavailable
//       -> at least one critical dependency (DB, wallet-proxy) looks bad.
//
// Wallet-proxy checks can be disabled via READYZ_CHECK_WALLET_PROXY=0/false
// if needed in dev environments.
//
// This file uses the central metrics registry so that /metrics can expose
// basic readiness counters.

import type { FastifyPluginCallback } from "fastify";
import { Client } from "pg";
import * as http from "http";
import * as https from "https";
import { URL } from "url";
import {
  incrementReadyzTotalChecks,
  incrementReadyzSuccess,
  incrementReadyzDbFailures,
  incrementReadyzWalletProxyFailures,
} from "../metrics/registry";

interface DbCheckResult {
  ok: boolean;
  errorMessage?: string;
}

interface WalletProxyHealthResult {
  ok: boolean;
  reason?: string;
  statusCode?: number;
}

interface ReadyzResponseBody {
  ok: boolean;
  dbOk: boolean;
  walletProxyOk: boolean;
  details: {
    db: string;
    walletProxy: string;
  };
}

async function checkDb(databaseUrl: string): Promise<DbCheckResult> {
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    await client.query("SELECT 1");
    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      errorMessage: err?.message ?? "db_error",
    };
  } finally {
    try {
      await client.end();
    } catch {
      // ignore close errors
    }
  }
}

async function checkWalletProxyHealth(
  baseUrl: string,
  timeoutMs: number
): Promise<WalletProxyHealthResult> {
  return new Promise((resolve) => {
    let resolved = false;
    let timer: NodeJS.Timeout | undefined;

    const done = (result: WalletProxyHealthResult) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      const url = new URL("/v0/health", baseUrl);
      const isHttps = url.protocol === "https:";
      const lib = isHttps ? https : http;

      const req = lib.get(url, (res) => {
        const { statusCode } = res;
        const chunks: Buffer[] = [];

        res.on("data", (chunk) => {
          chunks.push(chunk as Buffer);
        });

        res.on("end", () => {
          const bodyStr = Buffer.concat(chunks).toString("utf8");

          if (statusCode && statusCode >= 200 && statusCode < 300) {
            // We don't deeply inspect the body here; HTTP 2xx is good enough
            // as a readiness signal.
            done({ ok: true, statusCode });
          } else {
            done({
              ok: false,
              statusCode,
              reason:
                statusCode === undefined
                  ? "no_status_code"
                  : `http_${statusCode}: ${bodyStr.slice(0, 200)}`,
            });
          }
        });
      });

      req.on("error", (err: any) => {
        done({
          ok: false,
          reason: err?.message ?? "wallet_proxy_error",
        });
      });

      timer = setTimeout(() => {
        req.destroy();
        done({
          ok: false,
          reason: "timeout",
        });
      }, timeoutMs);
    } catch (err: any) {
      done({
        ok: false,
        reason: err?.message ?? "wallet_proxy_url_error",
      });
    }
  });
}

const readyzPlugin: FastifyPluginCallback = async (server) => {
  server.get("/readyz", async (request, reply) => {
    incrementReadyzTotalChecks();

    const databaseUrl =
      process.env.DATABASE_URL ??
      "postgres://postgres:pg@127.0.0.1:5432/postgres";

    const walletProxyBaseUrl =
      process.env.WALLET_PROXY_BASE_URL ?? "http://localhost:3000";

    const walletProxyTimeoutMs = Number(
      process.env.READYZ_WALLET_PROXY_TIMEOUT_MS ?? 3000
    );

    const walletProxyEnabled =
      process.env.READYZ_CHECK_WALLET_PROXY === undefined
        ? true // default: enabled
        : !["0", "false", "False"].includes(
            String(process.env.READYZ_CHECK_WALLET_PROXY)
          );

    // --- DB check ---
    const dbResult = await checkDb(databaseUrl);
    if (!dbResult.ok) {
      incrementReadyzDbFailures();
      request.log.error(
        { err: dbResult.errorMessage, databaseUrl },
        "[readyz] database connectivity check failed"
      );
    }

    // --- Wallet-proxy check (optional) ---
    let wpResult: WalletProxyHealthResult = {
      ok: true,
      reason: "skipped",
    };

    if (walletProxyEnabled) {
      wpResult = await checkWalletProxyHealth(
        walletProxyBaseUrl,
        walletProxyTimeoutMs
      );

      if (!wpResult.ok) {
        incrementReadyzWalletProxyFailures();
        request.log.error(
          {
            walletProxyBaseUrl,
            walletProxyTimeoutMs,
            statusCode: wpResult.statusCode,
            reason: wpResult.reason,
          },
          "[readyz] wallet-proxy health check failed"
        );
      }
    }

    const overallOk = dbResult.ok && (!walletProxyEnabled || wpResult.ok);

    if (overallOk) {
      incrementReadyzSuccess();
    }

    const body: ReadyzResponseBody = {
      ok: overallOk,
      dbOk: dbResult.ok,
      walletProxyOk: walletProxyEnabled ? wpResult.ok : true,
      details: {
        db: dbResult.ok
          ? "ok"
          : dbResult.errorMessage ?? "db_unavailable",
        walletProxy: walletProxyEnabled
          ? wpResult.ok
            ? "ok"
            : wpResult.reason ?? "wallet_proxy_unavailable"
          : "skipped",
      },
    };

    if (!overallOk) {
      reply.code(503);
    }

    return body;
  });
};

export default readyzPlugin;
