// src/worker/decimalsRegistry.ts

/**
 * Key identifying a PLT token on a given network.
 */
export interface PltTokenKey {
  /** Logical network identifier, e.g. "concordium:testnet". */
  network: string;
  /** Logical token identifier, e.g. "usd:test". */
  tokenId: string;
}

/**
 * Metadata we care about for a PLT token.
 *
 * We keep this intentionally small and focused on what the
 * CRP worker will actually need when normalizing events.
 */
export interface PltTokenInfo extends PltTokenKey {
  /** Number of fractional decimals, e.g. 2 for cents. */
  decimals: number;

  /**
   * Optional underlying on-chain references.
   * These are kept optional so the registry can be used
   * even when we only know the logical tokenId + decimals.
   */
  contractIndex?: bigint;
  contractSubindex?: bigint;

  /** Optional human-friendly hints (not required by the worker). */
  symbol?: string;
  name?: string;
}

/**
 * Simple in-memory registry for PLT token metadata.
 *
 * The stream worker can:
 *   - look up decimals for a (network, tokenId)
 *   - optionally inspect richer metadata for logging / debugging
 *
 * Later, if needed, this can be backed by a database or config file
 * without changing the worker's calling code.
 */
export class PltDecimalsRegistry {
  private readonly byKey = new Map<string, PltTokenInfo>();

  constructor(initial?: PltTokenInfo[]) {
    if (initial) {
      for (const info of initial) {
        this.add(info);
      }
    }
  }

  private makeKey(network: string, tokenId: string): string {
    return `${network}::${tokenId}`;
  }

  /**
   * Add or replace metadata for a given PLT token.
   */
  add(info: PltTokenInfo): void {
    this.byKey.set(this.makeKey(info.network, info.tokenId), info);
  }

  /**
   * Get full metadata for a given PLT token, if present.
   */
  get(network: string, tokenId: string): PltTokenInfo | undefined {
    return this.byKey.get(this.makeKey(network, tokenId));
  }

  /**
   * Convenience helper when we only care about the decimals.
   */
  getDecimals(network: string, tokenId: string): number | undefined {
    return this.get(network, tokenId)?.decimals;
  }

  /**
   * Simple existence check.
   */
  has(network: string, tokenId: string): boolean {
    return this.byKey.has(this.makeKey(network, tokenId));
  }

  /**
   * Dump registry contents, useful for debugging/logging.
   */
  listAll(): PltTokenInfo[] {
    return Array.from(this.byKey.values());
  }
}

/**
 * Create a registry pre-populated with the demo PLT used
 * throughout the CRP / payfi-gateway integration.
 *
 * This gives the worker a canonical source of truth for
 * the "usd:test" token's decimals on testnet.
 */
export function createDefaultDemoRegistry(): PltDecimalsRegistry {
  const registry = new PltDecimalsRegistry();

  registry.add({
    network: "concordium:testnet",
    tokenId: "usd:test",
    decimals: 2,
    symbol: "USDt",
    name: "Demo USD Stablecoin (testnet)",
  });

  return registry;
}
