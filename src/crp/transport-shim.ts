// src/crp/transport-shim.ts
import type { RpcOptions, RpcTransport } from "@protobuf-ts/runtime-rpc";

/**
 * Ensure a transport implements mergeOptions(). Some environments end up with a
 * transport-like object missing the method due to resolution/packaging quirks.
 * This safely augments it without mutating types at compile time.
 */
export function ensureMergeOptions<T extends RpcTransport>(t: T): T {
  const anyT = t as any;
  if (typeof anyT.mergeOptions === "function") return t;

  // Fall back to a shallow merge against whatever options object exists.
  const base = anyT.options ?? anyT._options ?? {};
  anyT.mergeOptions = (extra?: RpcOptions) => ({ ...base, ...(extra || {}) });
  return t;
}

