// src/http/metrics.ts
//
// Very small JSON metrics endpoint.
//
// This is not Prometheus; it just exposes the in-memory metrics registry
// so operators / developers can quickly see basic counters.
//
// GET /metrics -> 200 OK
// {
//   "readyz": {
//     "totalChecks": 12,
//     "success": 9,
//     "dbFailures": 0,
//     "walletProxyFailures": 3
//   }
// }

import type { FastifyPluginCallback } from "fastify";
import { getMetricsSnapshot } from "../metrics/registry";

const metricsPlugin: FastifyPluginCallback = async (server) => {
  server.get("/metrics", async () => {
    return getMetricsSnapshot();
  });
};

export default metricsPlugin;
