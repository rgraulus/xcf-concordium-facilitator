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
 * See "Errors" section in the wallet-proxy README.
 */
export interface WalletProxyErrorResponse {
  error: number;
  errorMessage: string;
}

/**
 * High-level shape of a single transaction entry from /v3/accTransactions/{account}.
 * Intentionally partial.
 */
export interface WalletProxyTransaction {
  id: number;
  blockTime: number;

  transactionHash?: string;
  blockHash?: string;
  blockHeight?: number;

  total?: number;
  energy?: number;

  origin?: {
    type: string;
    [key: string]: unknown;
  };

  details?: {
    type?: string;
    outcome?: string;

    // CCD transfer
    transferAmount?: string;
    transferSource?: string;
    transferDestination?: string;

    // Token update (PLT)
    tokenId?: string;
    tokenTransferAmount?: {
      decimals?: number;
      value?: string;
      [key: string]: unknown;
    };

    memo?: string;
    events?: string[];

    [key: string]: unknown;
  };

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
 */
export interface GetAccountTransactionsParams {
  limit?: number;
  order?: "ascending" | "descending";
  from?: number | string;
  blockTimeFrom?: number;
  blockTimeTo?: number;
  includeRewards?: "none" | "allButFinalization" | "all";
}

/**
 * Error thrown when a wallet-proxy HTTP call fails.
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

  public isTransient(): boolean {
    // 5xx are generally transient
    if (typeof this.statusCode === "number" && this.statusCode >= 500 && this.statusCode <= 599) {
      return true;
    }

    // Connection/refusal/timeouts are transient
    const msg = (this.message || "").toLowerCase();
    if (
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("socket hang up") ||
      msg.includes("enotfound")
    ) {
      return true;
    }

    const body = this.responseBody as Partial<WalletProxyErrorResponse> | undefined;
    if (body && typeof body.errorMessage === "string") {
      const lower = body.errorMessage.toLowerCase();
      if (lower.includes("overloaded") || lower.includes("timeout") || lower.includes("timed out")) {
        return true;
      }
    }

    return false;
  }
}

/**
 * Public entrypoint: fetch transactions affecting an account via /v3/accTransactions/{account}.
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
      throw new WalletProxyRequestError(`Wallet-proxy config error: ${err.message}`);
    }
    throw err;
  }

  const url = buildAccTransactionsUrl(config.baseUrl, account, params);
  return requestWithRetry<WalletProxyAccTransactionsResponse>(config, url);
}

/**
 * Helper: get the latest wallet-proxy tx id for an account (or 0 if none).
 * Uses descending order, limit=1.
 */
export async function getLatestAccountTransactionId(account: string): Promise<number> {
  const resp = await getAccountTransactions(account, {
    limit: 1,
    order: "descending",
    includeRewards: "none",
  });

  const tx0 = Array.isArray(resp.transactions) && resp.transactions.length > 0 ? resp.transactions[0] : undefined;
  const id = typeof tx0?.id === "number" && Number.isFinite(tx0.id) ? tx0.id : 0;
  return id;
}

function buildAccTransactionsUrl(
  baseUrl: string,
  account: string,
  params: GetAccountTransactionsParams
): URL {
  const url = new URL(`/v3/accTransactions/${encodeURIComponent(account)}`, baseUrl);

  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params.order) {
    // wallet-proxy uses 'a' / 'd' in query
    const value = params.order === "descending" ? "d" : "a";
    url.searchParams.set("order", value);
  }
  if (params.from !== undefined) {
    url.searchParams.set("from", String(params.from));
  }
  if (typeof params.blockTimeFrom === "number" && Number.isFinite(params.blockTimeFrom)) {
    url.searchParams.set("blockTimeFrom", String(params.blockTimeFrom));
  }
  if (typeof params.blockTimeTo === "number" && Number.isFinite(params.blockTimeTo)) {
    url.searchParams.set("blockTimeTo", String(params.blockTimeTo));
  }
  if (params.includeRewards) {
    url.searchParams.set("includeRewards", params.includeRewards);
  }

  return url;
}

async function requestWithRetry<T>(config: WalletProxyConfig, url: URL): Promise<T> {
  const maxAttempts = Math.max(1, config.maxRetries + 1);
  let lastError: unknown = undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { statusCode, body } = await httpGetJson(url, config.requestTimeoutMs);

      if (!statusCode || statusCode < 200 || statusCode >= 300) {
        const errorBody = body as Partial<WalletProxyErrorResponse> | undefined;
        if (errorBody && typeof errorBody.errorMessage === "string") {
          throw new WalletProxyRequestError(
            `Wallet-proxy returned HTTP ${statusCode}: ${errorBody.errorMessage}`,
            statusCode,
            body
          );
        }
        throw new WalletProxyRequestError(`Wallet-proxy returned HTTP ${statusCode}`, statusCode, body);
      }

      const maybeError = body as Partial<WalletProxyErrorResponse>;
      if (maybeError && typeof maybeError.error === "number" && typeof maybeError.errorMessage === "string") {
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
      const transient = wpErr instanceof WalletProxyRequestError ? wpErr.isTransient() : true;

      const isLast = attempt === maxAttempts;
      if (!transient || isLast) {
        throw err;
      }

      const backoffMs = computeBackoffMs(attempt);
      await sleep(backoffMs);
    }
  }

  throw lastError ?? new WalletProxyRequestError("Unknown wallet-proxy error.");
}

function httpGetJson(url: URL, timeoutMs: number): Promise<{ statusCode?: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
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
                `Failed to parse wallet-proxy JSON response: ${(parseErr as Error).message}`,
                res.statusCode ?? 0,
                data
              )
            );
          }
        });
      }
    );

    req.setTimeout(timeoutMs);

    req.on("error", (err) => {
      reject(new WalletProxyRequestError(`Wallet-proxy request failed: ${(err as Error).message}`));
    });

    req.on("timeout", () => {
      req.destroy(new WalletProxyRequestError(`Wallet-proxy request timed out after ${timeoutMs}ms.`));
    });

    req.end();
  });
}

function computeBackoffMs(attempt: number): number {
  // 250ms, 500ms, 1000ms, 2000ms, ...
  const base = 250;
  const factor = Math.pow(2, attempt - 1);
  return base * factor;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
