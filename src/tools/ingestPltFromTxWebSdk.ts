// src/tools/ingestPltFromTxWebSdk.ts
//
// M3.5 – EUDemo PLT ingest skeleton via @concordium/web-sdk (Node entrypoint)
//
// Goal (phase 1 / skeleton):
//   - Connect to Concordium node via @concordium/web-sdk/nodejs
//   - Fetch *something* like a transaction / block-item status for a given tx hash
//   - Print a safe JSON snapshot (BigInt-safe) for inspection
//   - (Optional) Connect to XCF Postgres and confirm PLT registry presence
//
// Later phases (once we confirm the exact web-sdk tx-status API + event shape):
//   - Extract PLT transfer/mint/burn events from the tx outcome
//   - Insert rows into crp_plt_events (using crp_plt_assets for decimals/asset_id)
//   - Make the tool idempotent for a given (txHash, eventIndex)
//
// Environment variables:
//
//   XCF_PLT_INGEST_TX_HASH          – REQUIRED. Hex string of the transaction hash to inspect.
//   XCF_PLT_INGEST_ASSET_ID         – Optional. Defaults to 'concordium:testnet:PLT:EUDemo'.
//   XCF_PLT_INGEST_NETWORK_GENESIS  – Optional. Defaults to 6 (public testnet).
//
//   CRP_DB_CONN_STRING / DATABASE_URL – Postgres URL for XCF DB
//
//   CONCORDIUM_GRPC_HOST / CONCORDIUM_GRPC_PORT / CONCORDIUM_GRPC_TLS / CONCORDIUM_GRPC_TIMEOUT_MS
//     – Node connection config (same scheme as scripts/web-sdk-probe.ts).
//
// Usage:
//
//   export XCF_PLT_INGEST_TX_HASH=5b67a0...cbf5
//   npm run plt:ingest:web-sdk
//
// Notes:
//   - This is intentionally "preview-only": it only prints what it sees.
//   - Once we lock down the web-sdk tx API and see a real EUDemo PLT tx,
//     we can wire in the crp_plt_events INSERT logic.
//

import { Client as PgClient } from "pg";

// Reuse the proven web-sdk wiring from scripts/web-sdk-probe.ts
import {
  loadWebSdkNodeConfigFromEnv,
  createWebSdkNodeClient,
  safeStringify,
} from "../../scripts/web-sdk-probe";

function getPgConnectionString(): string {
  const conn =
    process.env.CRP_DB_CONN_STRING ??
    process.env.DATABASE_URL ??
    // Fallback to the same DB we use for transaction-logger & PLT tables
    "postgres://postgres:pg@127.0.0.1:5432/transaction-outcome";
  return conn;
}

function getTxHashFromEnv(): string {
  const tx = process.env.XCF_PLT_INGEST_TX_HASH;
  if (!tx || tx.trim().length === 0) {
    throw new Error(
      "XCF_PLT_INGEST_TX_HASH is required (hex-encoded transaction hash)."
    );
  }
  return tx.trim();
}

function getAssetIdFromEnv(): string {
  return (
    process.env.XCF_PLT_INGEST_ASSET_ID ??
    "concordium:testnet:PLT:EUDemo"
  );
}

function getNetworkGenesisIndexFromEnv(): number {
  const raw = process.env.XCF_PLT_INGEST_NETWORK_GENESIS;
  if (!raw) return 6; // default: public testnet
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 6;
  return n;
}

/**
 * Best-effort helper to fetch a transaction / block-item status from the
 * Concordium gRPC node using the web-sdk client.
 *
 * IMPORTANT:
 *   We deliberately use `any` to avoid type-level coupling to a specific
 *   @concordium/web-sdk version. If the concrete method name differs
 *   (getBlockItemStatus vs getTransactionStatus, etc.), this function will
 *   surface a clear runtime error which we can then adapt.
 */
async function fetchTxStatusViaWebSdk(
  client: ReturnType<typeof createWebSdkNodeClient>,
  txHashHex: string
): Promise<unknown> {
  const anyClient: any = client;

  // Decode hex → bytes (node Buffer is fine for gRPC)
  const txHashBytes = Buffer.from(txHashHex, "hex");

  // Try a couple of plausible method names in order.
  // If none exist, we throw a clear error.
  if (typeof anyClient.getBlockItemStatus === "function") {
    return anyClient.getBlockItemStatus(txHashBytes);
  }

  if (typeof anyClient.getTransactionStatus === "function") {
    return anyClient.getTransactionStatus(txHashBytes);
  }

  if (typeof anyClient.getBlockItem === "function") {
    return anyClient.getBlockItem(txHashBytes);
  }

  throw new Error(
    "ConcordiumGRPCNodeClient does not expose a known tx-status method (getBlockItemStatus/getTransactionStatus/getBlockItem). Please adapt fetchTxStatusViaWebSdk to the actual web-sdk API."
  );
}

