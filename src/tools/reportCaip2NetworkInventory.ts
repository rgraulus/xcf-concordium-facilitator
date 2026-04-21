import { pool } from "../db/pool";
import { normalizeNetworkId } from "../lib/networkId";

type Mode = "report" | "dry-run";

type Summary = {
  table: string;
  totalRows: number;
  legacyRows: number;
  canonicalRows: number;
  proposedRewrites: number;
  collisionCandidates: number;
  dependencyGapCandidates: number;
  skippedRows: number;
  noOpRows: number;
};

type Rewrite = {
  table: string;
  sourceKey: string;
  sourceNetwork: string;
  targetNetwork: string;
  reason: string;
};

type Collision = {
  table: string;
  targetKey: string;
  sourceKeys: string[];
  reason: string;
};

type DependencyGap = {
  table: string;
  sourceKey: string;
  targetAssetKey: string;
  reason: string;
};

type TableResult = {
  summary: Summary;
  rewrites: Rewrite[];
  collisions: Collision[];
  dependencyGaps: DependencyGap[];
};

function parseMode(argv: string[]): Mode {
  const arg = argv.find((a) => a.startsWith("--mode="));
  const raw = arg ? arg.slice("--mode=".length) : "report";
  if (raw === "report" || raw === "dry-run") return raw;
  throw new Error(`Unsupported mode: ${raw}. Use --mode=report or --mode=dry-run`);
}

function rowKey(parts: Array<string | number | null | undefined>): string {
  return parts.map((p) => String(p ?? "")).join("|");
}

