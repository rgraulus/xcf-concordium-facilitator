// src/worker/pltSource.concordium.ts
//
// Concordium-backed PLT event source.
//
// Step 1 goal:
//   - Connect to a Concordium node via gRPC (ConcordiumGRPCNodeClient).
//   - Inspect the latest finalized block's transaction events.
//   - Extract TokenUpdateSummary -> TokenTransferEvent for a single PLT token.
//   - Map those into our internal PltEvent[] shape.
//
// Design notes:
//   - We deliberately keep this "latest block only" for now. That is
//     enough to prove end-to-end, read-only detection on real chain
//     data. Later steps can broaden this to a proper height scan.
//   - We avoid compile-time imports from @concordium/web-sdk/nodejs
//     to stay friendly with the current tsconfig moduleResolution.
//     Instead we use dynamic imports + 'any' at the edges.
//   - We are conservative in our assumptions about the JS-SDK types:
//
//       * Block transaction events -> BlockItemSummaryInBlock-like.
//       * TokenUpdateSummary has { transactionType: "TokenUpdate", events }.
//       * TokenTransferEvent has { tag: "TokenTransfer", tokenId, amount, from, to }.
//
//     Where structure is uncertain, we log and fail soft (skip), not hard.

import type { PltEvent, PltEventSource } from "./pltSource";
import { credentials } from "@grpc/grpc-js";

/**
 * Minimal config for the Concordium PLT source.
 */
export interface ConcordiumPltEventSourceConfig {
  /** Logical network identifier, e.g. "concordium:testnet". */
  network: string;
  /** Logical PLT token identifier, e.g. "usd:test". */
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
 *   - "localhost:9095"         (no TLS)
 *   - "grpc.testnet.concordium.com:20000" (TLS)
 *   - "http://localhost:9095"  (no TLS)
 *   - "https://example.com:443" (TLS)
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
let grpcNamespace: any | undefined;

/**
 * Load the relevant JS-SDK pieces via dynamic import.
 *
 * This keeps the TypeScript compile happy even though the
 * @concordium/web-sdk nodejs entrypoint uses ESM under the hood.
 */
async function loadConcordiumSdkModules() {
  if (!ConcordiumGRPCNodeClientCtor) {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)"
    ) as (specifier: string) => Promise<any>;

    const nodejsModule = await dynamicImport("@concordium/web-sdk/nodejs");
    ConcordiumGRPCNodeClientCtor = nodejsModule.ConcordiumGRPCNodeClient;
  }

  if (!BlockHash || !grpcNamespace) {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)"
    ) as (specifier: string) => Promise<any>;

    const webSdkModule = await dynamicImport("@concordium/web-sdk");
    // BlockHash type helper + grpc namespace with isKnown/knownOrError.
    BlockHash = webSdkModule.BlockHash;
    grpcNamespace = webSdkModule.grpc ?? webSdkModule;
  }
}

