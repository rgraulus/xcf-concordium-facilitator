/**
 * src/tools/debugPltStreamConfig.ts
 *
 * Tiny helper to print the effective PLT stream configuration as derived
 * from environment variables. This complements debugPltDb.ts (DB view).
 *
 * Usage:
 *   # typical env
 *   export CONCORDIUM_NODE_URL=grpc.testnet.concordium.com:20000
 *   unset CONCORDIUM_NODE_INSECURE
 *   export CONCORDIUM_PLT_TOKEN_ID=EUDemo
 *   export CRP_STREAM_SOURCE=concordium
 *   export CRP_STREAM_DRY_RUN=0
 *   export CRP_STREAM_MAX_TICKS=20
 *
 *   npm run debug:plt:stream
 */

function parseNodeUrl(raw: string | undefined) {
  const fallback = {
    nodeUrl: "grpc.testnet.concordium.com:20000",
    address: "grpc.testnet.concordium.com",
    port: 20000,
    useTls: true,
  };

  if (!raw || !raw.trim()) {
    return fallback;
  }

  const trimmed = raw.trim();
  const [host, portStr] = trimmed.split(":");
  const port = Number(portStr ?? 20000);

  return {
    nodeUrl: trimmed,
    address: host || fallback.address,
    port: Number.isFinite(port) ? port : fallback.port,
    useTls: process.env.CONCORDIUM_NODE_INSECURE ? false : true,
  };
}

async function main() {
  const {
    CONCORDIUM_NODE_URL,
    CONCORDIUM_NODE_INSECURE,
    CONCORDIUM_PLT_TOKEN_ID,
    CONCORDIUM_PLT_DECIMALS,
    CRP_STREAM_SOURCE,
    CRP_STREAM_DRY_RUN,
    CRP_STREAM_MAX_TICKS,
  } = process.env;

  const nodeConn = parseNodeUrl(CONCORDIUM_NODE_URL);

  const logicalTokenId = (CONCORDIUM_PLT_TOKEN_ID || "usd:test").trim();
  const decimalsRaw = CONCORDIUM_PLT_DECIMALS;
  const decimals = Number.isFinite(Number(decimalsRaw))
    ? Number(decimalsRaw)
    : 2;

  const sourceKind = (CRP_STREAM_SOURCE || "concordium").trim();
  const dryRun = CRP_STREAM_DRY_RUN === "1";
  const maxTicks = Number.isFinite(Number(CRP_STREAM_MAX_TICKS))
    ? Number(CRP_STREAM_MAX_TICKS)
    : undefined;

  // Mirror the "demo runner starting with config" shape as much as possible.
  const configLike = {
    pollIntervalMs: 1000,
    network: "concordium:testnet",
    tokenId: logicalTokenId,
    dryRun,
    lastHeight: 0,
    maxTicks: maxTicks ?? "(default)",
    decimals,
    sourceKind,
  };

  // Pretty print everything.
  // eslint-disable-next-line no-console
  console.log("[PLT-STREAM-DEBUG] Raw env:");
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        CONCORDIUM_NODE_URL,
        CONCORDIUM_NODE_INSECURE: !!CONCORDIUM_NODE_INSECURE,
        CONCORDIUM_PLT_TOKEN_ID,
        CONCORDIUM_PLT_DECIMALS,
        CRP_STREAM_SOURCE,
        CRP_STREAM_DRY_RUN,
        CRP_STREAM_MAX_TICKS,
      },
      null,
      2
    )
  );

  // eslint-disable-next-line no-console
  console.log("\n[PLT-STREAM-DEBUG] Parsed node connection:");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(nodeConn, null, 2));

  // eslint-disable-next-line no-console
  console.log("\n[PLT-STREAM-DEBUG] Effective stream config (logical):");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(configLike, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[PLT-STREAM-DEBUG] Fatal error:", err);
  process.exit(1);
});
