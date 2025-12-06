// src/services/walletProxyClient.ts

import * as http from "http";
import * as https from "https";
import { URL } from "url";
import {
  WalletProxyConfig,
  WalletProxyConfigError,
  getWalletProxyConfigFromEnv,
} from "../config/walletProxy";

/**
 * Shape of an error response from wallet-proxy.
 * See "Errors" section in the wallet-proxy README. :contentReference[oaicite:0]{index=0}
 */
export interface WalletProxyErrorResponse {
  error: number;
  errorMessage: string;
}

/**
 * High-level shape of a single transaction entry from /v3/accTransactions.
 * This is intentionally partial; we only model fields we are likely to consume
 * in the PLT extractor phase, and keep the rest as "unknown".
 *
 * See "Get transactions" section in wallet-proxy README. 
 */
export interface WalletProxyTransaction {
  id: number;
  blockTime: number;
  transactionHash?: string;
  blockHash?: string;
  total?: number;
  energy?: number;
  origin?: {
    type: string;
    // other fields omitted for now
    [key: string]: unknown;
  };
  details?: {
    type?: string;
    outcome?: string;
    transferAmount?: string;
    transferSource?: string;
    transferDestination?: string;
    events?: string[];
    // v3 adds PLT-specific types like "updateCreatePLT" etc; we keep it open-ended. :contentReference[oaicite:2]{index=2}
    [key: string]: unknown;
  };
  // allow unknown extra fields for future expansion
  [key: string]: unknown;
}

/**
 * Successful response shape for /v3/accTransactions/{account}.
 */
export interface WalletProxyAccTransactionsResponse {
  order: "ascending" | "descending";
  from?: number | string | null;
  limit: number;
  count: number;
  transactions: WalletProxyTransaction[];
}

/**
 * Parameters we care about for /v3/accTransactions.
 * (The endpoint supports more flags; we can extend this type later. :contentReference[oaicite:3]{index=3})
 */
export interface GetAccountTransactionsParams {
  limit?: number;
  order?: "ascending" | "descending";
  from?: number | string;
  blockTimeFrom?: number;
  blockTimeTo?: number;
  includeRewards?:
    | "none"
    | "allButFinalization"
    | "all"; // matches wallet-proxy README
}

/**
 * Error thrown when a wallet-proxy HTTP call fails (network, 5xx, or error JSON).
 */
export class WalletProxyRequestError extends Error {
  public readonly statusCode?: number;
  public readonly responseBody?: unknown;