/**
 * Real Concordium-backed implementation of the PLT event client.
 *
 * For Step 1 we:
 *   - Find the latest finalized block (via getBlockInfo()).
 *   - If its height <= lastHeight: return [].
 *   - Otherwise:
 *       * Fetch its transaction events (getBlockTransactionEvents).
 *       * Filter TokenUpdateSummary items.
 *       * Inside those, filter TokenTransferEvent for our PLT token.
 *       * Map to PltEvent[] with height = blockHeight.
 */
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

    if (!ConcordiumGRPCNodeClientCtor || !BlockHash || !grpcNamespace) {
      // eslint-disable-next-line no-console
      console.warn(
        "[CRP-STREAM][concordium] Concordium JS-SDK modules not loaded; returning no events."
      );
      return [];
    }

    const creds = useTls
      ? credentials.createSsl()
      : credentials.createInsecure();

    const client = new ConcordiumGRPCNodeClientCtor(address, port, creds);

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
    const blockHash =
      blockHashObj && typeof blockHashObj.toString === "function"
        ? blockHashObj.toString()
        : String(blockHashObj ?? "");

    // 2) Fetch transaction events for this block only.
    let txEventStream: AsyncIterable<any>;
    try {
      const bh = blockHash
        ? BlockHash.fromHexString
          ? BlockHash.fromHexString(blockHash)
          : blockHash
        : undefined;

      txEventStream = bh
        ? client.getBlockTransactionEvents(bh)
        : client.getBlockTransactionEvents();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[CRP-STREAM][concordium] Error while creating tx-event stream",
        {
          error: err,
          blockHash,
        }
      );
      return [];
    }

    const isKnown =
      typeof grpcNamespace.isKnown === "function"
        ? grpcNamespace.isKnown.bind(grpcNamespace)
        : undefined;

    const filterTokenId =
      process.env.CONCORDIUM_PLT_TOKEN_ID && process.env.CONCORDIUM_PLT_TOKEN_ID.length > 0
        ? process.env.CONCORDIUM_PLT_TOKEN_ID
        : cfg.tokenId;

    const results: PltEvent[] = [];
    const sampleTransactionTypes: string[] = [];
    const sampleTokenEvents: any[] = [];

    try {
      for await (const item of txEventStream) {
        // BlockItemSummaryInBlock-like: { summary, transactionHash, ... }
        const summary: any = item?.summary ?? item;

        if (!summary) {
          continue;
        }

        const txType: string =
          summary.transactionType ?? summary.type ?? "<unknown>";
        const txHashVal =
          item?.transactionHash ??
          summary.transactionHash ??
          summary.hash ??
          undefined;
        const txHash =
          txHashVal && typeof txHashVal.toString === "function"
            ? txHashVal.toString()
            : String(txHashVal ?? "");

        if (sampleTransactionTypes.length < 5) {
          sampleTransactionTypes.push(txType);
        }

        // We're only interested in token updates (TokenUpdateSummary).
        if (txType !== "TokenUpdate") {
          continue;
        }

        const events: any[] = Array.isArray(summary.events)
          ? summary.events
          : [];

        for (const rawEv of events) {
          const ev = isKnown && !isKnown(rawEv) ? undefined : rawEv;
          if (!ev) {
            continue;
          }

          // TokenTransferEvent: { tag: "TokenTransfer", tokenId, amount, from, to, ... }
          if (ev.tag !== "TokenTransfer") {
            continue;
          }

          if (sampleTokenEvents.length < 3) {
            sampleTokenEvents.push(ev);
          }

          const tokenIdVal = ev.tokenId;
          const tokenIdStr =
            tokenIdVal && typeof tokenIdVal.toString === "function"
              ? tokenIdVal.toString()
              : String(tokenIdVal ?? "");

          if (filterTokenId && tokenIdStr !== filterTokenId) {
            continue;
          }

          const amountVal = ev.amount;
          const amountStr =
            amountVal && typeof amountVal.toString === "function"
              ? amountVal.toString()
              : String(amountVal ?? "");

          const fromUp = ev.from;
          const toUp = ev.to;

          const fromVal = isKnown && !isKnown(fromUp) ? undefined : fromUp;
          const toVal = isKnown && !isKnown(toUp) ? undefined : toUp;

          const fromStr =
            fromVal && typeof fromVal.toString === "function"
              ? fromVal.toString()
              : fromVal
              ? JSON.stringify(fromVal)
              : undefined;

          const toStr =
            toVal && typeof toVal.toString === "function"
              ? toVal.toString()
              : toVal
              ? JSON.stringify(toVal)
              : undefined;

          results.push({
            height: blockHeight,
            txHash: txHash || `<unknown-${blockHeight}-${results.length}>`,
            tokenId: cfg.tokenId, // logical token id used by CRP
            amount: amountStr,
            from: fromStr,
            to: toStr,
          });
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[CRP-STREAM][concordium] Error while iterating tx-event stream",
        {
          error: err,
          blockHash,
        }
      );
      return [];
    }

    // Debug samples for introspection.
    // eslint-disable-next-line no-console
    console.log("[CRP-STREAM][concordium] getBlockTransactionEvents sample", {
      network: cfg.network,
      tokenIdFilter: filterTokenId,
      blockHash,
      blockHeight,
      sampleTransactionTypes,
      sampleTokenEvents,
      matchedEvents: results.length,
    });

    return results;
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
 *   - CONCORDIUM_PLT_TOKEN_ID  -> on-chain PLT token id (e.g. "t-USD"), optional.
 *
 * If CONCORDIUM_PLT_TOKEN_ID is not set, we fall back to cfg.tokenId.
 */
export function createConcordiumPltEventClientFromEnv(): ConcordiumPltEventClient {
  const nodeUrl =
    process.env.CONCORDIUM_NODE_URL ?? "http://localhost:9095";

  return new ConcordiumGrpcPltEventClient(nodeUrl);
}