function sortByKey<T extends { sourceKey?: string; targetKey?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    String(a.sourceKey ?? a.targetKey ?? "").localeCompare(String(b.sourceKey ?? b.targetKey ?? ""))
  );
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));

  const challengesRes = await pool.query(
    `
    SELECT merchant_id, nonce, network
    FROM public.challenges
    ORDER BY merchant_id, nonce
    `
  );

  const assetsRes = await pool.query(
    `
    SELECT network, network_genesis_index, asset_id, symbol, decimals, enabled
    FROM public.crp_plt_assets
    ORDER BY network, network_genesis_index, asset_id
    `
  );

  const eventsRes = await pool.query(
    `
    SELECT id, network, network_genesis_index, asset_id, transaction_hash, event_index
    FROM public.crp_plt_events
    ORDER BY id
    `
  );

  const claimsRes = await pool.query(
    `
    SELECT network, network_genesis_index, tx_hash, event_index, merchant_id, nonce
    FROM public.crp_plt_event_claims
    ORDER BY network, network_genesis_index, tx_hash, event_index
    `
  );

  const assetRows = assetsRes.rows.map((r) => ({
    network: String(r.network),
    network_genesis_index: Number(r.network_genesis_index),
    asset_id: String(r.asset_id),
    symbol: String(r.symbol),
    decimals: Number(r.decimals),
    enabled: Boolean(r.enabled),
  }));

  const assetCanonicalUniverse = new Set<string>(
    assetRows.map((r) =>
      rowKey([normalizeNetworkId(r.network), r.network_genesis_index, r.asset_id])
    )
  );

  function summarizeBase(table: string, totalRows: number, legacyRows: number): Summary {
    return {
      table,
      totalRows,
      legacyRows,
      canonicalRows: totalRows - legacyRows,
      proposedRewrites: legacyRows,
      collisionCandidates: 0,
      dependencyGapCandidates: 0,
      skippedRows: 0,
      noOpRows: totalRows - legacyRows,
    };
  }

  const results: TableResult[] = [];

  // challenges
  {
    const rewrites: Rewrite[] = [];
    let legacyRows = 0;

    for (const r of challengesRes.rows) {
      const network = String(r.network);
      const targetNetwork = normalizeNetworkId(network);
      if (targetNetwork !== network) {
        legacyRows += 1;
        rewrites.push({
          table: "challenges",
          sourceKey: rowKey([r.merchant_id, r.nonce]),
          sourceNetwork: network,
          targetNetwork,
          reason: "legacy_network_to_canonical",
        });
      }
    }

    results.push({
      summary: summarizeBase("challenges", challengesRes.rows.length, legacyRows),
      rewrites: sortByKey(rewrites),
      collisions: [],
      dependencyGaps: [],
    });
  }

  // crp_plt_assets
  {
    const rewrites: Rewrite[] = [];
    const collisions: Collision[] = [];
    let legacyRows = 0;

    const targetMap = new Map<string, string[]>();

    for (const r of assetRows) {
      const targetNetwork = normalizeNetworkId(r.network);
      const sourceKey = rowKey([r.network, r.network_genesis_index, r.asset_id]);
      const targetKey = rowKey([targetNetwork, r.network_genesis_index, r.asset_id]);

      if (!targetMap.has(targetKey)) targetMap.set(targetKey, []);
      targetMap.get(targetKey)!.push(sourceKey);

      if (targetNetwork !== r.network) {
        legacyRows += 1;
        rewrites.push({
          table: "crp_plt_assets",
          sourceKey,
          sourceNetwork: r.network,
          targetNetwork,
          reason: "legacy_network_to_canonical",
        });
      }
    }

    for (const [targetKey, sourceKeys] of targetMap.entries()) {
      const uniq = [...new Set(sourceKeys)].sort();
      if (uniq.length > 1) {
        collisions.push({
          table: "crp_plt_assets",
          targetKey,
          sourceKeys: uniq,
          reason: "multiple_rows_converge_on_same_canonical_asset_key",
        });
      }
    }

    const summary = summarizeBase("crp_plt_assets", assetRows.length, legacyRows);
    summary.collisionCandidates = collisions.length;
    summary.skippedRows = collisions.reduce((n, c) => n + c.sourceKeys.length, 0);

    results.push({
      summary,
      rewrites: sortByKey(rewrites),
      collisions: sortByKey(collisions),
      dependencyGaps: [],
    });
  }

  // crp_plt_events
  {
    const rewrites: Rewrite[] = [];
    const dependencyGaps: DependencyGap[] = [];
    let legacyRows = 0;

    for (const r of eventsRes.rows) {
      const network = String(r.network);
      const networkGenesisIndex = Number(r.network_genesis_index);
      const assetId = String(r.asset_id);
      const targetNetwork = normalizeNetworkId(network);
      const sourceKey = rowKey([r.id, r.transaction_hash, r.event_index]);

      if (targetNetwork !== network) {
        legacyRows += 1;
        rewrites.push({
          table: "crp_plt_events",
          sourceKey,
          sourceNetwork: network,
          targetNetwork,
          reason: "legacy_network_to_canonical",
        });

        const targetAssetKey = rowKey([targetNetwork, networkGenesisIndex, assetId]);
        if (!assetCanonicalUniverse.has(targetAssetKey)) {
          dependencyGaps.push({
            table: "crp_plt_events",
            sourceKey,
            targetAssetKey,
            reason: "canonical_target_asset_row_missing_for_event_fk",
          });
        }
      }
    }

    const summary = summarizeBase("crp_plt_events", eventsRes.rows.length, legacyRows);
    summary.dependencyGapCandidates = dependencyGaps.length;
    summary.skippedRows = dependencyGaps.length;

    results.push({
      summary,
      rewrites: sortByKey(rewrites),
      collisions: [],
      dependencyGaps: sortByKey(dependencyGaps),
    });
  }

  // crp_plt_event_claims
  {
    const rewrites: Rewrite[] = [];
    const collisions: Collision[] = [];
    let legacyRows = 0;

    const targetMap = new Map<string, string[]>();

    for (const r of claimsRes.rows) {
      const network = String(r.network);
      const targetNetwork = normalizeNetworkId(network);
      const sourceKey = rowKey([network, r.network_genesis_index, r.tx_hash, r.event_index]);
      const targetKey = rowKey([targetNetwork, r.network_genesis_index, r.tx_hash, r.event_index]);

      if (!targetMap.has(targetKey)) targetMap.set(targetKey, []);
      targetMap.get(targetKey)!.push(sourceKey);

      if (targetNetwork !== network) {
        legacyRows += 1;
        rewrites.push({
          table: "crp_plt_event_claims",
          sourceKey,
          sourceNetwork: network,
          targetNetwork,
          reason: "legacy_network_to_canonical",
        });
      }
    }

    for (const [targetKey, sourceKeys] of targetMap.entries()) {
      const uniq = [...new Set(sourceKeys)].sort();
      if (uniq.length > 1) {
        collisions.push({
          table: "crp_plt_event_claims",
          targetKey,
          sourceKeys: uniq,
          reason: "multiple_rows_converge_on_same_canonical_claim_key",
        });
      }
    }

    const summary = summarizeBase("crp_plt_event_claims", claimsRes.rows.length, legacyRows);
    summary.collisionCandidates = collisions.length;
    summary.skippedRows = collisions.reduce((n, c) => n + c.sourceKeys.length, 0);

    results.push({
      summary,
      rewrites: sortByKey(rewrites),
      collisions: sortByKey(collisions),
      dependencyGaps: [],
    });
  }

  const output =
    mode === "report"
      ? {
          ok: true,
          mode,
          generatedAt: new Date().toISOString(),
          tables: results.map((r) => r.summary),
        }
      : {
          ok: true,
          mode,
          generatedAt: new Date().toISOString(),
          tables: results.map((r) => ({
            summary: r.summary,
            rewrites: r.rewrites,
            collisions: r.collisions,
            dependencyGaps: r.dependencyGaps,
          })),
        };

  console.log(JSON.stringify(output, null, 2));
  await pool.end();
}

main().catch(async (err) => {
  console.error("[reportCaip2NetworkInventory] fatal:", err);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