/**
 * Optional: quick sanity ping against Postgres + PLT registry.
 * We keep this lightweight and read-only.
 */
async function debugPltRegistry(
  client: PgClient,
  assetId: string
): Promise<{
  hasAssetRow: boolean;
  assetRow?: Record<string, unknown>;
  eventCount: number;
}> {
  const assetRes = await client.query(
    `SELECT * FROM crp_plt_assets WHERE asset_id = $1 LIMIT 1`,
    [assetId]
  );
  const eventRes = await client.query(
    `SELECT COUNT(*) AS cnt FROM crp_plt_events`
  );

  const hasAssetRow = assetRes.rows.length > 0;
  const assetRow = hasAssetRow ? assetRes.rows[0] : undefined;
  const eventCount = Number(eventRes.rows[0]?.cnt ?? "0");

  return { hasAssetRow, assetRow, eventCount };
}

async function main(): Promise<void> {
  const txHash = getTxHashFromEnv();
  const assetId = getAssetIdFromEnv();
  const networkGenesisIndex = getNetworkGenesisIndexFromEnv();

  // 1) Postgres side (optional debug / scaffolding)
  const pgConnString = getPgConnectionString();
  const pgClient = new PgClient({ connectionString: pgConnString });

  console.log(
    safeStringify(
      {
        source: "plt-ingest-web-sdk",
        step: "pg-connecting",
        connectionStringRedacted: true,
        txHash,
        assetId,
        networkGenesisIndex,
      },
      2
    )
  );

  await pgClient.connect();

  try {
    const registrySnapshot = await debugPltRegistry(pgClient, assetId);

    console.log(
      safeStringify(
        {
          source: "plt-ingest-web-sdk",
          step: "pg-snapshot",
          assetId,
          hasAssetRow: registrySnapshot.hasAssetRow,
          assetRow: registrySnapshot.assetRow,
          existingEventCount: registrySnapshot.eventCount,
        },
        2
      )
    );
  } catch (err) {
    console.error("[plt-ingest-web-sdk] Postgres snapshot failed:", err);
    // Not fatal for the chain probe; we keep going.
  }

  // 2) Web-SDK / Concordium node side
  const cfg = loadWebSdkNodeConfigFromEnv();
  const endpoint = `${cfg.host}:${cfg.port}`;
  const client = createWebSdkNodeClient(cfg);

  console.log(
    safeStringify(
      {
        source: "plt-ingest-web-sdk",
        step: "node-connecting",
        endpoint,
        useTls: cfg.useTls,
        timeoutMs: cfg.timeoutMs,
        client: "@concordium/web-sdk/nodejs",
        txHash,
      },
      2
    )
  );

  try {
    // Quick sanity ping
    const health: any = await (client as any).healthCheck?.();
    const consensus: any = await (client as any).getConsensusStatus?.();

    console.log(
      safeStringify(
        {
          source: "plt-ingest-web-sdk",
          step: "node-health",
          endpoint,
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
        },
        2
      )
    );
  } catch (err) {
    console.error("[plt-ingest-web-sdk] Node health/consensus probe failed:", err);
    // Still attempt tx fetch; the health calls are non-essential.
  }

  try {
    const rawStatus = await fetchTxStatusViaWebSdk(client, txHash);

    // For now we *only* print the raw status payload so we can inspect
    // the EUDemo PLT event shape. Once we've seen a real response, we
    // can factor out a proper "extractPltEventsFromTxStatus" helper.
    console.log(
      safeStringify(
        {
          source: "plt-ingest-web-sdk",
          step: "tx-status-raw",
          txHash,
          assetId,
          networkGenesisIndex,
          rawStatus,
        },
        2
      )
    );

    console.log(
      safeStringify(
        {
          source: "plt-ingest-web-sdk",
          step: "note",
          note:
            "Skeleton ingest via web-sdk complete. Inspect `rawStatus` above to identify PLT events, then wire extraction → crp_plt_events.",
        },
        2
      )
    );
  } catch (err) {
    console.error("[plt-ingest-web-sdk] Failed to fetch tx status:", err);
    process.exitCode = 1;
  } finally {
    await pgClient.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[plt-ingest-web-sdk] crashed:", err);
    process.exitCode = 1;
  });
}
