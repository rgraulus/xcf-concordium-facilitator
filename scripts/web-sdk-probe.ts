// scripts/web-sdk-probe.ts
//
// Simple connectivity probe using @concordium/web-sdk (Node entrypoint).
// Goal: verify whether we can successfully talk to a Concordium node
// over gRPC v2 using the modern web-sdk client.
//
// We call healthCheck + getConsensusStatus and print a compact JSON blob
// about success / failure. We also handle BigInt values in the response.

import {
  ConcordiumGRPCNodeClient,
  credentials,
} from '@concordium/web-sdk/nodejs';
import * as dotenv from 'dotenv';

// Load env so we can reuse CONCORDIUM_* vars if present.
dotenv.config();

export interface WebSdkNodeConfig {
  host: string;
  port: number;
  useTls: boolean;
  timeoutMs: number;
}

/**
 * JSON.stringify that is safe for BigInt by converting BigInt -> string.
 */
export function safeStringify(value: unknown, space: number = 2): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
    space
  );
}

/**
 * Load Concordium gRPC config from environment, with sensible defaults.
 * This is shared between:
 *   - scripts/web-sdk-probe.ts  (CLI probe)
 *   - src/tools/ingestPltFromTxWebSdk.ts (PLT ingest skeleton)
 */
export function loadWebSdkNodeConfigFromEnv(): WebSdkNodeConfig {
  const host =
    process.env.CONCORDIUM_GRPC_HOST ?? 'grpc.testnet.concordium.com';
  const port = Number(process.env.CONCORDIUM_GRPC_PORT ?? 20000);

  // For public Concordium endpoints we default to TLS = true.
  const useTls =
    process.env.CONCORDIUM_GRPC_TLS === 'false' ||
    process.env.CONCORDIUM_GRPC_TLS === '0'
      ? false
      : true;

  const timeoutMs = Number(process.env.CONCORDIUM_GRPC_TIMEOUT_MS ?? 15000);

  return { host, port, useTls, timeoutMs };
}

/**
 * Build a ConcordiumGRPCNodeClient using the config above.
 * We deliberately do NOT use ConcordiumGRPCNodeClient as a *type*,
 * only as a runtime value, to avoid TS2709 ("Cannot use namespace as a type")
 * with some versions of the web-sdk typings.
 */
export function createWebSdkNodeClient(cfg: WebSdkNodeConfig) {
  const channelCreds = cfg.useTls
    ? credentials.createSsl()
    : credentials.createInsecure();

  // Node-specific gRPC client (not usable in browser envs).
  const client = new ConcordiumGRPCNodeClient(
    cfg.host,
    cfg.port,
    channelCreds,
    {
      timeout: cfg.timeoutMs,
    }
  );

  return client;
}

async function main(): Promise<void> {
  const cfg = loadWebSdkNodeConfigFromEnv();
  const endpoint = `${cfg.host}:${cfg.port}`;

  console.log(
    safeStringify(
      {
        step: 'connecting',
        endpoint,
        useTls: cfg.useTls,
        timeoutMs: cfg.timeoutMs,
        client: '@concordium/web-sdk/nodejs',
      },
      2
    )
  );

  const client = createWebSdkNodeClient(cfg);

  try {
    // Cheap ping + a bit of extra info.
    const anyClient: any = client;
    const health: any = await anyClient.healthCheck();
    const consensus: any = await anyClient.getConsensusStatus();

    const payload = {
      ok: true,
      endpoint,
      useTls: cfg.useTls,
      health: {
        ok: health?.ok ?? undefined,
        message: health?.message ?? undefined,
      },
      consensus: {
        bestBlockHeight: consensus?.bestBlockHeight ?? undefined,
        lastFinalizedBlockHeight:
          consensus?.lastFinalizedBlockHeight ?? undefined,
        genesisIndex: consensus?.genesisIndex ?? undefined,
        protocolVersion: consensus?.protocolVersion ?? undefined,
      },
    };

    console.log(safeStringify(payload, 2));
  } catch (err: unknown) {
    const anyErr = err as any;

    console.error('Web-SDK node probe failed:', anyErr);

    const errorPayload = {
      ok: false,
      endpoint,
      useTls: cfg.useTls,
      error: anyErr?.message ?? String(anyErr),
      // gRPC-style fields if present:
      code: anyErr?.code ?? undefined,
      details: anyErr?.details ?? undefined,
    };

    console.log(safeStringify(errorPayload, 2));

    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Web-SDK node probe crashed:', err);
    process.exitCode = 1;
  });
}
