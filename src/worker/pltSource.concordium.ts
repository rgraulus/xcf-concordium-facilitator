// src/worker/pltSource.concordium.ts
//
// Concordium-backed PLT event source (latest-block only).
//
// This implementation:
//   - Connects to a Concordium node via gRPC (@concordium/web-sdk/nodejs).
//   - Looks only at the *latest finalized block* on each call.
//   - Fetches that block's transaction events.
//   - Uses the shared PLT extractor (src/crp/pltExtractor.ts) to interpret
//     TokenUpdate / TokenTransfer events for a single PLT token.
//   - Maps those into the worker's internal PltEvent[] shape.
//
// Env interaction:
//   - CONCORDIUM_NODE_URL        -> node URL (e.g. "grpc.testnet.concordium.com:20000").
//   - CONCORDIUM_PLT_TOKEN_ID    -> on-chain PLT token id (for filtering). If unset,
//                                   we fall back to cfg.tokenId.
//
// Height semantics:
//   - Get latest finalized block info via getBlockInfo().
//   - If blockHeight <= lastHeight: return [].
//   - Else:
//       * getBlockTransactionEvents(blockHash)
//       * run PLT extractor
//       * return events mapped to PltEvent[] with height = blockHeight.

import type { PltEvent, PltEventSource } from "./pltSource";
import { credentials } from "@grpc/grpc-js";
import {
  extractPltEventsFromBlockSummaries,
  type BlockTransactionEventLike,
} from "../crp/pltExtractor";

/**
 * Minimal config for the Concordium PLT source.
 */
export interface ConcordiumPltEventSourceConfig {
  /** Logical network identifier, e.g. "concordium:testnet". */
  network: string;
  /** Logical PLT token identifier, e.g. "usd:test" or "EUDemo". */
  tokenId: string;
  /** Number of decimals for this PLT (used for logging / sanity). */
  decimals: number;
}

/**
 * Client interface that the PLT source depends on.
 *
 * The real implementation is backed by a Concordium gRPC client.
 */
export interface ConcordiumPltEventClient {
  /**
   * Fetch PLT transfer events strictly above the given height.
   *
   * The returned heights must be monotonically increasing.
   */
  fetchPltEventsSince(
    lastHeight: number,
    cfg: ConcordiumPltEventSourceConfig
  ): Promise<PltEvent[]>;
}

/**
 * Internal helper describing the parsed gRPC node connection.
 */
interface ConcordiumNodeConnection {
  address: string;
  port: number;
  useTls: boolean;
}

/**
 * Parse CONCORDIUM_NODE_URL into (address, port, useTls).
 *
 * Supported forms:
 *   - "localhost:9095"                     (no TLS)
 *   - "grpc.testnet.concordium.com:20000"  (TLS)
 *   - "http://localhost:9095"              (no TLS)
 *   - "https://example.com:443"            (TLS)
 */
function parseNodeUrl(raw: string): ConcordiumNodeConnection {
  // If it looks like it has a scheme, go through URL.
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

  // Otherwise: host[:port] form.
  const [host, portStr] = raw.split(":");
  const port = portStr ? Number(portStr) : 20000;

  return {
    address: host || "localhost",
    port: Number.isFinite(port) ? port : 20000,
    // Concordium public gRPC (mainnet/testnet) uses TLS on 20000.
    useTls: port === 20000,
  };
}

// --- Dynamic JS-SDK loading -------------------------------------------------

let ConcordiumGRPCNodeClientCtor: any | undefined;
let BlockHash: any | undefined;

