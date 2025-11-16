// src/routes/demo.webhook.ts
//
// Simple local webhook endpoint to demo what merchants / PayFi
// would implement to receive CRP "payment fulfilled" events.
//
// Usage:
//   1) Start the server with:
//        CRP_WEBHOOK_URL_DEMO_MERCHANT="http://127.0.0.1:8080/demo/webhook/echo" npm run start
//   2) Run scripts/smoke-gateway-contract.sh
//   3) Observe the webhook payload in server logs and the HTTP response.
//
// This is purely for local dev / demo, not production.

import type { FastifyInstance } from "fastify";

export default async function routes(server: FastifyInstance) {
  server.post("/demo/webhook/echo", async (req, _reply) => {
    const body = req.body;

    // Log what we got so you can see the payload structure.
    server.log.info(
      { webhook: { body } },
      "demo webhook received crp.payment.fulfilled payload"
    );

    return {
      ok: true,
      receivedAt: new Date().toISOString(),
      body,
    };
  });
}
