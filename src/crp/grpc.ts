// src/crp/grpc.ts
import fs from "node:fs";
import path from "node:path";

/** gRPC config */
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

let clientPromise: Promise<any> | null = null;

/**
 * Build a Concordium client.
 * Prefer V2 (`createConcordiumClient`) and fall back to V1 (`ConcordiumGRPCClient`) if needed.
 */
export async function getConcordiumClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    // Load SDK + grpc with CommonJS require (most robust on Windows).
    let sdk: any;
    let grpcJs: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      sdk = require("@concordium/node-sdk");
    } catch (e: any) {
      throw new Error(`Failed to require @concordium/node-sdk. ${e?.message || e}`);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      grpcJs = require("@grpc/grpc-js");
    } catch (e: any) {
      throw new Error(`Failed to require @grpc/grpc-js. ${e?.message || e}`);
    }

    const credentials = (grpcJs as any).credentials;
    if (!credentials) throw new Error("credentials export not found in @grpc/grpc-js");

    const cfg = getGrpcConfig();

    // TLS or plaintext credentials
    let creds: any;
    if (cfg.tls) {
      let rootCert: Buffer | undefined;
      if (cfg.caFile) {
        const abs = path.resolve(cfg.caFile);
        rootCert = fs.readFileSync(abs);
      }
      creds = credentials.createSsl(rootCert);
    } else {
      creds = credentials.createInsecure();
    }

    // Prefer V2 API
    const createConcordiumClient = (sdk as any).createConcordiumClient ?? (sdk?.default?.createConcordiumClient);
    if (typeof createConcordiumClient === "function") {
      // V2 client factory is async
      const client = await createConcordiumClient(cfg.host, cfg.port, creds);
      return client;
    }

    // Fallback to legacy V1 class — may fail if the package is missing its local './util'
    const ConcordiumGRPCClient =
      (sdk as any).ConcordiumGRPCClient ?? (sdk?.default?.ConcordiumGRPCClient);
    if (!ConcordiumGRPCClient) {
      throw new Error(
        "Neither createConcordiumClient (V2) nor ConcordiumGRPCClient (V1) was found in @concordium/node-sdk."
      );
    }

    // Construct V1 client as last resort
    return new ConcordiumGRPCClient(cfg.host, cfg.port, creds);
  })();

  return clientPromise;
}

/* ---------- Step 2 helpers ---------- */

export async function getConsensusStatus() {
  const c = await getConcordiumClient();
  // V2 & V1 both expose getConsensusStatus()
  return c.getConsensusStatus();
}

export async function getBlockInfo(blockHash: string) {
  const c = await getConcordiumClient();
  return c.getBlockInfo(blockHash);
}

export async function getBestAndFinalized() {
  const c = await getConcordiumClient();
  const cs = await c.getConsensusStatus();
  const [best, finalized] = await Promise.all([
    c.getBlockInfo(cs.bestBlock),
    c.getBlockInfo(cs.finalizedBlock),
  ]);
  return { best, finalized, hashes: { best: cs.bestBlock, finalized: cs.finalizedBlock } };
}

export async function getAccountInfo(accountAddress: string) {
  const c = await getConcordiumClient();
  return c.getAccountInfo(accountAddress);
}

/* ---------- Step 3: PLT payment search (scaffold) ---------- */

export type PltSearchFilters = {
  tokenId?: string;           // e.g., "usd:test"
  to?: string;                // account address (ccd...)
  min?: string;               // minimum amount as string of base units
  fromHeight?: string;        // optional starting height (string to avoid BigInt)
  limit?: number;             // cap matches returned
};

export type PltMatch = {
  hash: string;               // tx hash
  index: number;              // event index in tx
  tokenId: string;
  amount: string;             // stringified
  from?: string;
  to?: string;
  finalizedAt?: string;       // ISO
  blockHash?: string;
  blockHeight?: string;
};

/**
 * TEMPORARY STUB: returns an empty array but preserves the final shape.
 * This lets us wire the route + smoke now, then implement the SDK traversal next.
 *
 * TODO (replace body):
 *  - walk finalized blocks (from head or fromHeight)
 *  - for each tx -> events, normalize PLT transfers
 *  - apply filters (tokenId, to, min), push until limit
 */
export async function searchPltPayments(filters: PltSearchFilters): Promise<PltMatch[]> {
  void filters; // silence unused warning for now
  return [];
}
