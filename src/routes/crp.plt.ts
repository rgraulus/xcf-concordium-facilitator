import { FastifyPluginAsync } from "fastify";
import { Pool } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.CRP_DB_CONN_STRING ??
  "postgres://postgres:pg@127.0.0.1:5432/transaction-outcome";

const pool = new Pool({ connectionString: DATABASE_URL });

export interface PltTransfer {
  block_hash: string;
  block_height: number;
  network: string;

  token_id: string; // maps to asset_id
  from_addr: string | null;
  to_addr: string | null;

  amount_minor: string; // maps to amount_raw::text (atomic units)
  decimals: number;

  occurred_at: string; // ISO 8601
  tx_hash: string; // maps to transaction_hash
  event_index: number;
}

interface CrpPltSearchQuery {
  network?: string;
  tokenId?: string; // asset_id
  txHash?: string;  // transaction_hash
  fromAddr?: string;
  toAddr?: string;
  minHeight?: string;
  maxHeight?: string;
  limit?: string;
}

interface CrpPltSearchRoute {
  Querystring: CrpPltSearchQuery;
}

const crpPltRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<CrpPltSearchRoute>(
    "/v1/crp/plt/search",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            network: { type: "string" },
            tokenId: { type: "string" },
            txHash: { type: "string" },
            fromAddr: { type: "string" },
            toAddr: { type: "string" },
            minHeight: { type: "string" },
            maxHeight: { type: "string" },
            limit: { type: "string" },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              events: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    block_hash: { type: "string" },
                    block_height: { type: "number" },
                    network: { type: "string" },
                    token_id: { type: "string" },
                    from_addr: { type: ["string", "null"] },
                    to_addr: { type: ["string", "null"] },
                    amount_minor: { type: "string" },
                    decimals: { type: "number" },
                    occurred_at: { type: "string" },
                    tx_hash: { type: "string" },
                    event_index: { type: "number" },
                  },
                  required: [
                    "block_hash",
                    "block_height",
                    "network",
                    "token_id",
                    "amount_minor",
                    "decimals",
                    "occurred_at",
                    "tx_hash",
                    "event_index",
                  ],
                },
              },
            },
            required: ["ok", "events"],
          },
        },
      },
    },
    async (request) => {
      const q = request.query;

      const params: any[] = [];
      const where: string[] = [];

      if (q.network) {
        params.push(q.network);
        where.push(`e.network = $${params.length}`);
      }

      if (q.tokenId) {
        params.push(q.tokenId);
        where.push(`e.asset_id = $${params.length}`);
      }

      if (q.txHash) {
        params.push(q.txHash);
        where.push(`e.transaction_hash = $${params.length}`);
      }

      if (q.fromAddr) {
        params.push(q.fromAddr);
        where.push(`e.from_address = $${params.length}`);
      }

      if (q.toAddr) {
        params.push(q.toAddr);
        where.push(`e.to_address = $${params.length}`);
      }

      const minHeight =
        q.minHeight && q.minHeight.trim() !== "" ? Number(q.minHeight) : undefined;
      const maxHeight =
        q.maxHeight && q.maxHeight.trim() !== "" ? Number(q.maxHeight) : undefined;

      if (!Number.isNaN(minHeight) && minHeight !== undefined) {
        params.push(minHeight);
        where.push(`e.block_height >= $${params.length}`);
      }

      if (!Number.isNaN(maxHeight) && maxHeight !== undefined) {
        params.push(maxHeight);
        where.push(`e.block_height <= $${params.length}`);
      }

      const rawLimit =
        q.limit && q.limit.trim() !== "" ? Number(q.limit) : undefined;
      const limit = !rawLimit || Number.isNaN(rawLimit) ? 50 : rawLimit;
      const cappedLimit = Math.min(limit, 500);

      params.push(cappedLimit);

      const sql = `
        SELECT
          e.block_hash,
          e.block_height,
          e.network,
          e.asset_id AS token_id,
          e.from_address AS from_addr,
          e.to_address AS to_addr,
          e.amount_raw::text AS amount_minor,
          a.decimals AS decimals,
          e.occurred_at,
          e.transaction_hash AS tx_hash,
          e.event_index
        FROM crp_plt_events e
        JOIN crp_plt_assets a
          ON a.asset_id = e.asset_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY e.block_height DESC, e.event_index ASC
        LIMIT $${params.length}
      `;

      const { rows } = await pool.query(sql, params);

      const events: PltTransfer[] = rows.map((r) => {
        const occurred =
          r.occurred_at instanceof Date
            ? r.occurred_at.toISOString()
            : String(r.occurred_at);

        return {
          block_hash: r.block_hash,
          block_height: Number(r.block_height),
          network: r.network,
          token_id: r.token_id,
          from_addr: r.from_addr,
          to_addr: r.to_addr,
          amount_minor: String(r.amount_minor),
          decimals: Number(r.decimals),
          occurred_at: occurred,
          tx_hash: r.tx_hash,
          event_index: Number(r.event_index),
        };
      });

      return { ok: true, events };
    }
  );
};

export default crpPltRoute;
