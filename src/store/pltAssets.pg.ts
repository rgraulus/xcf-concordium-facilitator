// src/store/pltAssets.pg.ts
//
// Helpers for the PLT asset/decimals registry (crp_plt_assets).
// Used to normalize/validate decimals for "exact tuple match" endpoints
// without forcing clients to remember decimals.

import { pool } from "../db/pool";
import { networkCandidates } from "../lib/networkId";

export type PltAssetRow = {
  network: string;
  network_genesis_index: number;
  asset_id: string;
  symbol: string;
  decimals: number;
  enabled: boolean;
};

/**
 * Default genesis index used when callers do not provide one.
 * Keep consistent with other modules (and your testnet default).
 */
export function getDefaultNetworkGenesisIndex(): number {
  const raw = process.env.CRP_DEFAULT_NETWORK_GENESIS_INDEX;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : 6;
}

/**
 * Fetch a PLT asset registry row by composite key.
 */
export async function getPltAsset(
  network: string,
  networkGenesisIndex: number,
  assetId: string
): Promise<PltAssetRow | null> {
  const netCands = networkCandidates(network);

  const res = await pool.query(
    `
    SELECT
      network,
      network_genesis_index,
      asset_id,
      symbol,
      decimals,
      enabled
    FROM public.crp_plt_assets
    WHERE network = ANY($1)
      AND network_genesis_index = $2
      AND asset_id = $3
    ORDER BY
      CASE WHEN network = $4 THEN 0 ELSE 1 END,
      network_genesis_index DESC
    LIMIT 1
    `,
    [netCands, networkGenesisIndex, assetId, network]
  );

  if (!res.rows || res.rows.length === 0) return null;

  const r = res.rows[0];
  return {
    network: String(r.network),
    network_genesis_index: Number(r.network_genesis_index),
    asset_id: String(r.asset_id),
    symbol: String(r.symbol),
    decimals: Number(r.decimals),
    enabled: Boolean(r.enabled),
  };
}
