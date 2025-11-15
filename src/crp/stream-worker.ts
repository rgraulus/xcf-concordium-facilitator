// src/crp/stream-worker.ts

/**
 * Concordium-facing finalized stream worker.
 *
 * Uses the *raw* consensus info from the Concordium node (debugConsensusInfoRaw)
 * and normalizes:
 *  - lastFinalizedBlock (BlockHash object with .buffer) -> hex string
 *  - lastFinalizedBlockHeight (string/number/bigint)    -> number
 *  - lastFinalizedTime (ISO string or Date)             -> Date
 */

import { ingestFinalizedBlock } from "./stream";
import type { IngestResult } from "./stream";
import { debugConsensusInfoRaw, getGrpcConfig } from "./grpc";

export type StreamOnceResult = IngestResult & {
  skipped: boolean;
  reason?: string;
};

function blockHashToHex(h: any): string {
  if (!h) return "";
  if (typeof h === "string") return h;

  // Handle BlockHash { buffer: Uint8Array(32), ... }
  const buf: any = (h as any).buffer ?? (h as any).value;
  if (buf instanceof Uint8Array || Array.isArray(buf)) {
    return Buffer.from(buf).toString("hex");
  }

  return "";
}

export async function runFinalizedIngestOnce(): Promise<StreamOnceResult> {
  const cfg = getGrpcConfig();
  const info: any = await debugConsensusInfoRaw();

  const network = cfg.network || "unknown";

  const rawBlockHash = info.lastFinalizedBlock;
  const heightRaw = info.lastFinalizedBlockHeight;
  const finalizedTimeRaw = info.lastFinalizedTime;

  const blockHash = blockHashToHex(rawBlockHash);

  // Debug log so we can see what the worker sees:
  // (only shows when running scripts/debug-run-finalized-once.js)
  // eslint-disable-next-line no-console
  console.log("DEBUG runFinalizedIngestOnce:", {
    rawBlockHash,
    blockHash,
    heightRaw,
    finalizedTimeRaw,
  });

  if (!blockHash || blockHash.trim() === "") {
    return {
      blockHash: "",
      height: 0,
      network,
      transfersInserted: 0,
      skipped: true,
      reason: "No usable lastFinalizedBlock hash in consensus info",
    };
  }

  // Height: string | number | bigint -> number (best effort, safe)
  let height = 0;
  if (typeof heightRaw === "string") {
    const parsed = Number(heightRaw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      height = parsed;
    }
  } else if (typeof heightRaw === "number" && Number.isFinite(heightRaw)) {
    height = heightRaw;
  } else if (typeof heightRaw === "bigint") {
    const n = Number(heightRaw);
    if (Number.isSafeInteger(n) && n >= 0) {
      height = n;
    }
  }

  // Finalized time: ISO string or Date -> Date
  let finalizedAt: Date;
  if (typeof finalizedTimeRaw === "string") {
    const d = new Date(finalizedTimeRaw);
    finalizedAt = Number.isNaN(d.getTime()) ? new Date() : d;
  } else if (finalizedTimeRaw instanceof Date) {
    finalizedAt = finalizedTimeRaw;
  } else {
    finalizedAt = new Date();
  }

  // For now we still don't parse any PLT transfers, so transfers = [].
  const ingestResult: IngestResult = await ingestFinalizedBlock({
    network,
    blockHash,
    height,
    finalizedAt,
    transfers: [],
  });

  return {
    ...ingestResult,
    skipped: false,
  };
}
