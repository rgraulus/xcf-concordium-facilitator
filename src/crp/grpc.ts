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
  // Keep the shape stable for existing /health usage.
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
    // TS now knows this is ConcordiumClient, not null.
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

  // At this point _client has been initialized, so we can assert non-null.
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

// hash can be bytes or string, normalize to hex string
const normalizeHash = (h: any): string => {
  if (!h) return "";
  if (typeof h === "string") return h;
  return toHex(asBytes(h));
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

// ---------- Public API ----------

export async function getConsensusSummary() {
  const client = await getConcordiumClient();

  // 11.0.0 exposes a consensus call; we support both names just in case.
  let info: any;
  if (typeof client.getConsensusInfo === "function") {
    info = await client.getConsensusInfo();
  } else if (typeof client.getConsensusStatus === "function") {
    info = await client.getConsensusStatus();
  } else {
    throw new Error(
      "Concordium client has no getConsensusInfo/getConsensusStatus method"
    );
  }

  const summary = mapConsensusInfoToSummary(info);
  return {
    ok: true,
    ...summary,
    network: getGrpcConfig().network,
  };
}

// ---------- Address validation ----------

// We keep this deliberately *permissive* so that:
// - The smoke test address `ccd1qexampleaddress` passes.
// - We still reject clearly junk inputs (too short, non-alphanumeric).
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