  constructor(message: string, statusCode?: number, responseBody?: unknown) {
    super(message);
    this.name = "WalletProxyRequestError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }

  /**
   * Returns true if this error looks transient (e.g., node overload / timeout)
   * and a retry might succeed.
   */
  public isTransient(): boolean {
    // 5xx HTTP codes are generally transient.
    if (
      typeof this.statusCode === "number" &&
      this.statusCode >= 500 &&
      this.statusCode <= 599
    ) {
      return true;
    }

    const body = this.responseBody as Partial<WalletProxyErrorResponse> | undefined;
    if (body && typeof body.error === "number" && typeof body.errorMessage === "string") {
      // Wallet-proxy uses error codes + messages; "node overloaded / timeout"
      // cases are transient from our perspective.
      const lower = body.errorMessage.toLowerCase();
      if (
        lower.includes("overloaded") ||
        lower.includes("timeout") ||
        lower.includes("timed out")
      ) {
        return true;
      }
    }

    return false;
  }
}

/**
 * Public entrypoint: fetch transactions affecting an account's CCD/PLT balances
 * via wallet-proxy's /v3/accTransactions/{account} endpoint. 
 *
 * This function:
 * - reads config from env (WALLET_PROXY_BASE_URL, etc.)
 * - constructs the v3 URL with the specified parameters
 * - performs a GET with timeout and simple retries
 * - throws WalletProxyRequestError on failure
 */
export async function getAccountTransactions(
  account: string,
  params: GetAccountTransactionsParams = {}
): Promise<WalletProxyAccTransactionsResponse> {
  if (!account || account.trim() === "") {
    throw new WalletProxyRequestError("Account address must be a non-empty string.");
  }

  let config: WalletProxyConfig;
  try {
    config = getWalletProxyConfigFromEnv();
  } catch (err) {
    if (err instanceof WalletProxyConfigError) {
      // Re-wrap as request error so callers don't have to know about config internals.
      throw new WalletProxyRequestError(`Wallet-proxy config error: ${err.message}`);
    }
    throw err;
  }

  const url = buildAccTransactionsUrl(config.baseUrl, account, params);
  return requestWithRetry<WalletProxyAccTransactionsResponse>(config, url);
}

function buildAccTransactionsUrl(
  baseUrl: string,
  account: string,
  params: GetAccountTransactionsParams
): URL {
  const url = new URL(
    `/v3/accTransactions/${encodeURIComponent(account)}`,
    baseUrl
  );

  if (typeof params.limit === "number") {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params.order) {
    // API uses a single-letter 'a'/'d' in query, but it returns a full word in the response. :contentReference[oaicite:5]{index=5}
    const value = params.order === "descending" ? "d" : "a";
    url.searchParams.set("order", value);
  }
  if (params.from !== undefined) {
    url.searchParams.set("from", String(params.from));
  }
  if (typeof params.blockTimeFrom === "number") {
    url.searchParams.set("blockTimeFrom", String(params.blockTimeFrom));
  }
  if (typeof params.blockTimeTo === "number") {
    url.searchParams.set("blockTimeTo", String(params.blockTimeTo));
  }
  if (params.includeRewards) {
    url.searchParams.set("includeRewards", params.includeRewards);
  }

  return url;
}

/**
 * Perform a GET request with retries using Node's http/https modules.
 */
async function requestWithRetry<T>(
  config: WalletProxyConfig,
  url: URL
): Promise<T> {
  const maxAttempts = Math.max(1, config.maxRetries + 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { statusCode, body } = await httpGetJson(url, config.requestTimeoutMs);

      if (!statusCode || statusCode < 200 || statusCode >= 300) {
        // Non-2xx: try to interpret as wallet-proxy error JSON.
        const errorBody = body as Partial<WalletProxyErrorResponse> | undefined;
        if (errorBody && typeof errorBody.errorMessage === "string") {
          throw new WalletProxyRequestError(
            `Wallet-proxy returned HTTP ${statusCode}: ${errorBody.errorMessage}`,
            statusCode,
            body
          );
        }
        throw new WalletProxyRequestError(
          `Wallet-proxy returned HTTP ${statusCode}`,
          statusCode,
          body
        );
      }

      // 2xx; see if this is still an "error" wrapper according to wallet-proxy's spec.
      const maybeError = body as Partial<WalletProxyErrorResponse>;
      if (
        maybeError &&
        typeof maybeError.error === "number" &&
        typeof maybeError.errorMessage === "string"
      ) {
        throw new WalletProxyRequestError(
          `Wallet-proxy error ${maybeError.error}: ${maybeError.errorMessage}`,
          statusCode,
          body
        );
      }

      return body as T;
    } catch (err) {
      lastError = err;

      const wpErr = err as WalletProxyRequestError;
      const isTransient =
        wpErr instanceof WalletProxyRequestError ? wpErr.isTransient() : true;

      const isLastAttempt = attempt === maxAttempts;
      if (!isTransient || isLastAttempt) {
        throw err;
      }

      const backoffMs = computeBackoffMs(attempt);
      await sleep(backoffMs);
    }
  }

  // We should never reach this because we either returned or threw,
  // but TypeScript wants a return type.
  throw lastError ?? new WalletProxyRequestError("Unknown wallet-proxy error.");
}

function httpGetJson(
  url: URL,
  timeoutMs: number
): Promise<{ statusCode?: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";

        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });

        res.on("end", () => {
          if (!data) {
            resolve({ statusCode: res.statusCode ?? 0, body: null });
            return;
          }

          try {
            const parsed = JSON.parse(data);
            resolve({ statusCode: res.statusCode ?? 0, body: parsed });
          } catch (parseErr) {
            reject(
              new WalletProxyRequestError(
                `Failed to parse wallet-proxy JSON response: ${
                  (parseErr as Error).message
                }`,
                res.statusCode ?? 0,
                data
              )
            );
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(
        new WalletProxyRequestError(
          `Wallet-proxy request failed: ${(err as Error).message}`
        )
      );
    });

    req.on("timeout", () => {
      req.destroy(
        new WalletProxyRequestError(
          `Wallet-proxy request timed out after ${timeoutMs}ms.`
        )
      );
    });

    req.end();
  });
}

function computeBackoffMs(attempt: number): number {
  // Simple exponential backoff: 250ms, 500ms, 1000ms, ...
  const base = 250;
  const factor = Math.pow(2, attempt - 1);
  return base * factor;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