/**
 * Load the relevant JS-SDK pieces via dynamic import.
 *
 * This keeps TypeScript happy even though the
 * @concordium/web-sdk nodejs entrypoint uses ESM under the hood.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/**
 * Real Concordium-backed implementation of the PLT event client.
 *
 * Latest-block-only strategy:
 *   - Find the latest finalized block (via getBlockInfo()).
 *   - If its height <= lastHeight: return [].
 *   - Otherwise:
 *       * Fetch its transaction events (getBlockTransactionEvents).
 *       * Run the shared PLT extractor.
 *       * Map to PltEvent[] with height = blockHeight.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
class ConcordiumGrpcPltEventClient implements ConcordiumPltEventClient {
  private readonly nodeUrl: string;

  constructor(nodeUrl: string) {
    this.nodeUrl = nodeUrl;
  }

  async fetchPltEventsSince(
    lastHeight: number,
    cfg: ConcordiumPltEventSourceConfig
  ): Promise<PltEvent[]> {
    await loadConcordiumSdkModules();

    const { address, port, useTls } = parseNodeUrl(this.nodeUrl);

    // eslint-disable-next-line no-console
    console.log("[CRP-STREAM][concordium] Using node connection", {
      nodeUrl: this.nodeUrl,
      parsed: { address, port, useTls },
      network: cfg.network,
      logicalTokenId: cfg.tokenId,
      lastHeight,
    });

    if (!ConcordiumGRPCNodeClientCtor || !BlockHash) {
      // eslint-disable-next-line no-console
      console.warn(
        "[CRP-STREAM][concordium] Concordium JS-SDK modules not loaded; returning no events."
      );
      return [];
    }

    const creds = useTls
      ? credentials.createSsl()
      : credentials.createInsecure();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = new ConcordiumGRPCNodeClientCtor(address, port, creds);

    // 1) Get latest finalized block info.
    let blockInfo: any;
    try {
      blockInfo = await client.getBlockInfo();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[CRP-STREAM][concordium] Error while querying latest block info",
        {
          error: err,
        }
      );
      return [];
    }

    const rawHeight = blockInfo?.blockHeight;
    const blockHeight =
      typeof rawHeight === "bigint" ? Number(rawHeight) : Number(rawHeight);

    if (!Number.isFinite(blockHeight)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[CRP-STREAM][concordium] Latest block height is not a finite number; returning no events.",
        { rawHeight }
      );
      return [];
    }

    // Short-circuit if we have already processed this or a later block.
    if (blockHeight <= lastHeight) {
      // eslint-disable-next-line no-console
      console.log(
        "[CRP-STREAM][concordium] No new blocks since lastHeight; skipping.",
        { lastHeight, blockHeight }
      );
      return [];
    }

    const blockHashObj = blockInfo.blockHash;
    const blockHashStr =
      blockHashObj &&
      typeof (blockHashObj as { toString?: () => string }).toString ===
        "function"
        ? (blockHashObj as { toString: () => string }).toString()
        : String(blockHashObj ?? "");

    const filterTokenIdEnv = process.env.CONCORDIUM_PLT_TOKEN_ID;
    const filterTokenId =
      typeof filterTokenIdEnv === "string" && filterTokenIdEnv.trim() !== ""
        ? filterTokenIdEnv.trim()
        : cfg.tokenId;

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
      // eslint-disable-next-line no-console
      console.warn(
        "[CRP-STREAM][concordium] Error while iterating getBlockTransactionEvents",
        { blockHash: blockHashStr, error: err }
      );
      return [];
    }

    const extracted = extractPltEventsFromBlockSummaries({
      network: cfg.network,
      tokenId: cfg.tokenId,
      filterTokenId,
      blockHash: blockHashStr,
      blockHeight,
      summaries,
    });

    // Debug log for this latest block.
    // eslint-disable-next-line no-console
    console.log("[CRP-STREAM][concordium] latest-block sample", {
      network: cfg.network,
      tokenIdFilter: filterTokenId,
      blockHash: blockHashStr,
      blockHeight,
      totalSummaries: summaries.length,
      matchedEvents: extracted.length,
      sampleSummaries: summaries.slice(0, 1),
      sampleEvents: extracted.slice(0, 1),
    });

    const events: PltEvent[] = extracted.map((ev) => ({
      height: ev.blockHeight,
      txHash: ev.txHash,
      tokenId: ev.tokenId,
      amount: ev.amount,
      from: ev.from,
      to: ev.to,
    }));

    // Enforce > lastHeight & ascending height.
    return events
      .filter((ev) => ev.height > lastHeight)
      .sort((a, b) => a.height - b.height);
  }
}

/**
 * Concordium-backed implementation of PltEventSource.
 *
 * It delegates to a ConcordiumPltEventClient to do the actual chain I/O,
 * and only enforces the PltEventSource contract (monotone heights, etc.).
 */
export class ConcordiumPltEventSource implements PltEventSource {
  constructor(
    private readonly cfg: ConcordiumPltEventSourceConfig,
    private readonly client: ConcordiumPltEventClient
  ) {}

  async fetchSince(lastHeight: number): Promise<PltEvent[]> {
    const events = await this.client.fetchPltEventsSince(lastHeight, this.cfg);

    // Basic sanity: sort by height ascending and drop any <= lastHeight.
    const filtered = events
      .filter((ev) => ev.height > lastHeight)
      .sort((a, b) => a.height - b.height);

    return filtered;
  }
}

/**
 * Helper to construct a default ConcordiumPltEventClient from environment.
 *
 * Env vars:
 *   - CONCORDIUM_NODE_URL      -> e.g. "grpc.testnet.concordium.com:20000"
 *   - CONCORDIUM_PLT_TOKEN_ID  -> on-chain PLT token id (e.g. "EUDemo"), optional.
 *
 * If CONCORDIUM_PLT_TOKEN_ID is not set, we fall back to cfg.tokenId.
 */
export function createConcordiumPltEventClientFromEnv(): ConcordiumPltEventClient {
  const nodeUrl =
    process.env.CONCORDIUM_NODE_URL ?? "http://localhost:9095";

  return new ConcordiumGrpcPltEventClient(nodeUrl);
}
