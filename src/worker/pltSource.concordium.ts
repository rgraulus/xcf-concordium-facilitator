// src/worker/pltSource.concordium.ts
//
// Concordium PLT event source backed by wallet-proxy /v3/accTransactions.
//
// Cursor model:
// - We treat "height" as a monotonically increasing cursor.
// - We use wallet-proxy transaction `id` as that cursor.
// - When `order=ascending`, wallet-proxy treats `from` as "ids > from".
//
// NOTE on account address format:
// In your setup, wallet-proxy rejects strings that start with "ccd1" and
// accepts the base58-looking form (e.g. "2yV8...").
// To be user-friendly, we allow either:
//   - "2yV8..."          (passes through)
//   - "ccd12yV8..."      (we strip leading "ccd1" -> "2yV8...")

import { getAccountTransactions as getAccountTransactionsImported } from "../services/walletProxyClient";

export interface ConcordiumNodeConfig {
  /**
   * Account address to scan (in the format wallet-proxy accepts).
   */
  accountAddress: string;

  /**
   * Logical network name, e.g. "concordium:testnet".
   * Stored into crp_plt_events.network.
   */
  network: string;

  /**
   * Network genesis index, e.g. 6 for Concordium testnet (as seen in /consensus).
   * Stored into crp_plt_events.network_genesis_index.
   */
  networkGenesisIndex: number;

  /**
   * Asset id / token id for PLT, e.g. "EUDemo".
   * Stored into crp_plt_events.asset_id.
   */
  assetId: string;
}

export interface ExtractedPltEvent {
  network: string;
  networkGenesisIndex: number;

  blockHash: string;
  blockHeight: number;

  transactionHash: string;
  eventIndex: number;

  eventType: string; // e.g. 'transfer'
  fromAddress: string | null;
  toAddress: string | null;

  amountRaw: string; // atomic integer as string
  assetId: string;

  occurredAt: Date;
  finalized: boolean;
}

export interface ConcordiumPltScanSummary {
  network: string;
  assetId: string;
  networkGenesisIndex: number;

  cursorFrom: number;
  cursorBest: number;

  totalSummaries: number;
  matchedEvents: number;

  sampleEvents: Array<{
    transactionHash: string;
    blockHeight: number;
    assetId: string;
    amountRaw: string;
    fromAddress: string | null;
    toAddress: string | null;
  }>;
}

export interface ConcordiumPltSourceResult {
  events: ExtractedPltEvent[];
  bestHeight: number; // wallet-proxy tx `id`
  summary: ConcordiumPltScanSummary;
}

// Make this robust to different TS typings of walletProxyClient.
// (At runtime, extra args are harmless even if the function ignores them.)
type GetAccountTransactionsFn = (...args: any[]) => Promise<any>;
const getAccountTransactions: GetAccountTransactionsFn =
  getAccountTransactionsImported as unknown as GetAccountTransactionsFn;

export class ConcordiumPltSource {
  constructor(public readonly config: ConcordiumNodeConfig) {}

