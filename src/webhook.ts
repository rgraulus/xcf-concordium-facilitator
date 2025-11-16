// src/webhook.ts
//
// Webhook helper for CRP payment fulfillment.
//
// - Per-merchant webhook URL from environment variables.
// - No extra dependencies: uses Node's http/https + URL.
// - Returns a structured result so routes can bubble status back
//   to the client.
//
// Env var naming convention:
//
//   merchantId: "demo-merchant"  ->  CRP_WEBHOOK_URL_DEMO_MERCHANT
//
// i.e.:
//
//   CRP_WEBHOOK_URL_<MERCHANT_ID_NORMALIZED>
//
// where MERCHANT_ID_NORMALIZED is:
//   - uppercased
//   - any sequence of non [A-Z0-9] replaced by "_"
//   - leading/trailing "_" trimmed
//
// Examples:
//   "demo-merchant"      -> CRP_WEBHOOK_URL_DEMO_MERCHANT
//   "acme.inc"           -> CRP_WEBHOOK_URL_ACME_INC
//   "my-merchant-123"    -> CRP_WEBHOOK_URL_MY_MERCHANT_123
//

import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { URL } from "url";
import type {
  CrpWebhookPayload,
  CrpWebhookResult,
} from "./contracts/crpGateway";

// Backwards-compatible alias so existing imports of WebhookResult still work.
export type WebhookResult = CrpWebhookResult;

/**
 * Normalize merchantId into the env var suffix.
 */
function merchantIdToEnvKey(merchantId: string): string {
  const suffix = merchantId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `CRP_WEBHOOK_URL_${suffix}`;
}

/**
 * Resolve webhook URL for a merchant from process.env.
 */
export function getWebhookUrlForMerchant(
  merchantId: string
): { url: string; envKey: string } | null {
  const envKey = merchantIdToEnvKey(merchantId);
  const url = process.env[envKey];
  if (!url || url.trim() === "") {
    return null;
  }
  return { url: url.trim(), envKey };
}

/**
 * POST a CRP webhook payload to the merchant webhook URL, if configured.
 *
 * Returns a CrpWebhookResult that callers can embed in their response.
 */
export async function postPaymentWebhook(
  merchantId: string,
  payload: CrpWebhookPayload,
  timeoutMs = 3000
): Promise<CrpWebhookResult> {
  const cfg = getWebhookUrlForMerchant(merchantId);
  if (!cfg) {
    // No webhook configured for this merchant.
    return {
      configured: false,
      attempted: false,
      ok: false,
    };
  }

  const { url } = cfg;

  try {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;

    return await new Promise<CrpWebhookResult>((resolve) => {
      const req = reqFn(
        {
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: target.pathname + target.search,
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          timeout: timeoutMs,
        },
        (res) => {
          // We don't currently need the body, just status.
          res.on("data", () => {});
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            const ok = status >= 200 && status < 300;
            resolve({
              configured: true,
              attempted: true,
              ok,
              status,
            });
          });
        }
      );

      req.on("error", (err) => {
        resolve({
          configured: true,
          attempted: true,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({
          configured: true,
          attempted: true,
          ok: false,
          error: "timeout",
        });
      });

      try {
        const json = JSON.stringify(payload ?? {});
        req.write(json);
      } catch (err) {
        // JSON serialization error – treat as failure.
        req.destroy();
        resolve({
          configured: true,
          attempted: true,
          ok: false,
          error:
            err instanceof Error ? err.message : "failed to serialize payload",
        });
        return;
      }

      req.end();
    });
  } catch (err) {
    return {
      configured: true,
      attempted: true,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
