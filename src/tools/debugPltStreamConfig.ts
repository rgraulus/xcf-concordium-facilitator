/**
 * src/tools/debugPltStreamConfig.ts
 *
 * Drop-in helper to print the effective PLT stream configuration as derived
 * from environment variables.
 *
 * IMPORTANT:
 * - Prefers CRP_STREAM_* (the vars you’ve been setting).
 * - Still supports the older CONCORDIUM_PLT_* names as fallbacks.
 * - Also understands CONCORDIUM_GRPC_HOST/PORT/TLS if CONCORDIUM_NODE_URL is not set.
 *
 * Usage:
 *   # Load env (bash)
 *   set -a; source .env; set +a
 *
 *   npm run debug:plt:stream
 */

type NodeConn = {
  nodeUrl: string;
  address: string;
  port: number;
  useTls: boolean;
  source: "CONCORDIUM_NODE_URL" | "CONCORDIUM_GRPC_*" | "fallback";
};

function isTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

function parseNumber(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Accepts:
 * - "host:port"
 * - "http://host:port" or "https://host:port" (we’ll strip scheme for address/port)
 */
function parseNodeUrlFromNodeUrlEnv(
  raw: string,
  useTlsFallback: boolean
): { nodeUrl: string; address: string; port: number; useTls: boolean } {
  const trimmed = raw.trim();

  // If someone puts http(s):// in here, handle it gracefully.
  const schemeMatch = trimmed.match(/^(https?):\/\/(.+)$/i);
  const withoutScheme = schemeMatch ? schemeMatch[2] : trimmed;

  const [hostPart, portStr] = withoutScheme.split(":");
  const portCandidate = Number(portStr ?? "");
  const port = Number.isFinite(portCandidate) && portCandidate > 0 ? portCandidate : 20000;

  const address =
    hostPart && hostPart.length > 0 ? hostPart : "grpc.testnet.concordium.com";

  return {
    nodeUrl: trimmed,
    address,
    port,
    useTls: useTlsFallback,
  };
}

/**
 * Precedence for node connection:
 * 1) CONCORDIUM_NODE_URL (host:port OR http(s)://host:port)
 * 2) CONCORDIUM_GRPC_HOST + CONCORDIUM_GRPC_PORT (+ CONCORDIUM_GRPC_TLS)
 * 3) fallback: grpc.testnet.concordium.com:20000 (TLS)
 *
 * TLS rules:
 * - If CONCORDIUM_GRPC_TLS is set (true/false), it wins when using GRPC_*.
 * - Otherwise, if CONCORDIUM_NODE_INSECURE is truthy => useTls=false
 * - Else default useTls=true (testnet default)
 */
function parseNodeConnectionFromEnv(env: NodeJS.ProcessEnv): NodeConn {
  const insecure = isTruthy(env.CONCORDIUM_NODE_INSECURE);

  // 1) CONCORDIUM_NODE_URL
  if (env.CONCORDIUM_NODE_URL && env.CONCORDIUM_NODE_URL.trim()) {
    const useTls = !insecure; // insecure explicitly disables TLS
    return {
      ...parseNodeUrlFromNodeUrlEnv(env.CONCORDIUM_NODE_URL, useTls),
      source: "CONCORDIUM_NODE_URL",
    };
  }

  // 2) CONCORDIUM_GRPC_*
  const host = env.CONCORDIUM_GRPC_HOST?.trim();
  const port = parseNumber(env.CONCORDIUM_GRPC_PORT);
  const tlsOverride = parseBoolean(env.CONCORDIUM_GRPC_TLS);

  if (host && port != null) {
    const useTls = tlsOverride !== undefined ? tlsOverride : !insecure;
    return {
      nodeUrl: `${host}:${port}`,
      address: host,
      port,
      useTls,
      source: "CONCORDIUM_GRPC_*",
    };
  }

  // 3) fallback
  return {
    nodeUrl: "grpc.testnet.concordium.com:20000",
    address: "grpc.testnet.concordium.com",
    port: 20000,
    useTls: true,
    source: "fallback",
  };
}

function main() {
  const env = process.env;

  // Prefer CRP_STREAM_* first, then fall back to legacy CONCORDIUM_PLT_*.
  const tokenId = (env.CRP_STREAM_TOKEN_ID ?? env.CONCORDIUM_PLT_TOKEN_ID ?? "usd:test").trim();
  const decimalsRaw = env.CRP_STREAM_DECIMALS ?? env.CONCORDIUM_PLT_DECIMALS;
  const decimals = Number.isFinite(Number(decimalsRaw)) ? Number(decimalsRaw) : 2;

  const network = (env.CRP_STREAM_NETWORK ?? "concordium:testnet").trim();

  const pollIntervalMs = parseNumber(env.CRP_STREAM_POLL_INTERVAL_MS) ?? 1000;
  const lastHeight = parseNumber(env.CRP_STREAM_LAST_HEIGHT) ?? 0;

  const sourceKind = (env.CRP_STREAM_SOURCE ?? "concordium").trim();

  const dryRun = isTruthy(env.CRP_STREAM_DRY_RUN) || env.CRP_STREAM_DRY_RUN === "1";

  const maxTicks = parseNumber(env.CRP_STREAM_MAX_TICKS);

  const nodeConn = parseNodeConnectionFromEnv(env);

  const effective = {
    pollIntervalMs,
    network,
    tokenId,
    dryRun,
    lastHeight,
    maxTicks: maxTicks ?? "(default)",
    decimals,
    sourceKind,
    node: nodeConn,
  };

  // eslint-disable-next-line no-console
  console.log("[PLT-STREAM-DEBUG] Raw env (selected):");
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        // Node connection related
        CONCORDIUM_NODE_URL: env.CONCORDIUM_NODE_URL,
        CONCORDIUM_NODE_INSECURE: !!env.CONCORDIUM_NODE_INSECURE,
        CONCORDIUM_GRPC_HOST: env.CONCORDIUM_GRPC_HOST,
        CONCORDIUM_GRPC_PORT: env.CONCORDIUM_GRPC_PORT,
        CONCORDIUM_GRPC_TLS: env.CONCORDIUM_GRPC_TLS,

        // Stream config (preferred)
        CRP_STREAM_SOURCE: env.CRP_STREAM_SOURCE,
        CRP_STREAM_NETWORK: env.CRP_STREAM_NETWORK,
        CRP_STREAM_TOKEN_ID: env.CRP_STREAM_TOKEN_ID,
        CRP_STREAM_DECIMALS: env.CRP_STREAM_DECIMALS,
        CRP_STREAM_POLL_INTERVAL_MS: env.CRP_STREAM_POLL_INTERVAL_MS,
        CRP_STREAM_LAST_HEIGHT: env.CRP_STREAM_LAST_HEIGHT,
        CRP_STREAM_DRY_RUN: env.CRP_STREAM_DRY_RUN,
        CRP_STREAM_MAX_TICKS: env.CRP_STREAM_MAX_TICKS,

        // Legacy (fallback)
        CONCORDIUM_PLT_TOKEN_ID: env.CONCORDIUM_PLT_TOKEN_ID,
        CONCORDIUM_PLT_DECIMALS: env.CONCORDIUM_PLT_DECIMALS,
      },
      null,
      2
    )
  );

  // eslint-disable-next-line no-console
  console.log("\n[PLT-STREAM-DEBUG] Parsed node connection (effective):");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(nodeConn, null, 2));

  // eslint-disable-next-line no-console
  console.log("\n[PLT-STREAM-DEBUG] Effective stream config (logical):");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(effective, null, 2));
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("[PLT-STREAM-DEBUG] Fatal error:", err);
  process.exit(1);
}
