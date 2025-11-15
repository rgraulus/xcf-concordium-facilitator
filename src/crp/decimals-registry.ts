// src/crp/decimals-registry.ts

/**
 * Simple in-memory decimals registry for PLT tokens.
 * - Seeded with known test token(s), e.g. "usd:test" -> 2.
 * - Can be overridden/extended via env PLT_DECIMALS_OVERRIDES='{"usd:test":2}'.
 */

export type DecimalsRegistrySnapshot = Record<string, number>;

// Seed with what we already know from the smokes / idempotency tests.
const defaultEntries: DecimalsRegistrySnapshot = {
  "usd:test": 2,
};

const registry = new Map<string, number>();

function loadFromEnv() {
  const raw = process.env.PLT_DECIMALS_OVERRIDES;
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === "string" && typeof v === "number" && Number.isInteger(v) && v >= 0) {
          registry.set(k, v);
        }
      }
    }
  } catch {
    // Ignore bad env; we don't want to crash the server because of a typo.
  }
}

// Initialize registry
for (const [k, v] of Object.entries(defaultEntries)) {
  registry.set(k, v);
}
loadFromEnv();

/**
 * Get decimals for a tokenId (e.g. "usd:test").
 * Returns null if unknown.
 */
export function getDecimals(tokenId: string): number | null {
  const val = registry.get(tokenId);
  return typeof val === "number" ? val : null;
}

/**
 * Set / override decimals at runtime (useful for bootstrapping or tests).
 */
export function setDecimals(tokenId: string, decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid decimals for ${tokenId}: ${decimals}`);
  }
  registry.set(tokenId, decimals);
}

/**
 * Snapshot all known decimals as a plain object (for logging/debugging).
 */
export function snapshotRegistry(): DecimalsRegistrySnapshot {
  const out: DecimalsRegistrySnapshot = {};
  for (const [k, v] of registry.entries()) {
    out[k] = v;
  }
  return out;
}

/**
 * Convert a major-unit string (e.g. "25.00" with 2 decimals) into minor units as a string ("2500").
 * This is safe for large amounts because it works with strings, not floats.
 */
export function toMinorUnits(amountMajor: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }

  const trimmed = amountMajor.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount format: ${amountMajor}`);
  }

  const negative = trimmed.startsWith("-");
  const [intPartRaw, fracPartRaw = ""] = trimmed.replace("-", "").split(".");
  const intPart = intPartRaw || "0";

  let fracPart = fracPartRaw;
  if (fracPart.length > decimals) {
    // Too many decimal places for this token; you can choose to round or reject.
    throw new Error(
      `Too many decimal places for amount ${amountMajor} with decimals=${decimals}`
    );
  }

  // Right-pad fractional part to the decimals length.
  while (fracPart.length < decimals) {
    fracPart += "0";
  }

  let combined = intPart + fracPart;
  // Strip leading zeros (but keep at least one digit)
  combined = combined.replace(/^0+/, "") || "0";

  return negative && combined !== "0" ? `-${combined}` : combined;
}

/**
 * Convert minor units (e.g. "2500" with 2 decimals) into a major-unit string ("25.00").
 */
export function fromMinorUnits(amountMinor: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }

  const trimmed = amountMinor.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Invalid minor amount format: ${amountMinor}`);
  }

  const negative = trimmed.startsWith("-");
  let digits = trimmed.replace("-", "");

  while (digits.length <= decimals) {
    digits = "0" + digits;
  }

  const intPart = digits.slice(0, digits.length - decimals);
  const fracPart = digits.slice(digits.length - decimals);

  const result = `${intPart}.${fracPart}`;
  return negative && result !== "0.0".padEnd(decimals + 2, "0")
    ? `-${result}`
    : result;
}
