// src/tools/seedPltAssets.ts
//
// M3.4 – Seed PLT asset registry (crp_plt_assets)
//
// This is safe to run multiple times (upsert).
//
// Default seed inserts EUDemo on concordium:testnet with decimals=6.

import { Client } from "pg";

function getConnectionString(): string {
  const conn =
    process.env.CRP_DB_CONN_STRING ??
    process.env.DATABASE_URL ??
    // Fallback for local xcf-pg (shared with transaction-logger)
    "postgres://postgres:pg@127.0.0.1:5432/transaction-outcome";
  return conn;
}
function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return defaultValue;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) ? v : defaultValue;
}

function log(msg: any): void {
  // eslint-disable-next-line no-console
  console.log("[PLT-SEED]", msg);
}

export async function seedPltAssets(): Promise<void> {
  // Default seed: EUDemo PLT asset on Concordium testnet.
  // Decimals: 6.
  // M4.2 schema: asset_id is the plain tokenId (e.g. "EUDemo"), scoped by (network, network_genesis_index).
  const network = process.env.CRP_SEED_NETWORK ?? "concordium:testnet";
  const networkGenesisIndex = parseIntEnv(
    "CRP_SEED_NETWORK_GENESIS_INDEX",
    parseIntEnv("CONCORDIUM_NETWORK_GENESIS_INDEX", 7)
  );
  const assetId = process.env.CRP_SEED_ASSET_ID ?? "EUDemo";

  const symbol = "EUDemo";
  const decimals = 6;
  const description = "Concordium PLT demo token on testnet";
  const enabled = true;

  const client = new Client({ connectionString: getConnectionString() });

  try {
    await client.connect();

  // Ensure registry table exists (safe no-op if already created).
  await client.query(`
    CREATE TABLE IF NOT EXISTS crp_plt_assets (
      network               TEXT    NOT NULL,
      network_genesis_index INTEGER NOT NULL,
      asset_id              TEXT    NOT NULL,
      symbol                TEXT    NOT NULL,
      decimals              INTEGER NOT NULL,
      description           TEXT,
      enabled               BOOLEAN NOT NULL DEFAULT TRUE,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (network, network_genesis_index, asset_id)
    );
  `);

    log(JSON.stringify({ step: "begin", assetId, symbol, decimals }));

    const upsertSql = `
      INSERT INTO crp_plt_assets (
        network,
        network_genesis_index,
        asset_id,
        symbol,
        decimals,
        description,
        enabled,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
      ON CONFLICT (network, network_genesis_index, asset_id) DO UPDATE
      SET
        symbol = EXCLUDED.symbol,
        decimals = EXCLUDED.decimals,
        description = EXCLUDED.description,
        enabled = EXCLUDED.enabled,
        updated_at = now();
    `;

    const params = [network, networkGenesisIndex, assetId, symbol, decimals, description, enabled];
    await client.query(upsertSql, params);

    log(JSON.stringify({ step: "done", assetId }));
  } finally {
    await client.end();
  }
}

// Run directly: ts-node src/tools/seedPltAssets.ts
if (require.main === module) {
  seedPltAssets()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("[PLT-SEED] done");
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[PLT-SEED] failed:", err);
      process.exitCode = 1;
    });
}
