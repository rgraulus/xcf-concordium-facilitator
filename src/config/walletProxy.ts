// src/config/walletProxy.ts

export interface WalletProxyConfig {
  /**
   * Base URL of the wallet proxy service, e.g. "http://localhost:3000"
   * (without a trailing slash).
   */
  baseUrl: string;

  /**
   * Per-request timeout in milliseconds for calls from XCF -> wallet-proxy.
   */
  requestTimeoutMs: number;

  /**
   * Maximum number of retries for transient failures (e.g. node overload).
   * A value of 0 means "no retries, single attempt only".
   */
  maxRetries: number;
}

export class WalletProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletProxyConfigError";
  }
}

/**
 * Read wallet-proxy related configuration from environment variables.
 *
 * - WALLET_PROXY_BASE_URL: Base URL of the wallet proxy
 *   (default: http://localhost:3000)
 * - WALLET_PROXY_TIMEOUT_MS: Request timeout in ms (default: 15000)
 * - WALLET_PROXY_MAX_RETRIES: Max retry attempts for transient errors (default: 2)
 */
export function getWalletProxyConfigFromEnv(): WalletProxyConfig {
  const rawBaseUrl =
    process.env.WALLET_PROXY_BASE_URL?.trim() || "http://localhost:3000";

  if (!rawBaseUrl) {
    throw new WalletProxyConfigError(
      "WALLET_PROXY_BASE_URL is not set and no default could be derived."
    );
  }

  const baseUrl = normalizeBaseUrl(rawBaseUrl);

  const requestTimeoutMs = parseIntegerEnv(
    "WALLET_PROXY_TIMEOUT_MS",
    15_000 /* 15 seconds */
  );

  const maxRetries = parseIntegerEnv("WALLET_PROXY_MAX_RETRIES", 2);

  if (maxRetries < 0) {
    throw new WalletProxyConfigError(
      `WALLET_PROXY_MAX_RETRIES must be >= 0 (got ${maxRetries}).`
    );
  }

  return {
    baseUrl,
    requestTimeoutMs,
    maxRetries,
  };
}

function parseIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return defaultValue;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new WalletProxyConfigError(
      `Environment variable ${name} must be an integer (got "${raw}").`
    );
  }

  return value;
}

function normalizeBaseUrl(value: string): string {
  // Avoid double slashes when constructing URLs.
  if (value.endsWith("/")) {
    return value.slice(0, -1);
  }
  return value;
}
