// src/tools/ingestPltFromSummaries.ts
//
// M3.3 / M3.4 – PLT ingest skeleton (from transaction-outcome.summaries)
//
// This tool is intentionally read-only for now. It:
//   - Connects to the same Postgres DB as PLT schema + tx summaries
//   - Loads a recent batch of rows from the `summaries` table
//   - Computes counts of summary "tags" (e.g. BlockAccrueReward, etc.)
//   - Prints a compact JSON snapshot
//   - Prints a small sample of rows for interesting tags (especially "unknown")
//   - Calls the PLT extraction skeleton to preview how many PLT events
//     would be extracted (currently always 0 until we implement it)
//
// Later M3.4 steps will add:
//   - Actual extraction of PLT transfer events from the summary JSON
//   - Writes into crp_plt_events (idempotent upsert)
//   - Wiring into the PLT worker
//
// Usage:
//   npm run plt:ingest:summaries
//
// Environment (optional):
//   XCF_PLT_INGEST_LIMIT          – how many recent summaries to inspect (default: 1000)
//   XCF_PLT_INGEST_SAMPLE_PER_TAG – how many sample rows per tag to show (default: 5)
//   CRP_DB_CONN_STRING            – full Postgres URL
//   DATABASE_URL                  – fallback Postgres URL
//
// Default DB (if no env vars):
//   postgres://postgres:pg@127.0.0.1:5432/transaction-outcome

import { Client } from "pg";
import {
  PltEvent,
  PltExtractionOptions,
  RawTxSummaryRow,
  extractPltEventsFromSummaryRow,
} from "../plt/pltEvents";

type TxSummaryRow = RawTxSummaryRow;

function getConnectionString(): string {
  const conn =
    process.env.CRP_DB_CONN_STRING ??
    process.env.DATABASE_URL ??
    "postgres://postgres:pg@127.0.0.1:5432/transaction-outcome";
  return conn;
}

function getBatchLimit(): number {
  const raw = process.env.XCF_PLT_INGEST_LIMIT;
  const n = raw ? Number(raw) : 1000;
  if (!Number.isFinite(n) || n <= 0) {
    return 1000;
  }
  return Math.min(n, 10000); // hard cap to be nice to Postgres
}

function getSamplePerTag(): number {
  const raw = process.env.XCF_PLT_INGEST_SAMPLE_PER_TAG;
  const n = raw ? Number(raw) : 5;
  if (!Number.isFinite(n) || n <= 0) {
    return 5;
  }
  return Math.min(n, 25); // keep output sane
}

function extractTag(summary: unknown): string {
  if (!summary || typeof summary !== "object") {
    return "unknown";
  }

  // transaction-outcome.summaries rows appear as either { Right: {...} } or { Left: {...} }
  const maybe = summary as any;

  const side = maybe.Right ?? maybe.Left ?? maybe;
  if (!side || typeof side !== "object") {
    return "unknown";
  }

  const tag = side.tag;
  if (typeof tag === "string" && tag.length > 0) {
    return tag;
  }
  return "unknown";
}

async function loadRecentSummaries(
  client: Client,
  limit: number
): Promise<TxSummaryRow[]> {
  const res = await client.query<TxSummaryRow>(
    `
      SELECT
        id::text,
        height::text,
        timestamp::text,
        summary
      FROM summaries
      ORDER BY id::bigint DESC
      LIMIT $1
    `,
    [limit]
  );

  return res.rows;
}

function computeTagStats(rows: TxSummaryRow[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const row of rows) {
    const tag = extractTag(row.summary);
    stats[tag] = (stats[tag] ?? 0) + 1;
  }
  return stats;
}

function buildSamplesByTag(
  rows: TxSummaryRow[],
  maxPerTag: number
): Record<
  string,
  Array<{
    id: string;
    height: string;
    timestamp: string;
    summary: unknown;
  }>
> {
  const samples: Record<
    string,
    Array<{
      id: string;
      height: string;
      timestamp: string;
      summary: unknown;
    }>
  > = {};

  for (const row of rows) {
    const tag = extractTag(row.summary);
    const list = (samples[tag] ??= []);
    if (list.length < maxPerTag) {
      list.push({
        id: row.id,
        height: row.height,
        timestamp: row.timestamp,
        summary: row.summary,
      });
    }
  }

  return samples;
}

async function main(): Promise<void> {
  const connectionString = getConnectionString();
  const limit = getBatchLimit();
  const samplePerTag = getSamplePerTag();

  console.log(
    JSON.stringify({
      source: "plt-ingest",
      step: "connecting",
      connectionStringRedacted: true,
      limit,
      samplePerTag,
    })
  );

  const client = new Client({ connectionString });
  await client.connect();

  try {
    console.log(
      JSON.stringify({
        source: "plt-ingest",
        step: "load-summaries",
        limit,
      })
    );

    const rows = await loadRecentSummaries(client, limit);

    const tagStats = computeTagStats(rows);
    const samples = buildSamplesByTag(rows, samplePerTag);

    // High-level stats
    console.log(
      JSON.stringify(
        {
          source: "plt-ingest",
          step: "tag-stats",
          limit,
          totalRows: rows.length,
          uniqueTags: Object.keys(tagStats).length,
          tags: tagStats,
        },
        null,
        2
      )
    );

    // Focus: unknown + any other non-reward tags
    const tagsOfInterest = Object.keys(tagStats).sort((a, b) => {
      if (a === "unknown") return -1;
      if (b === "unknown") return 1;
      if (a === "BlockAccrueReward") return 1;
      if (b === "BlockAccrueReward") return -1;
      return a.localeCompare(b);
    });

    for (const tag of tagsOfInterest) {
      // Skip noisy reward tag unless there are very few
      if (tag === "BlockAccrueReward" && tagStats[tag] > 20) {
        continue;
      }

      console.log(
        JSON.stringify(
          {
            source: "plt-ingest",
            step: "tag-sample",
            tag,
            sampleCount: samples[tag]?.length ?? 0,
            samples: samples[tag] ?? [],
          },
          null,
          2
        )
      );
    }

    // === NEW: PLT extraction preview (no DB writes) =======================
    const extractionOptions: PltExtractionOptions = {
      assetId: "concordium:testnet:PLT:EUDemo",
      networkGenesisIndex: 6, // testnet
    };

    const previewEvents: PltEvent[] = [];
    for (const row of rows) {
      const events = extractPltEventsFromSummaryRow(row, extractionOptions);
      if (events.length > 0) {
        previewEvents.push(...events);
      }
    }

    console.log(
      JSON.stringify(
        {
          source: "plt-ingest",
          step: "extract-preview",
          limit,
          totalRows: rows.length,
          extractedEventCount: previewEvents.length,
          sampleEvents: previewEvents.slice(0, 10),
        },
        null,
        2
      )
    );
    // =====================================================================

    console.log(
      JSON.stringify({
        source: "plt-ingest",
        step: "note",
        note:
          "M3.3 / M3.4 skeleton: read-only inspection of summaries plus PLT " +
          "extraction preview. PLT event extraction implementation + writes " +
          "to crp_plt_events will be added once we have a real EUDemo PLT " +
          "transfer summary to target.",
      })
    );
  } catch (err) {
    console.error("[plt-ingest] failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[plt-ingest] crashed:", err);
    process.exitCode = 1;
  });
}
