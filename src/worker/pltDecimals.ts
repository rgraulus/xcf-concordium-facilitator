// src/worker/pltDecimals.ts

/**
 * Simple PLT decimals registry for the CRP worker.
 *
 * The goal is:
 * - Given a (network, tokenId), return the number of decimals, if known.
 * - Make it trivial to extend as we onboard more PLTs.
 *
 * This module is intentionally small and dependency-free so it can be
 * safely used from the stream worker and other CRP components.
 */

export interface PltAssetKey {
  network: string;
  tokenId: string;
}

/**
 * Internal key format for the registry.
 * We keep it simple: `${network}|${tokenId}`
 */
function makeKey(key: PltAssetKey): string {
  return `${key.network}|${key.tokenId}`;
}

/**
 * Registry of known PLT decimals.
 *
 * NOTE:
 * - This is a demo-friendly seed; in production this would likely be
 *   backed by configuration, DB, or an on-chain source of truth.
 */
const PLT_DECIMALS_REGISTRY: Record<string, number> = {
  // Demo Concordium testnet USD token
  // (matches the proto-x402 + CRP demo config: network + tokenId)
  ['concordium:testnet|usd:test']: 2,
};

/**
 * Look up decimals for a given PLT asset.
 *
 * @returns number of decimals if known, otherwise undefined.
 */
export function getPltDecimals(key: PltAssetKey): number | undefined {
  return PLT_DECIMALS_REGISTRY[makeKey(key)];
}

/**
 * Convenience helper to format a minor-unit string using decimals.
 *
 * This is optional; the worker may or may not use it directly, but
 * it’s handy to have here if we want to log / debug scaled amounts.
 */
export function formatPltAmount(minorAmount: string, decimals: number): string {
  if (!minorAmount) return '0';

  const negative = minorAmount.startsWith('-');
  const digits = negative ? minorAmount.slice(1) : minorAmount;

  // Pad with leading zeros if needed
  const padded =
    digits.length <= decimals
      ? '0'.repeat(decimals - digits.length + 1) + digits
      : digits;

  const splitIdx = padded.length - decimals;
  const intPart = padded.slice(0, splitIdx);
  const fracPart = padded.slice(splitIdx);

  const normalized = fracPart.replace(/0+$/, '');
  const result = normalized.length > 0 ? `${intPart}.${normalized}` : intPart;

  return negative ? `-${result}` : result;
}
