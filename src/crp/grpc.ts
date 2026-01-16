// src/crp/grpc.ts
import "dotenv/config";
import * as grpcjs from "@grpc/grpc-js";

type GrpcCfg = {
  host: string;
  port: number;
  tls: boolean;
  network: "testnet" | "mainnet" | string;
  caFile?: string | null;
};

export function getGrpcConfig(): GrpcCfg {
  const host = process.env.CONCORDIUM_GRPC_HOST || "127.0.0.1";
  const port = Number(process.env.CONCORDIUM_GRPC_PORT || "20000");
  const tls = String(process.env.CONCORDIUM_GRPC_TLS || "false").toLowerCase() === "true";
  const network = (process.env.CONCORDIUM_NETWORK || "testnet") as GrpcCfg["network"];
  const caFile = process.env.CONCORDIUM_GRPC_CA || null;
  return { host, port, tls, network, caFile };
}

// ---------- Diagnostics ----------
export async function getTransportDiagnostics() {
  return {
    hasMergeOptions: true,
    transportCtor: "ConcordiumGRPCNodeClient",
    grpcJs: { hasCredentials: !!grpcjs.credentials },
  };
}

// ---------- Concordium web-sdk client (NodeJS) ----------
type ConcordiumClient = {
  getConsensusInfo?: (...args: any[]) => Promise<any>;
  getConsensusStatus?: (...args: any[]) => Promise<any>;
  getBlockInfo?: (...args: any[]) => Promise<any>;
};

let _client: ConcordiumClient | null = null;

async function getConcordiumClient(): Promise<ConcordiumClient> {
  if (_client !== null) return _client;

  const cfg = getGrpcConfig();

  const dynamicImport = new Function("specifier", "return import(specifier)");
  const nodejsModule = (await dynamicImport("@concordium/web-sdk/nodejs")) as any;

  const { ConcordiumGRPCNodeClient, credentials } = nodejsModule;
  if (!ConcordiumGRPCNodeClient) {
    throw new Error("ConcordiumGRPCNodeClient not found in @concordium/web-sdk/nodejs");
  }

  const creds =
    cfg.tls && credentials?.createSsl
      ? credentials.createSsl()
      : grpcjs.credentials.createInsecure();

  _client = new ConcordiumGRPCNodeClient(cfg.host, cfg.port, creds, { timeout: 15_000 });
  return _client as ConcordiumClient;
}

export async function getQueriesClient(): Promise<ConcordiumClient> {
  return getConcordiumClient();
}

// ---------- Helpers ----------
const toHex = (u?: Uint8Array | string): string =>
  typeof u === "string" ? u : u ? Buffer.from(u).toString("hex") : "";

// Recursively find bytes in arbitrarily nested SDK wrapper objects.
function findBytesDeep(x: any, depth = 0): Uint8Array | undefined {
  if (!x || depth > 6) return undefined;

  // direct bytes cases
  if (x instanceof Uint8Array) return x;
  // Buffer (Node) case
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(x)) return new Uint8Array(x);
  if (Array.isArray(x) && x.length > 0 && x.every((n) => typeof n === "number")) {
    return Uint8Array.from(x as number[]);
  }

  // common wrapper fields
  if (x.value !== undefined) {
    const b = findBytesDeep(x.value, depth + 1);
    if (b) return b;
  }
  if (x.bytes !== undefined) {
    const b = findBytesDeep(x.bytes, depth + 1);
    if (b) return b;
  }
  if (x.hash !== undefined) {
    const b = findBytesDeep(x.hash, depth + 1);
    if (b) return b;
  }
  if (x.blockHash !== undefined) {
    const b = findBytesDeep(x.blockHash, depth + 1);
    if (b) return b;
  }

  // generic object scan (bounded)
  if (typeof x === "object") {
    for (const k of Object.keys(x)) {
      const b = findBytesDeep((x as any)[k], depth + 1);
      if (b) return b;
    }
  }

  return undefined;
}

