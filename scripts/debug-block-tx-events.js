// scripts/debug-block-tx-events.js
//
// Usage:
//   node -r dotenv/config scripts/debug-block-tx-events.js <BLOCK_HASH>
//
// Example:
//   node -r dotenv/config scripts/debug-block-tx-events.js d1923f58...
//
// This script connects to the Concordium gRPC node using the same env vars
// as the server (CONCORDIUM_GRPC_HOST / PORT / TLS) and prints all
// transaction events for the given block.

const { credentials } = require("@grpc/grpc-js");

// BigInt-safe JSON replacer
function bigIntReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function getClient() {
  // Dynamic imports so we don't have to flip the whole project to ESM.
  const dynamicImport = new Function("specifier", "return import(specifier)");

  const nodejsModule = await dynamicImport("@concordium/web-sdk/nodejs");
  const webSdkModule = await dynamicImport("@concordium/web-sdk");

  const { ConcordiumGRPCNodeClient } = nodejsModule;
  const { BlockHash } = webSdkModule;

  if (!ConcordiumGRPCNodeClient || !BlockHash) {
    throw new Error(
      "Failed to load ConcordiumGRPCNodeClient or BlockHash from web-sdk"
    );
  }

  const host = process.env.CONCORDIUM_GRPC_HOST || "127.0.0.1";
  const port = Number(process.env.CONCORDIUM_GRPC_PORT || "20000");
  const tls =
    String(process.env.CONCORDIUM_GRPC_TLS || "false")
      .toLowerCase() === "true";

  const creds = tls ? credentials.createSsl() : credentials.createInsecure();

  const client = new ConcordiumGRPCNodeClient(host, port, creds, {
    timeout: 15_000,
  });

  return { client, BlockHash };
}

async function main() {
  const blockHashHex = process.argv[2];

  if (!blockHashHex) {
    console.error("Usage: node -r dotenv/config scripts/debug-block-tx-events.js <BLOCK_HASH>");
    process.exit(1);
  }

  console.log("Connecting to Concordium node with BLOCK_HASH =", blockHashHex);

  const { client, BlockHash } = await getClient();

  const bh = BlockHash.fromHexString(blockHashHex);

  // getBlockTransactionEvents returns an async stream of events
  const stream = client.getBlockTransactionEvents(bh);

  let count = 0;
  for await (const ev of stream) {
    count++;
    console.log("\n=== Event", count, "===\n");
    console.log(
      JSON.stringify(ev, bigIntReplacer, 2)
    );
  }

  if (count === 0) {
    console.log("\n(No transaction events found in this block.)");
  } else {
    console.log(`\nTotal events: ${count}`);
  }
}

main().catch((err) => {
  console.error("Error in debug-block-tx-events:", err);
  process.exitCode = 1;
});
