import fs from "node:fs";
import path from "node:path";
import { ExtractedPltEvent, PltSource, PltSourceResult, PltSourceSummary } from "./pltSource.types";

type FixtureRow = {
  cursor?: number; // optional explicit monotonic cursor; if absent we derive from blockHeight/eventIndex
  network?: string;
  networkGenesisIndex?: number;

  blockHash: string;
  blockHeight: number;

  transactionHash: string;
  eventIndex: number;

  eventType?: string;
  fromAddress?: string | null;
  toAddress?: string | null;

  amountRaw: string;
  assetId: string;

  occurredAt?: string; // ISO
  finalized?: boolean;
};

function num(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

function str(v: unknown, def = ""): string {
  return typeof v === "string" ? v : def;
}

function toDate(v: unknown): Date {
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function deriveCursor(row: FixtureRow): number {
  if (typeof row.cursor === "number" && Number.isFinite(row.cursor)) return row.cursor;
  // deterministic cursor from blockHeight + eventIndex
  return (Number(row.blockHeight) || 0) * 1_000_000 + (Number(row.eventIndex) || 0);
}

export class FixturePltSource implements PltSource {
  private cached: Array<{ cursor: number; ev: ExtractedPltEvent }> | null = null;

  constructor(
    private readonly opts: {
      fixturePath: string;
      network: string;
      networkGenesisIndex: number;
      defaultAssetId: string;
      limit: number;
    }
  ) {}

  private load(): Array<{ cursor: number; ev: ExtractedPltEvent }> {
    if (this.cached) return this.cached;

    const p = path.resolve(this.opts.fixturePath);
    if (!fs.existsSync(p)) {
      throw new Error(`[fixture] file not found: ${p}`);
    }

    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error(`[fixture] expected JSON array at root in ${p}`);
    }

    const items: Array<{ cursor: number; ev: ExtractedPltEvent }> = [];

    for (const rowAny of parsed) {
      const row = rowAny as FixtureRow;

      if (!row || typeof row !== "object") continue;
      if (!row.blockHash || row.blockHeight === undefined || !row.transactionHash || row.eventIndex === undefined) continue;
      if (!row.amountRaw || !row.assetId) continue;

      const cursor = deriveCursor(row);

      const ev: ExtractedPltEvent = {
        network: row.network ?? this.opts.network,
        networkGenesisIndex: row.networkGenesisIndex ?? this.opts.networkGenesisIndex,

        blockHash: str(row.blockHash),
        blockHeight: Number(row.blockHeight) || 0,

        transactionHash: str(row.transactionHash),
        eventIndex: Number(row.eventIndex) || 0,

        eventType: row.eventType ?? "transfer",
        fromAddress: row.fromAddress ?? null,
        toAddress: row.toAddress ?? null,

        amountRaw: str(row.amountRaw),
        assetId: row.assetId ?? this.opts.defaultAssetId,

        occurredAt: toDate(row.occurredAt),
        finalized: row.finalized ?? true,
      };

      items.push({ cursor, ev });
    }

    items.sort((a, b) => a.cursor - b.cursor);
    this.cached = items;
    return items;
  }

  async fetchSince(lastHeightExclusive: number): Promise<PltSourceResult> {
    const all = this.load();

    const slice = all.filter((x) => x.cursor > lastHeightExclusive).slice(0, this.opts.limit);

    const events = slice.map((x) => x.ev);
    const bestHeight =
      slice.length > 0 ? Math.max(...slice.map((x) => x.cursor)) : lastHeightExclusive;

    const sampleEvents = events.slice(0, 3).map((ev) => ({
      transactionHash: ev.transactionHash,
      blockHeight: ev.blockHeight,
      assetId: ev.assetId,
      amountRaw: ev.amountRaw,
      fromAddress: ev.fromAddress,
      toAddress: ev.toAddress,
    }));

    const summary: PltSourceSummary = {
      source: "fixture",
      network: this.opts.network,
      cursorFrom: lastHeightExclusive,
      cursorBest: bestHeight,
      totalItems: all.length,
      matchedEvents: events.length,
      sampleEvents,
    };

    console.log("[CRP-STREAM][fixture] scan", summary);

    return { events, bestHeight, summary };
  }
}

export function createFixtureSourceFromEnv(): FixturePltSource {
  const network = process.env.CRP_STREAM_NETWORK ?? "concordium:testnet";
  const networkGenesisIndex = Number(process.env.CRP_STREAM_NETWORK_GENESIS_INDEX ?? "7") || 7;

  const fixturePath =
    process.env.CRP_STREAM_FIXTURE_PATH ?? "docs/fixtures/plt-events.sample.json";

  const defaultAssetId =
    process.env.CONCORDIUM_PLT_TOKEN_ID ??
    process.env.CRP_STREAM_TOKEN_ID ??
    "EUDemo";

  const limit = Number(process.env.CRP_STREAM_FIXTURE_LIMIT ?? "500") || 500;

  return new FixturePltSource({
    fixturePath,
    network,
    networkGenesisIndex,
    defaultAssetId,
    limit,
  });
}
