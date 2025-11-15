// src/crp/grpc.ts
import * as grpcjs from "@grpc/grpc-js";

type GrpcCfg = {
  host: string;         // e.g., grpc.testnet.concordium.com
  port: number;         // e.g., 20000
  tls: boolean;         // true for TLS
  network: "testnet" | "mainnet" | string;
  caFile?: string | null;
};

export function getGrpcConfig(): GrpcCfg {
  const host = process.env.CONCORDIUM_GRPC_HOST || "127.0.0.1";
  const port = Number(process.env.CONCORDIUM_GRPC_PORT || "20000");
  const tls =
    String(process.env.CONCORDIUM_GRPC_TLS || "false")
      .toLowerCase() === "true";
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
  getConsensusInfo?: () => Promise<any>;
  getConsensusStatus?: () => Promise<any>;
};

let _client: ConcordiumClient | null = null;

async function getConcordiumClient(): Promise<ConcordiumClient> {
  if (_client !== null) {
    return _client;
  }

  const cfg = getGrpcConfig();

  // Dynamic import so we don’t have to flip the whole project to ESM.
  const dynamicImport = new Function("specifier", "return import(specifier)");
  const nodejsModule = (await dynamicImport(
    "@concordium/web-sdk/nodejs"
  )) as any;

  const { ConcordiumGRPCNodeClient, credentials } = nodejsModule;
  if (!ConcordiumGRPCNodeClient) {
    throw new Error(
      "ConcordiumGRPCNodeClient not found in @concordium/web-sdk/nodejs"
    );
  }

  const creds =
    cfg.tls && credentials?.createSsl
      ? credentials.createSsl()
      : grpcjs.credentials.createInsecure();

  _client = new ConcordiumGRPCNodeClient(
    cfg.host,
    cfg.port,
    creds,
    { timeout: 15_000 }
  );

  return _client as ConcordiumClient;
}

// Optional compatibility helper if other code still expects getQueriesClient()
export async function getQueriesClient(): Promise<ConcordiumClient> {
  return getConcordiumClient();
}

// ---------- Helpers (bytes / hex / numbers) ----------

const asBytes = (b: any): Uint8Array | undefined => {
  if (!b) return undefined;
  if (b instanceof Uint8Array) return b;
  if (b?.value instanceof Uint8Array) return b.value; // protobuf-ts style wrapper
  if (Array.isArray(b)) return Uint8Array.from(b);
  return undefined;
};

const toHex = (u?: Uint8Array | string): string =>
  typeof u === "string" ? u : (u ? Buffer.from(u).toString("hex") : "");

// unwrap numeric fields that sometimes appear as { value: number }
const num = (v: any): number | null =>
  typeof v === "number"
    ? v
    : v && typeof v.value === "number"
    ? v.value
    : null;

// hash can be different shapes; normalize to hex/string
const normalizeHash = (h: any): string => {
  if (!h) return "";
  if (typeof h === "string") return h;

  // Common object shapes
  if (typeof (h as any).blockHash === "string") return (h as any).blockHash;
  if (typeof (h as any).hash === "string") return (h as any).hash;
  if (typeof (h as any).value === "string") return (h as any).value;

  // Fall back to bytes -> hex
  const bytes = asBytes(h);
  return bytes ? toHex(bytes) : "";
};

// ---------- Public mapping helper ----------

export function mapConsensusInfoToSummary(info: any) {
  const gi = num(info?.genesisIndex);

  const bestHex = normalizeHash(info?.bestBlock);
  const finalizedHex = normalizeHash(info?.lastFinalizedBlock);

  return {
    consensus: { genesisIndex: gi },
    blocks: {
      best:      { hash: bestHex,      height: "" },
      finalized: { hash: finalizedHex, height: "" },
    },
  };
}

// ---------- Raw debug helper ----------

export async function debugConsensusInfoRaw(): Promise<any> {
  const client = await getConcordiumClient();

  if (typeof client.getConsensusInfo === "function") {
    return client.getConsensusInfo();
  }
  if (typeof client.getConsensusStatus === "function") {
    return client.getConsensusStatus();
  }

  throw new Error(
    "Concordium client has no getConsensusInfo/getConsensusStatus method"
  );
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

  // Accept Bech32-like "ccd1..." addresses.
  if (trimmed.startsWith("ccd1")) return true;

  // Accept simple lowercase alphanumeric addresses (e.g. test addresses).
  if (/^[a-z0-9]+$/.test(trimmed)) return true;

  return false;
}

// Backward-compatible alias if older code imported validateAccountAddress
export const validateAccountAddress = isProbablyAccountAddress;
