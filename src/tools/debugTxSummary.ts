// src/tools/debugTxSummary.ts
//
// Debug helper to inspect what methods are actually exposed on the
// Concordium gRPC client we are using in the worker.
//
// This is *not* yet a full "tx summary" fetcher. Instead, it:
//   - Prints the relevant env vars (node URL + tx hash)
//   - Constructs the same client as the PLT stream worker
//   - Introspects which methods are present (e.g. getBlockTransactionEvents)
//   - Shows whether getBlockItemSummary / getBlockItemStatus exist
//
// Once we have clear guidance from Concordium on the correct API
// for transaction summaries in @concordium/web-sdk, we can upgrade
// this tool to actually call that method.
//
// Usage:
//   export CONCORDIUM_NODE_URL=grpc.testnet.concordium.com:20000
//   unset CONCORDIUM_NODE_INSECURE
//   export CONCORDIUM_TX_HASH=<hex tx hash from wallet tool>
//   npm run debug:tx:summary

import "dotenv/config";
import { createConcordiumPltEventClientFromEnv } from "../worker/pltSource.concordium";

function getEnvTxHash(): string {
  const txHex = process.env.CONCORDIUM_TX_HASH;
  if (!txHex || !txHex.trim()) {
    throw new Error(
      "CONCORDIUM_TX_HASH is required (hex transaction hash from the wallet tool logs)."
    );
  }
  return txHex.trim();
}

async function main(): Promise<void> {
  const rawEnv = {
    CONCORDIUM_NODE_URL: process.env.CONCORDIUM_NODE_URL ?? "(unset)",
    CONCORDIUM_NODE_INSECURE:
      process.env.CONCORDIUM_NODE_INSECURE ?? "(unset / false)",
    CONCORDIUM_TX_HASH: process.env.CONCORDIUM_TX_HASH ?? "(unset)",
  };

  // eslint-disable-next-line no-console
  console.log("[TX-DEBUG] Raw env:");
  // eslint-disable-next-line no-console
  console.log(rawEnv);

  const txHex = getEnvTxHash();

  // eslint-disable-next-line no-console
  console.log("[TX-DEBUG] Using tx hash (hex):", txHex);

  // Reuse the same client factory as the PLT stream worker so we don't
  // have to guess constructor signatures for ConcordiumGRPCClient.
  const client = createConcordiumPltEventClientFromEnv();
  const anyClient = client as any;

  // Basic presence check for likely methods.
  const methodPresence = {
    has_getBlockTransactionEvents:
      typeof anyClient.getBlockTransactionEvents === "function",
    has_getBlockItemSummary:
      typeof anyClient.getBlockItemSummary === "function",
    has_getBlockItemStatus: typeof anyClient.getBlockItemStatus === "function",
    has_getBlockInfo: typeof anyClient.getBlockInfo === "function",
    has_getAccountInfo: typeof anyClient.getAccountInfo === "function",
  };

  // eslint-disable-next-line no-console
  console.log("[TX-DEBUG] Client method presence:", methodPresence);

  // Show a small sample of enumerable keys on the client instance so
  // we can inspect what is actually exposed by this version of the SDK.
  try {
    const keys = Object.keys(anyClient);
    // eslint-disable-next-line no-console
    console.log(
      "[TX-DEBUG] Sample enumerable client keys (first 40):",
      keys.slice(0, 40)
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[TX-DEBUG] Could not list client keys (non-fatal):",
      (err as Error).message
    );
  }

  // For now, we *do not* attempt to call any of the suspected summary
  // methods, because we have already confirmed that at least
  // getBlockItemSummary is not available on this client type.
  //
  // Instead, this helper is meant to give us a safe, stable way to see
  // what the Concordium client looks like at runtime, so we and/or the
  // Concordium team can decide the correct approach for summary access.
  //
  // TODO (once we have the right method name & signature from Concordium):
  //   - Detect that method here
  //   - Call it with the tx hash
  //   - Pretty-print the resulting summary (including tokenUpdate events).
  //
  // eslint-disable-next-line no-console
  console.log(
    "[TX-DEBUG] Note: this tool currently only introspects the client; it does not yet fetch summaries."
  );
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[TX-DEBUG] Fatal error:", err);
    process.exitCode = 1;
  });
}