  async fetchSince(lastHeightExclusive: number): Promise<ConcordiumPltSourceResult> {
    const { accountAddress, network, networkGenesisIndex, assetId } = this.config;

    const limit = 100;

    let resp: any;
    try {
      // IMPORTANT: walletProxyClient expects the account address as a string param.
      resp = await getAccountTransactions(accountAddress, {
        from: lastHeightExclusive,
        limit,
        order: "ascending",
        includeRewards: "none",
      });
    } catch (err) {
      console.error("[CRP-STREAM][concordium] wallet-proxy request failed:", err);
      throw err;
    }

    const txs: any[] = resp?.transactions ?? [];

    // Forward progress cursor (wallet-proxy tx id)
    let bestHeight = lastHeightExclusive;
    for (const tx of txs) {
      if (typeof tx?.id === "number" && tx.id > bestHeight) {
        bestHeight = tx.id;
      }
    }

    const events: ExtractedPltEvent[] = [];
    const sampleEvents: ConcordiumPltScanSummary["sampleEvents"] = [];

    for (const tx of txs) {
      const details: any = tx?.details ?? {};
      const detailsType = String(details?.type ?? "");
      const detailsEvents: string[] = Array.isArray(details?.events)
        ? details.events.map((e: any) => String(e))
        : [];

      // Heuristic for "PLT-ish" activity (still coarse)
      const isPltTx =
        detailsType === "updateCreatePLT" ||
        detailsType === "tokenGovernance" ||
        detailsType === "tokenHolder" ||
        detailsEvents.some((e: string) => e.toLowerCase().includes("plt"));

      if (!isPltTx) continue;

      const txId =
        typeof tx?.id === "number" && Number.isFinite(tx.id) ? tx.id : bestHeight;

      const blockHash = String(tx?.blockHash ?? "");
      const blockHeight = Number(tx?.blockHeight ?? 0);

      const transactionHash = String(tx?.transactionHash ?? `id:${txId}`);
      const eventIndex = 0;

      const fromAddress =
        typeof details?.transferSource === "string" ? details.transferSource : null;
      const toAddress =
        typeof details?.transferDestination === "string"
          ? details.transferDestination
          : null;

      const occurredAt =
        typeof tx?.blockTime === "number" && Number.isFinite(tx.blockTime)
          ? new Date(tx.blockTime * 1000)
          : new Date();

      // TODO: replace with real PLT amount extraction once available
      const amountRaw = "0";

      const ev: ExtractedPltEvent = {
        network,
        networkGenesisIndex,

        blockHash,
        blockHeight,

        transactionHash,
        eventIndex,

        eventType: "transfer",
        fromAddress,
        toAddress,

        amountRaw,
        assetId,

        occurredAt,
        finalized: true,
      };

      events.push(ev);

      if (sampleEvents.length < 3) {
        sampleEvents.push({
          transactionHash: ev.transactionHash,
          blockHeight: ev.blockHeight,
          assetId: ev.assetId,
          amountRaw: ev.amountRaw,
          fromAddress: ev.fromAddress,
          toAddress: ev.toAddress,
        });
      }
    }

    const summary: ConcordiumPltScanSummary = {
      network,
      assetId,
      networkGenesisIndex,
      cursorFrom: lastHeightExclusive,
      cursorBest: bestHeight,
      totalSummaries: txs.length,
      matchedEvents: events.length,
      sampleEvents,
    };

    console.log("[CRP-STREAM][concordium] wallet-proxy scan", summary);

    return { events, bestHeight, summary };
  }
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return defaultValue;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) ? v : defaultValue;
}

function normalizeAccountForWalletProxy(inputRaw: string): { normalized: string; note?: string } {
  const input = (inputRaw ?? "").trim();
  if (!input) return { normalized: "" };

  if (input.startsWith("ccd1") && input.length > 4) {
    return {
      normalized: input.slice(4),
      note: `Stripped leading "ccd1" (wallet-proxy in this setup expects the base58 form).`,
    };
  }

  return { normalized: input };
}

export function createConcordiumNodeConfigFromEnv(): ConcordiumNodeConfig {
  const network = process.env.CRP_STREAM_NETWORK ?? "concordium:testnet";

  const assetId =
    process.env.CONCORDIUM_PLT_TOKEN_ID ??
    process.env.CRP_STREAM_TOKEN_ID ??
    "EUDemo";

  const rawAccountAddress = process.env.CRP_STREAM_ACCOUNT ?? "";
  const { normalized: accountAddress, note } = normalizeAccountForWalletProxy(rawAccountAddress);

  if (!accountAddress) {
    throw new Error(
      "CRP_STREAM_ACCOUNT is required (wallet-proxy-accepted format). " +
        'Example: "2yV8..." (if you accidentally used "ccd1...", the worker will strip it).'
    );
  }

  const networkGenesisIndex = parseIntEnv(
    "CRP_STREAM_NETWORK_GENESIS_INDEX",
    parseIntEnv("CONCORDIUM_NETWORK_GENESIS_INDEX", 6)
  );

  if (note) {
    console.log("[CRP-STREAM][concordium] NOTE:", note);
  }

  const config: ConcordiumNodeConfig = {
    accountAddress,
    network,
    networkGenesisIndex,
    assetId,
  };

  console.log("[CRP-STREAM][concordium] Using wallet-proxy-backed source", {
    accountAddress: config.accountAddress,
    network: config.network,
    networkGenesisIndex: config.networkGenesisIndex,
    assetId: config.assetId,
  });

  return config;
}
