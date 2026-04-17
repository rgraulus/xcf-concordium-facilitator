/**
 * src/lib/networkId.ts
 *
 * Goal:
 * - Accept both legacy "concordium:testnet" / "concordium:mainnet"
 *   and CAIP-2 "ccd:<genesisHash>"
 * - Normalize where possible
 * - Provide candidate lists so DB lookups match legacy rows during migration
 *
 * Notes:
 * - We hardcode Concordium Testnet/Mainnet genesis hashes (can be extended).
 * - If you want this to be fully dynamic later, we can add env-based alias config.
 */

export const CONCORDIUM_TESTNET_CHAIN_ID = "ccd:4221332d34e1694168c2a0c0b3fd0f27";
export const CONCORDIUM_MAINNET_CHAIN_ID = "ccd:9dd9ca4d19e9393877d2c44b70f89acb";

export function normalizeNetworkId(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return s;

  // Normalize trivial variants/casing
  const lower = s.toLowerCase();

  // Accept legacy as-is (already canonical in our system)
  if (lower === "concordium:testnet") return "concordium:testnet";
  if (lower === "concordium:mainnet") return "concordium:mainnet";

  // CAIP-2 form for Concordium (chain_id is genesis hash)
  // Keep original casing of the genesis hash, but standardize prefix to "ccd:"
  if (lower.startsWith("ccd:")) {
    const parts = s.split(":");
    if (parts.length >= 2 && parts[1].trim()) {
      return `ccd:${parts[1].trim()}`;
    }
    return "ccd:"; // odd but stable
  }

  // Unknown network: passthrough
  return s;
}

/**
 * networkCandidates()
 * Given an input network (either CAIP-2 or legacy),
 * return an ordered array of equivalent network IDs we should try in DB queries.
 */
export function networkCandidates(raw: string): string[] {
  const normalized = normalizeNetworkId(raw);
  const out = new Set<string>();
  if (normalized) out.add(normalized);

  // Map CAIP-2 to legacy, where we know the genesis hash.
  if (normalized.startsWith("ccd:")) {
    // Concordium Testnet genesis
    if (normalized === CONCORDIUM_TESTNET_CHAIN_ID) {
      out.add("concordium:testnet");
    }

    // Concordium Mainnet genesis
    if (normalized === CONCORDIUM_MAINNET_CHAIN_ID) {
      out.add("concordium:mainnet");
    }
  }

  // Map legacy to CAIP-2 when known.
  if (normalized === "concordium:testnet") {
    out.add(CONCORDIUM_TESTNET_CHAIN_ID);
  }
  if (normalized === "concordium:mainnet") {
    out.add(CONCORDIUM_MAINNET_CHAIN_ID);
  }

  return Array.from(out);
}
