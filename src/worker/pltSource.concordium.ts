// src/worker/pltSource.concordium.ts
//
// Concordium-backed PLT event source wiring.
//
// This file is wired behind CRP_STREAM_SOURCE=concordium.
// In this micro-step, we replace the pure stub with a client that
// actually talks to a Concordium node using @concordium/web-sdk,
// but we still return [] for PLT events so the rest of the worker
// semantics remain unchanged.

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
 * The concrete implementation is backed by a Concordium gRPC client
 * created from `@concordium/web-sdk/nodejs`, loaded dynamically.
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
 * Internal representation of how we connect to a Concordium node.
 */
interface ConcordiumNodeConnectionConfig {
  address: string;
  port: number;
  useTls: boolean;
}

/**
 * Parse CONCORDIUM_NODE_URL into a (host, port, useTls) triple.
 *
 * Supported forms:
 *   - "grpc.testnet.concordium.com:20000"
 *   - "https://grpc.testnet.concordium.com:20000"
 *   - "http://localhost:9095"
 *
 * If parsing fails or the env var is empty, we fall back to Concordium's
 * public testnet node (TLS).
 */
function parseNodeUrl(nodeUrlRaw: string | undefined): ConcordiumNodeConnectionConfig {
  const fallback: ConcordiumNodeConnectionConfig = {
    address: "grpc.testnet.concordium.com",
    port: 20000,
    useTls: true,
  };

  const trimmed = nodeUrlRaw?.trim();
  if (!trimmed) {
    return fallback;
  }

  // Case 1: "host:port"
  const hostPortMatch = trimmed.match(/^([^:/]+):(\d+)$/);
  if (hostPortMatch) {
    const [, host, portStr] = hostPortMatch;
    const port = Number(portStr);
    if (!Number.isNaN(port) && port > 0) {
      return {
        address: host,
        port,
        useTls: true,
      };
    }
  }

  // Case 2: full URL, e.g. "https://host:port" or "http://localhost:9095"
  try {
    const url = new URL(trimmed);
    const port =
      url.port && !Number.isNaN(Number(url.port))
        ? Number(url.port)
        : url.protocol === "https:"
        ? 443
        : 20000;

    const useTls = url.protocol === "https:";
    return {
      address: url.hostname,
      port,
      useTls,
    };
  } catch {
    return fallback;
  }
}

/**
 * Dynamic loader for the ConcordiumGRPCNodeClient from @concordium/web-sdk/nodejs.
 *
 * We use a runtime import trick to avoid TypeScript's static module resolution
 * issues with the ESM-only web-sdk package.
 */
let LoadedConcordiumGRPCNodeClient: any | null = null;

async function loadConcordiumGRPCNodeClient(): Promise<any> {
  if (LoadedConcordiumGRPCNodeClient) {
    return LoadedConcordiumGRPCNodeClient;
  }

  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)"
  ) as (s: string) => Promise<any>;

  const nodejsModule = await dynamicImport("@concordium/web-sdk/nodejs");
  LoadedConcordiumGRPCNodeClient = nodejsModule.ConcordiumGRPCNodeClient;

  if (!LoadedConcordiumGRPCNodeClient) {
    throw new Error(
      "Failed to load ConcordiumGRPCNodeClient from @concordium/web-sdk/nodejs"
    );
  }

  return LoadedConcordiumGRPCNodeClient;
}

/**
 * Default Concordium PLT client implementation.
 *
 * For this micro-step, it:
 *   - Connects to a Concordium node.
 *   - Calls getTokenList(undefined) to exercise the PLT API.
 *   - Logs up to 3 token IDs for observability.
 *
 * It STILL returns [] as the list of PltEvent, so the worker behavior
 * is unchanged.
 */
class DefaultConcordiumPltEventClient implements ConcordiumPltEventClient {
  private client: any | null = null;
  private connectionConfig: ConcordiumNodeConnectionConfig | null = null;

  constructor(private readonly nodeUrl: string) {}

  /**
   * Lazily construct the Concordium gRPC client.
   */
  private async getOrCreateClient(): Promise<any> {
    if (this.client) {
      return this.client;
    }

    const baseConfig = parseNodeUrl(this.nodeUrl);
    const insecureEnv = process.env.CONCORDIUM_NODE_INSECURE;
    const forceInsecure =
      insecureEnv === "1" || insecureEnv?.toLowerCase() === "true";

    const useTls = forceInsecure ? false : baseConfig.useTls;
    this.connectionConfig = {
      ...baseConfig,
      useTls,
    };

    const ConcordiumGRPCNodeClient = await loadConcordiumGRPCNodeClient();

    const creds = useTls
      ? credentials.createSsl()
      : credentials.createInsecure();

    this.client = new ConcordiumGRPCNodeClient(
      baseConfig.address,
      baseConfig.port,
      creds,
      { timeout: 15_000 }
    );

    // eslint-disable-next-line no-console
    console.log("[CRP-STREAM][concordium] Created ConcordiumGRPCNodeClient", {
      address: baseConfig.address,
      port: baseConfig.port,
      useTls,
    });

    return this.client;
  }

  async fetchPltEventsSince(
    lastHeight: number,
    cfg: ConcordiumPltEventSourceConfig
  ): Promise<PltEvent[]> {
    const client = await this.getOrCreateClient();

    try {
      // Hit the PLT API by fetching the current PLT list at the latest finalized block.
      const stream = await client.getTokenList(undefined);

      const sampleTokens: string[] = [];
      let count = 0;
      for await (const token of stream) {
        // TokenId supports toString(); we treat it as any.
        sampleTokens.push(String(token));
        count += 1;
        if (count >= 3) break;
      }

      // eslint-disable-next-line no-console
      console.log("[CRP-STREAM][concordium] getTokenList sample", {
        network: cfg.network,
        tokenIdFilter: cfg.tokenId,
        lastHeight,
        nodeConnection: this.connectionConfig,
        sampleCount: sampleTokens.length,
        sampleTokens,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        "[CRP-STREAM][concordium] Error while querying PLT list",
        {
          network: cfg.network,
          tokenIdFilter: cfg.tokenId,
          lastHeight,
          nodeConnection: this.connectionConfig,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : error,
        }
      );
    }

    // TODO (next micro-steps):
    //   - Narrow this to cfg.tokenId via getTokenInfo(TokenId.fromString(cfg.tokenId)).
    //   - Scan finalized blocks for PLT transfer events and map them to PltEvent.
    //
    // For now, keep worker semantics identical to the original stub.
    return [];
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
 *   - CONCORDIUM_NODE_URL
 *       e.g. "grpc.testnet.concordium.com:20000"
 *            "https://grpc.testnet.concordium.com:20000"
 *            "http://localhost:9095"
 *   - CONCORDIUM_NODE_INSECURE
 *       if set to "1" / "true" → force plaintext (useful for local nodes)
 *
 * We keep this intentionally minimal; additional tuning (timeouts,
 * retries, etc.) can be added later without changing call sites.
 */
export function createConcordiumPltEventClientFromEnv(): ConcordiumPltEventClient {
  const nodeUrl =
    process.env.CONCORDIUM_NODE_URL ?? "grpc.testnet.concordium.com:20000";

  return new DefaultConcordiumPltEventClient(nodeUrl);
}
