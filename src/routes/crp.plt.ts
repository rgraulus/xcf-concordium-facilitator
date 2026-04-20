// src/routes/crp.plt.ts
//
// Fastify plugin for:
//   GET /v1/crp/plt/search
//
// Queries persisted PLT transfers in Postgres (crp_plt_events).
// Joins against crp_plt_assets to return decimals (and registry gating).

import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool";
import { normalizeNetworkId, networkCandidates } from "../lib/networkId";

export interface PltTransfer {
  block_hash: string;
  block_height: number;

  network: string;
  network_genesis_index: number;

  token_id: string; // tokenId (asset_id)

  from_addr: string | null;
  to_addr: string | null;

  amount_minor: string; // integer minor units
  decimals: number;

  tx_hash: string;
  event_index: number;

  occurred_at: string; // ISO
}

function rowToPltTransfer(r: any): PltTransfer {
  return {
    block_hash: String(r.block_hash),
    block_height: Number(r.block_height),

    network: String(r.network),
    network_genesis_index: Number(r.network_genesis_index),

    token_id: String(r.token_id),

    from_addr: r.from_addr ? String(r.from_addr) : null,
    to_addr: r.to_addr ? String(r.to_addr) : null,

    amount_minor: String(r.amount_minor),
    decimals: Number(r.decimals),

    tx_hash: String(r.tx_hash),
    event_index: Number(r.event_index),

    occurred_at: new Date(r.occurred_at).toISOString(),
  };
}

function parseBoolLoose(v: any): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "y") return true;
  if (s === "0" || s === "false" || s === "no" || s === "n") return false;
  return undefined;
}

export async function registerCrpPltRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/crp/plt/search", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          network: { type: "string" },
          networkGenesisIndex: { type: "number" },
          tokenId: { type: "string" },
          to: { type: "string" },
          amountMinor: { type: "string" },
          includeDisabled: { type: "boolean" },
          limit: { type: "number" },
        },
      },
    },
    handler: async (req, reply) => {
      const q = (req.query ?? {}) as any;

      const rawNetwork = q.network ? String(q.network) : undefined;
      const network = rawNetwork ? normalizeNetworkId(rawNetwork) : undefined;
      const netCands = network ? networkCandidates(network) : [];
      const networkGenesisIndex =
        typeof q.networkGenesisIndex === "number" && Number.isFinite(q.networkGenesisIndex)
          ? Math.floor(q.networkGenesisIndex)
          : undefined;

      const tokenId = q.tokenId ? String(q.tokenId) : undefined;
      const to = q.to ? String(q.to) : undefined;
      const amountMinor = q.amountMinor ? String(q.amountMinor) : undefined;

      const includeDisabled =
        typeof q.includeDisabled === "boolean"
          ? q.includeDisabled
          : parseBoolLoose(q.includeDisabled) ?? false;

      const limit =
        typeof q.limit === "number" && Number.isFinite(q.limit)
          ? Math.max(1, Math.min(100, Math.floor(q.limit)))
          : 50;

      const params: any[] = [];
      let where = "WHERE 1=1";

      if (netCands.length === 1) {
        params.push(netCands[0]);
        where += ` AND e.network = $${params.length}`;
      } else if (netCands.length > 1) {
        params.push(netCands);
        where += ` AND e.network = ANY($${params.length})`;
      }

      if (typeof networkGenesisIndex === "number") {
        params.push(networkGenesisIndex);
        where += ` AND e.network_genesis_index = $${params.length}`;
      }

      if (tokenId) {
        params.push(tokenId);
        where += ` AND e.asset_id = $${params.length}`;
      }

      if (to) {
        params.push(to);
        where += ` AND e.to_address = $${params.length}`;
      }

      if (amountMinor) {
        params.push(amountMinor);
        where += ` AND e.amount_raw::text = $${params.length}`;
      }

      // Default: only enabled assets unless explicitly overridden.
      if (!includeDisabled) {
        where += ` AND a.enabled = true`;
      }

      params.push(limit);
      const limitIdx = params.length;

      const sql = `
        SELECT
          e.block_hash,
          e.block_height,
          e.network,
          e.network_genesis_index,

          e.asset_id AS token_id,
          e.from_address AS from_addr,
          e.to_address AS to_addr,
          e.amount_raw::text AS amount_minor,
          a.decimals AS decimals,

          e.transaction_hash AS tx_hash,
          e.event_index AS event_index,

          e.occurred_at
        FROM public.crp_plt_events e
        JOIN public.crp_plt_assets a
          ON a.asset_id = e.asset_id
         AND a.network = e.network
         AND a.network_genesis_index = e.network_genesis_index
        ${where}
        ORDER BY e.occurred_at DESC
        LIMIT $${limitIdx}
      `;

      const res = await pool.query(sql, params);
      const events = res.rows.map(rowToPltTransfer);

      // Keep backward compatibility: return "events".
      // (Optionally also expose "transfers" as an alias.)
      return reply.send({
        ok: true,
        events,
        transfers: events,
      });
    },
  });
}

// Default export as a Fastify plugin (what src/server.ts expects).
export default async function crpPltPlugin(app: FastifyInstance): Promise<void> {
  await registerCrpPltRoutes(app);
}
