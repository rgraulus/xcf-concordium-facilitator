// src/crp/grpc.ts
/**
 * Concordium gRPC client (lazy, side-effect free).
 * Safe to commit now: does not execute unless you import and call it.
 *
 * Requires (when you start using it in M2):
 *   npm i @concordium/node-sdk @grpc/grpc-js
 *
 * Env used:
 *   CONCORDIUM_NETWORK=testnet|mainnet|devnet (informational)
 *   CONCORDIUM_GRPC_HOST=grpc.testnet.concordium.com
 *   CONCORDIUM_GRPC_PORT=20000
 *   CONCORDIUM_GRPC_TLS=true|false
 *   CONCORDIUM_GRPC_CA_FILE=</path/to/ca>  (optional; usually blank)
 */

import fs from "node:fs";
import path from "node:path";

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
      `Concordium gRPC config invalid: host="${host}", port="${process.env.CONCORDIUM_GRPC_PORT}". ` +
      `Check .env (.env.example shows testnet defaults).`
    );
  }
  return { network, host, port, tls, caFile };
}

/**
 * Lazily create a Concordium gRPC client.
 * Nothing is constructed until you call this.
 *
 * Usage (later, in M2 code):
 *   const client = await getConcordiumClient();
 *   // e.g., await client.getNodeInfo();
 */
let clientPromise: Promise<any> | null = null;

export async function getConcordiumClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    let ConcordiumGRPCClient: any;
    let credentials: any;

    // Soft import so M1 keeps running even if deps not yet installed.
    try {
      ({ ConcordiumGRPCClient } = await import("@concordium/node-sdk"));
    } catch {
      throw new Error(
        "Missing dependency @concordium/node-sdk. Install with:\n" +
        "  npm i @concordium/node-sdk @grpc/grpc-js"
      );
    }
    try {
      ({ credentials } = await import("@grpc/grpc-js"));
    } catch {
      throw new Error(
        "Missing dependency @grpc/grpc-js. Install with:\n" +
        "  npm i @grpc/grpc-js"
      );
    }

    const cfg = getGrpcConfig();
    let creds: any;

    if (cfg.tls) {
      // If a custom CA file is provided, load it; otherwise let Node use system CAs.
      let rootCert: Buffer | undefined;
      if (cfg.caFile) {
        const abs = path.resolve(cfg.caFile);
        rootCert = fs.readFileSync(abs);
      }
      creds = credentials.createSsl(rootCert);
    } else {
      creds = credentials.createInsecure();
    }

    // Construct client (does not call any RPCs).
    const client = new ConcordiumGRPCClient(cfg.host, cfg.port, creds);
    return client;
  })();

  return clientPromise;
}
