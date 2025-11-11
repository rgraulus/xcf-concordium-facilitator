// src/crp/grpc.ts
import fs from "node:fs";
import path from "node:path";
import { GrpcTransport, type GrpcOptions } from "@protobuf-ts/grpc-transport";
import { ensureMergeOptions } from "./transport-shim";

// ---- Local helpers / env config -----------------------------

export type GrpcConfig = {
  network: string;
  host: string;
  port: number;
  tls: boolean;
  caFile?: string;
};

function bool(v: string | undefined, d: boolean) {
  if (v == null) return d;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function getGrpcConfig(): GrpcConfig {
  const network = process.env.CONCORDIUM_NETWORK || "testnet";
  const host = process.env.CONCORDIUM_GRPC_HOST || "grpc.testnet.concordium.com";
  const port = Number(process.env.CONCORDIUM_GRPC_PORT || "20000");
  const tls = bool(process.env.CONCORDIUM_GRPC_TLS, true);
  const caFile = (process.env.CONCORDIUM_GRPC_CA_FILE || "").trim() || undefined;

  if (!host || !Number.isFinite(port)) {
    throw new Error(
      `Concordium gRPC config invalid: host="${host}", port="${process.env.CONCORDIUM_GRPC_PORT}". Check .env`
    );
  }
  return { network, host, port, tls, caFile };
}

/**
 * Build a v2-compatible transport; make sure it has mergeOptions(), since the
 * generated v2 client calls it.
 */
function makeTransport(): GrpcTransport {
  const { host, port, tls, caFile } = getGrpcConfig();
  const baseUrl = `${host}:${port}`;

  const grpc = require("@grpc/grpc-js");
  const creds = tls
    ? grpc.credentials.createSsl(caFile ? fs.readFileSync(path.resolve(caFile)) : undefined)
    : grpc.credentials.createInsecure();

  const options: GrpcOptions = {
    host: baseUrl,
    channelCredentials: creds,
  };

  const transport = new GrpcTransport(options);
  return ensureMergeOptions(transport);
}

// ---- Concordium client (v2 wrapper via common-sdk) ----------

let clientPromise: Promise<any> | null = null;

async function makeConcordiumClient() {
  const { ConcordiumGRPCClient } = require("@concordium/common-sdk");
  const t = makeTransport();
  return new ConcordiumGRPCClient(t);
}

export async function getConcordiumClient() {
  if (!clientPromise) clientPromise = makeConcordiumClient();
  return clientPromise;
}

// ---- Public API used by routes -------------------------------

function extractHeight(info: any): string {
  const h =
    info?.blockHeight ??
    info?.height ??
    info?.result?.height ??
    info?.blockInfo?.height ??
    info?.summary?.height;
  return h !== undefined ? String(h) : "";
}

function stringifyHash(h: any): string {
  if (!h) return "";
  if (typeof h === "string") return h;
  if (h.hash) return String(h.hash);
  if (Array.isArray(h)) return Buffer.from(h).toString("hex");
  if (h instanceof Uint8Array) return Buffer.from(h).toString("hex");
  return String(h);
}

export async function getConsensusStatus() {
  const c = await getConcordiumClient();
  return c.getConsensusStatus();
}

export async function getBlockInfo(blockHash: any) {
  const c = await getConcordiumClient();
  return c.getBlockInfo(blockHash);
}

export async function getBestAndFinalized() {
  const c = await getConcordiumClient();
  const cs = await c.getConsensusStatus();

  // v2: lastFinalizedBlock
  const bestHash = cs.bestBlock;
  const finalizedHash = cs.lastFinalizedBlock;

  const [bestInfo, finalizedInfo] = await Promise.all([
    c.getBlockInfo(bestHash),
    c.getBlockInfo(finalizedHash),
  ]);

  return {
    consensus: {
      genesisIndex: cs.genesisIndex,
      bestBlock: stringifyHash(bestHash),
    },
    blocks: {
      best: {
        hash: stringifyHash(bestHash),
        height: extractHeight(bestInfo),
      },
      finalized: {
        hash: stringifyHash(finalizedHash),
        height: extractHeight(finalizedInfo),
      },
    },
  };
}

export async function getAccountInfo(accountAddress: string) {
  const c = await getConcordiumClient();
  return c.getAccountInfo(accountAddress);
}

// --------- PLT search scaffolding (types + function) ----------

export type PltSearchFilters = {
  tokenId?: string;
  fromBlock?: string; // hex hash
  limit?: number;
};

export async function searchPltPayments(filters: PltSearchFilters) {
  const { limit = 25 } = filters || {};
  const c = await getConcordiumClient();
  await c.getConsensusStatus(); // exercises transport.mergeOptions()

  return { ok: true, filters: { ...filters, limit }, matches: [] as any[] };
}
