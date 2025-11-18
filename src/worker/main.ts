import { CrpStreamWorker, CrpStreamWorkerConfig } from "./crpStreamWorker";

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined ? fallback : v;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const normalized = v.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
  const config: CrpStreamWorkerConfig = {
    pollIntervalMs: envInt("CRP_STREAM_POLL_MS", 2000),
    network: env("CRP_STREAM_NETWORK", "concordium:testnet"),
    tokenId: env("CRP_STREAM_TOKEN_ID", "usd:test"),
    dryRun: envBool("CRP_STREAM_DRY_RUN", true),
  };

  const maxTicks = envInt("CRP_STREAM_MAX_TICKS", 3);

  console.log("[CRP-STREAM] demo runner starting with config:", {
    ...config,
    maxTicks,
  });

  const worker = new CrpStreamWorker(config /* startHeight */);

  await worker.start(maxTicks);

  console.log("[CRP-STREAM] demo runner finished.");
}

main().catch((err) => {
  console.error("[CRP-STREAM] fatal error in demo runner:", err);
  process.exit(1);
});
