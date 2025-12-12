// src/http/pltEventsRoute.ts
//
// M3.4 – PLT events HTTP read API (data-plane skeleton)
//
// Route:
//   GET /v1/crp/plt/events
//
// Query params (all optional, AND'ed together):
//   from              → filter by from_address
//   to                → filter by to_address
//   assetId           → filter by asset_id
//   networkGenesis    → filter by network_genesis_index (number)
//   finalized         → filter by finalized=true/false
//   minAmount         → filter by amount_raw >= minAmount (string numeric)
//   maxAmount         → filter by amount_raw <= maxAmount (string numeric)
//   limit             → max rows (default 50, hard cap 500)
//
// Response (200):
//   {
//     "ok": true,
//     "events": PltEvent[],
//     "count": number
//   }
//
// Notes:
//   - Uses searchPltEventsWithNewClient(), so it does NOT depend
//     on any existing pg Pool decorations on Fastify.
//   - Safe to call even when crp_plt_events is empty.

import {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  PltEventSearchFilter,
  searchPltEventsWithNewClient,
} from "../plt/pltSearch";

interface PltEventsQueryString {
  from?: string;
  to?: string;
  assetId?: string;
  networkGenesis?: string;
  finalized?: string;
  minAmount?: string;
  maxAmount?: string;
  limit?: string;
}

const pltEventsRoute: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    "/v1/crp/plt/events",
    async (
      request: FastifyRequest<{ Querystring: PltEventsQueryString }>,
      reply: FastifyReply
    ) => {
      const q = request.query ?? {};

      const filter: PltEventSearchFilter = {};

      if (q.from) {
        filter.fromAddress = q.from;
      }

      if (q.to) {
        filter.toAddress = q.to;
      }

      if (q.assetId) {
        filter.assetId = q.assetId;
      }

      if (q.networkGenesis) {
        const n = Number(q.networkGenesis);
        if (Number.isFinite(n)) {
          filter.networkGenesisIndex = n;
        }
      }

      if (typeof q.finalized === "string") {
        const v = q.finalized.toLowerCase();
        if (v === "true" || v === "1") {
          filter.finalized = true;
        } else if (v === "false" || v === "0") {
          filter.finalized = false;
        }
      }

      if (q.minAmount) {
        filter.minAmountRaw = q.minAmount;
      }

      if (q.maxAmount) {
        filter.maxAmountRaw = q.maxAmount;
      }

      if (q.limit) {
        const n = Number(q.limit);
        if (Number.isFinite(n) && n > 0) {
          filter.limit = n;
        }
      }

      try {
        const events = await searchPltEventsWithNewClient(filter);

        return reply.send({
          ok: true,
          events,
          count: events.length,
        });
      } catch (err) {
        request.log.error({ err }, "failed to search PLT events");

        return reply.status(500).send({
          ok: false,
          error: "plt_events_query_failed",
        });
      }
    }
  );

  done();
};

export default pltEventsRoute;
