// scripts/grpc-node-probe.ts
//
// Tiny GRPC v2 probe against the public Concordium testnet node.
// This bypasses wallet-proxy and tx-logger entirely and talks
// directly to grpc.testnet.concordium.com:20000 (or whatever
// CONCORDIUM_GRPC_HOST/PORT you configure).
//
// Usage:
//   CONCORDIUM_GRPC_HOST=grpc.testnet.concordium.com \
//   CONCORDIUM_GRPC_PORT=20000 \
//   CONCORDIUM_GRPC_TLS=true \
//   npm run probe:grpc-node
//
// Exit codes:
//   0 -> probe OK (we got consensus + best block info)
//   1 -> probe failed (connection error / timeout / other)

import { credentials, Metadata } from "@grpc/grpc-js";
import { ConcordiumNodeClient } from "@concordium/node-sdk";

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

async function main() {
  const host = process.env.CONCORDIUM_GRPC_HOST ?? "grpc.testnet.concordium.com";
  const port = Number(process.env.CONCORDIUM_GRPC_PORT ?? "20000");
  const useTls = parseBooleanEnv(process.env.CONCORDIUM_GRPC_TLS, true);
  const timeoutMs = Number(process.env.CONCORDIUM_GRPC_TIMEOUT_MS ?? "15000");

  const metadata = new Metadata();
  // Public testnet node does not require auth metadata.
  // If Concordium ever requires it, we can inject it here from env:
  // const rpcAuth = process.env.CONCORDIUM_GRPC_AUTH;
  // if (rpcAuth) metadata.add("authentication", rpcAuth);

  const channelCredentials = useTls
    ? credentials.createSsl()
    : credentials.createInsecure();

  const client = new ConcordiumNodeClient(
    host,
    port,
    channelCredentials,
    metadata,
    timeoutMs
  );

  console.log(
    JSON.stringify(
      {
        step: "connecting",
        host,
        port,
        useTls,
        timeoutMs,
      },
      null,
      2
    )
  );

  try {
    // 1) Basic consensus status
    const consensus = await client.getConsensusStatus();
    const bestBlock = consensus.bestBlock;
    const lastFinalizedBlock = consensus.lastFinalizedBlock;

    let bestBlockInfo: unknown = null;

    if (bestBlock) {
      try {
        bestBlockInfo = await client.getBlockInfo(bestBlock);
      } catch (e: any) {
        bestBlockInfo = {
          error: e?.message ?? String(e),
          code: e?.code,
          details: e?.details,
        };
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          host,
          port,
          useTls,
          consensus: {
            bestBlock,
            lastFinalizedBlock,
            full: consensus,
          },
          bestBlockInfo,
        },
        null,
        2
      )
    );

    process.exit(0);
  } catch (err: any) {
    console.error("GRPC node probe failed:", err?.message ?? String(err));

    console.log(
      JSON.stringify(
        {
          ok: false,
          host,
          port,
          useTls,
          error: err?.message ?? String(err),
          code: err?.code,
          details: err?.details,
        },
        null,
        2
      )
    );

    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error in GRPC node probe:", err);
  process.exit(1);
});
