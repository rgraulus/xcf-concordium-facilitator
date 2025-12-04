// src/tools/debugPltBlock.ts
//
// Debug tool to inspect PLT transfers in a specific finalized block.
//
// Usage (example for an EUDemo PLT block):
//
//   export CONCORDIUM_NODE_URL=grpc.testnet.concordium.com:20000
//   export DEBUG_PLT_BLOCK_HEIGHT=35220702
//   export DEBUG_PLT_TOKEN_ID=EUDemo
//   export CONCORDIUM_PLT_TOKEN_ID=EUDemo
//   npx ts-node src/tools/debugPltBlock.ts
//
// This will:
//   - Resolve the block hash(es) at the given height.
//   - Call getBlockTransactionEvents(blockHash) for the first hash.
//   - Run the shared PLT extractor.
//   - Print a JSON diagnostic with summaries + matched PLT events.

import { credentials } from "@grpc/grpc-js";
import {
  extractPltEventsFromBlockSummaries,
  type BlockTransactionEventLike,
} from "../crp/pltExtractor";

// --- Types ------------------------------------------------------------------

interface ConcordiumNodeConnection {
  address: string;
  port: number;
  useTls: boolean;
}

// --- Helpers ----------------------------------------------------------------

function parseNodeUrl(raw: string): ConcordiumNodeConnection {
  if (raw.includes("://")) {
    const url = new URL(raw);
    const port =
      url.port && url.port.length > 0
        ? Number(url.port)
        : url.protocol === "https:"
        ? 443
        : 80;

    return {
      address: url.hostname,
      port,
      useTls: url.protocol === "https:",
    };
  }

  const [host, portStr] = raw.split(":");
  const port = portStr ? Number(portStr) : 20000;

  return {
    address: host || "localhost",
    port: Number.isFinite(port) ? port : 20000,
    useTls: port === 20000,
  };
}

// BigInt-safe JSON stringify.
function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(
    obj,
    (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    2
  );
}

// --- Dynamic JS-SDK loading -------------------------------------------------

let ConcordiumGRPCNodeClientCtor: any | undefined;
let BlockHash: any | undefined;

async function loadConcordiumSdkModules(): Promise<void> {
  if (!ConcordiumGRPCNodeClientCtor) {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)"
    ) as (specifier: string) => Promise<any>;

    const nodejsModule = await dynamicImport("@concordium/web-sdk/nodejs");
    ConcordiumGRPCNodeClientCtor = nodejsModule.ConcordiumGRPCNodeClient;
  }

  if (!BlockHash) {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)"
    ) as (specifier: string) => Promise<any>;

    const webSdkModule = await dynamicImport("@concordium/web-sdk");
    BlockHash = webSdkModule.BlockHash;
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  const nodeUrl =
    process.env.CONCORDIUM_NODE_URL ?? "grpc.testnet.concordium.com:20000";

  const blockHeightStr = process.env.DEBUG_PLT_BLOCK_HEIGHT;
  if (!blockHeightStr) {
    console.error(
      "[PLT-BLOCK-DEBUG] Please set DEBUG_PLT_BLOCK_HEIGHT (e.g. 35220702)."
    );
    process.exit(1);
  }

  const blockHeight = Number(blockHeightStr);
  if (!Number.isFinite(blockHeight) || blockHeight < 0) {
    console.error(
      "[PLT-BLOCK-DEBUG] DEBUG_PLT_BLOCK_HEIGHT must be a non-negative number.",
      { blockHeightStr }
    );
    process.exit(1);
  }

  const logicalTokenId = process.env.DEBUG_PLT_TOKEN_ID ?? "EUDemo";
  const filterTokenIdEnv = process.env.CONCORDIUM_PLT_TOKEN_ID;
  const filterTokenId =
    typeof filterTokenIdEnv === "string" && filterTokenIdEnv.trim() !== ""
      ? filterTokenIdEnv.trim()
      : logicalTokenId;

  await loadConcordiumSdkModules();

  if (!ConcordiumGRPCNodeClientCtor || !BlockHash) {
    console.error(
      "[PLT-BLOCK-DEBUG] Concordium JS-SDK modules not loaded; aborting."
    );
    process.exit(1);
  }

  const { address, port, useTls } = parseNodeUrl(nodeUrl);
  const creds = useTls
    ? credentials.createSsl()
    : credentials.createInsecure();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = new ConcordiumGRPCNodeClientCtor(address, port, creds);

  console.log("[PLT-BLOCK-DEBUG] Using node connection", {
    nodeUrl,
    parsed: { address, port, useTls },
    blockHeight,
    logicalTokenId,
    filterTokenId,
  });

  // 1) Resolve block hash(es) at the given height.
  let blockHashes: any[];
  try {
    blockHashes = await client.getBlocksAtHeight(BigInt(blockHeight));
  } catch (err) {
    console.error(
      "[PLT-BLOCK-DEBUG] Error while calling getBlocksAtHeight",
      err
    );
    process.exit(1);
  }

  if (!Array.isArray(blockHashes) || blockHashes.length === 0) {
    console.log(
      "[PLT-BLOCK-DEBUG] No blocks found at given height (might be pre-genesis or pruned).",
      { blockHeight }
    );
    return;
  }

  const blockHashObj = blockHashes[0];
  const blockHashStr =
    blockHashObj && typeof blockHashObj.toString === "function"
      ? blockHashObj.toString()
      : String(blockHashObj ?? "");

  console.log("[PLT-BLOCK-DEBUG] Using block hash", {
    blockHash: blockHashStr,
  });

  // 2) Fetch transaction events for this block.
  const summaries: BlockTransactionEventLike[] = [];
  try {
    const bh =
      BlockHash.fromHexString && typeof BlockHash.fromHexString === "function"
        ? BlockHash.fromHexString(blockHashStr)
        : blockHashStr;

    const txEventStream = client.getBlockTransactionEvents(bh);

    for await (const item of txEventStream as AsyncIterable<unknown>) {
      summaries.push(item as BlockTransactionEventLike);
    }
  } catch (err) {
    console.error(
      "[PLT-BLOCK-DEBUG] Error while iterating getBlockTransactionEvents",
      err
    );
    process.exit(1);
  }

  // 3) Run the shared PLT extractor.
  const events = extractPltEventsFromBlockSummaries({
    network: "concordium:testnet",
    tokenId: logicalTokenId,
    filterTokenId,
    blockHash: blockHashStr,
    blockHeight,
    summaries,
  });

  // 4) Print diagnostics.
  const payload = {
    network: "concordium:testnet",
    blockHeight,
    blockHash: blockHashStr,
    logicalTokenId,
    filterTokenId,
    totalSummaries: summaries.length,
    matchedEvents: events.length,
    sampleSummaries: summaries.slice(0, 3),
    sampleEvents: events.slice(0, 3),
  };

  console.log("[PLT-BLOCK-DEBUG] Result:", safeJsonStringify(payload));
}

main().catch((err) => {
  console.error("[PLT-BLOCK-DEBUG] Unhandled error", err);
  process.exit(1);
});