function normalizeHash(h: any): string {
  if (!h) return "";
  if (typeof h === "string") return h;

  // common string fields
  if (typeof h.blockHash === "string") return h.blockHash;
  if (typeof h.hash === "string") return h.hash;
  if (typeof h.value === "string") return h.value;

  // deep bytes scan (Uint8Array / Buffer / wrappers)
  const bytes = findBytesDeep(h);
  return bytes ? toHex(bytes) : "";
}

// number-like: handles number, bigint, or { value: number|bigint|string }
const toNumberOrNull = (v: any): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (v && (typeof v.value === "number" || typeof v.value === "bigint")) return toNumberOrNull(v.value);
  if (v && typeof v.value === "string") {
    const n = Number(v.value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const toHeightStringOrNumber = (v: any): string | number => {
  const n = toNumberOrNull(v);
  if (n !== null) return n;
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v.value === "bigint") return String(v.value);
  if (v && typeof v.value === "string") return v.value;
  if (typeof v === "string") return v;
  return "";
};

// ---------- gRPC call helpers ----------
async function callMaybeWithRequest(fn: (...args: any[]) => Promise<any>): Promise<any> {
  try {
    if (fn.length >= 1) return await fn({}, {});
    return await fn();
  } catch (e1) {
    try {
      if (fn.length >= 1) return await fn();
      return await fn({}, {});
    } catch (e2) {
      throw e2;
    }
  }
}

// ---------- Public mapping helper ----------
export function mapConsensusInfoToSummary(info: any) {
  const gi =
    toNumberOrNull(info?.genesisIndex) ??
    toNumberOrNull(info?.consensus?.genesisIndex) ??
    toNumberOrNull(info?.consensusStatus?.genesisIndex) ??
    null;

  const bestHash =
    normalizeHash(info?.bestBlock) ||
    normalizeHash(info?.bestBlockHash) ||
    normalizeHash(info?.blocks?.best?.hash) ||
    normalizeHash(info?.consensusStatus?.bestBlock) ||
    "";

  const finalizedHash =
    normalizeHash(info?.lastFinalizedBlock) ||
    normalizeHash(info?.lastFinalizedBlockHash) ||
    normalizeHash(info?.blocks?.finalized?.hash) ||
    normalizeHash(info?.consensusStatus?.lastFinalizedBlock) ||
    "";

  const bestHeight =
    toHeightStringOrNumber(info?.bestBlockHeight) ||
    toHeightStringOrNumber(info?.blocks?.best?.height) ||
    toHeightStringOrNumber(info?.consensusStatus?.bestBlockHeight) ||
    "";

  const finalizedHeight =
    toHeightStringOrNumber(info?.lastFinalizedBlockHeight) ||
    toHeightStringOrNumber(info?.blocks?.finalized?.height) ||
    toHeightStringOrNumber(info?.consensusStatus?.lastFinalizedBlockHeight) ||
    "";

  return {
    consensus: { genesisIndex: gi },
    blocks: {
      best: { hash: bestHash, height: bestHeight },
      finalized: { hash: finalizedHash, height: finalizedHeight },
    },
  };
}

// ---------- Raw debug helper ----------
export async function debugConsensusInfoRaw(): Promise<any> {
  const client = await getConcordiumClient();

  if (typeof client.getConsensusInfo === "function") {
    return await callMaybeWithRequest(client.getConsensusInfo.bind(client));
  }
  if (typeof client.getConsensusStatus === "function") {
    return await callMaybeWithRequest(client.getConsensusStatus.bind(client));
  }

  throw new Error("Concordium client has no getConsensusInfo/getConsensusStatus method");
}

// ---------- Public API ----------
export async function getConsensusSummary() {
  const info = await debugConsensusInfoRaw();
  const summary = mapConsensusInfoToSummary(info);

  return {
    ok: true,
    ...summary,
    network: getGrpcConfig().network,
  };
}

// ---------- Address validation ----------
export function isProbablyAccountAddress(s: string): boolean {
  if (typeof s !== "string") return false;
  const trimmed = s.trim();
  if (trimmed.length < 10) return false;
  if (trimmed.startsWith("ccd1")) return true;
  if (/^[a-z0-9]+$/.test(trimmed)) return true;
  return false;
}

export const validateAccountAddress = isProbablyAccountAddress;
