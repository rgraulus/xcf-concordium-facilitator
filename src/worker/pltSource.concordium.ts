// src/worker/pltSource.concordium.ts
//
// Concordium PLT event source backed by wallet-proxy /v3/accTransactions.
//
// Cursor model:
// - We treat "height" as a monotonically increasing cursor.
// - We use wallet-proxy transaction `id` as that cursor.
// - When `order=ascending`, wallet-proxy treats `from` as "ids > from".
//
// IMPORTANT invariant (bullet-proofing):
// - We NEVER emit events for tx.id <= lastHeightExclusive, even if an overlap/backfill
//   window includes them or wallet-proxy changes semantics.
// - Overlap is only used to increase visibility / self-heal late visibility, but is
//   combined with strict filtering for "new" txs.
//
// NOTE on account address format:
// In your setup, wallet-proxy rejects strings that start with "ccd1" and
// accepts the base58-looking form.
// We allow either:
//   - "2yV8..."          (passes through)
//   - "ccd12yV8..."      (we strip leading "ccd1" -> "2yV8...")

import { getAccountTransactions as getAccountTransactionsImported } from "../services/walletProxyClient";

export interface ConcordiumNodeConfig {
  accountAddress: string;
  network: string;
  networkGenesisIndex: number;
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

  cursorFrom: number;   // request `from` passed to wallet-proxy
  cursorInput: number;  // lastHeightExclusive we were asked to fetch since
  cursorBest: number;   // max tx.id seen in this scan (may equal cursorInput)

  overlap: number;

  totalSummaries: number;     // txs returned from wallet-proxy
  newSummaries: number;       // txs with id > lastHeightExclusive
  matchedEvents: number;      // events extracted from newSummaries

  sampleEvents: Array<{
    transactionHash: string;
    txId: number;
    blockHash: string;
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
type GetAccountTransactionsFn = (...args: any[]) => Promise<any>;
const getAccountTransactions: GetAccountTransactionsFn =
  getAccountTransactionsImported as unknown as GetAccountTransactionsFn;

export class ConcordiumPltSource {
  constructor(public readonly config: ConcordiumNodeConfig) {}

  async fetchSince(lastHeightExclusive: number): Promise<ConcordiumPltSourceResult> {
    const { accountAddress, network, networkGenesisIndex, assetId } = this.config;

    const limit = 100;

    const overlap = parseIntEnv("CRP_STREAM_OVERLAP", 0);
    const cursorFrom = Math.max(0, lastHeightExclusive - Math.max(0, overlap));

    let resp: any;
    try {
      resp = await getAccountTransactions(accountAddress, {
        from: cursorFrom,
        limit,
        order: "ascending",
        includeRewards: "none",
      });
    } catch (err) {
      console.error("[CRP-STREAM][concordium] wallet-proxy request failed:", err);
      throw err;
    }

    const txs: any[] = resp?.transactions ?? [];

    // bestHeight = max id observed in the response (never decreases)
    let bestHeight = lastHeightExclusive;
    for (const tx of txs) {
      const id = typeof tx?.id === "number" && Number.isFinite(tx.id) ? tx.id : null;
      if (id !== null && id > bestHeight) bestHeight = id;
    }

    // HARD INVARIANT: only process txs that are strictly > cursor (new)
    const newTxs = txs.filter((tx) => {
      const id = typeof tx?.id === "number" && Number.isFinite(tx.id) ? tx.id : null;
      return id !== null && id > lastHeightExclusive;
    });

    const events: ExtractedPltEvent[] = [];
    const sampleEvents: ConcordiumPltScanSummary["sampleEvents"] = [];

    for (const tx of newTxs) {
      const details: any = tx?.details ?? {};

      // wallet-proxy v3 token update style:
      // details.type = "tokenUpdate"
      // details.tokenId = "EUDemo"
      // details.tokenTransferAmount = { decimals: 6, value: "123" }
      const tokenId = typeof details?.tokenId === "string" ? details.tokenId : "";

      const tokenAmountValue =
        details?.tokenTransferAmount && typeof details.tokenTransferAmount.value !== "undefined"
          ? String(details.tokenTransferAmount.value)
          : "";

      const isTokenTransferForAsset = tokenId === assetId && tokenAmountValue.trim() !== "";
      if (!isTokenTransferForAsset) continue;

      const txId = typeof tx?.id === "number" && Number.isFinite(tx.id) ? tx.id : bestHeight;

      const blockHash = String(tx?.blockHash ?? "");
      const blockHeight = Number.isFinite(Number(tx?.blockHeight)) ? Number(tx.blockHeight) : 0;

      const transactionHash = String(tx?.transactionHash ?? `id:${txId}`);
      const eventIndex = 0;

      const fromAddress =
        typeof details?.transferSource === "string" ? details.transferSource : null;
      const toAddress =
        typeof details?.transferDestination === "string" ? details.transferDestination : null;

      const occurredAt =
        typeof tx?.blockTime === "number" && Number.isFinite(tx.blockTime)
          ? new Date(tx.blockTime * 1000)
          : new Date();

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

        amountRaw: tokenAmountValue,
        assetId,

        occurredAt,
        finalized: true,
      };

      events.push(ev);

      if (sampleEvents.length < 3) {
        sampleEvents.push({
          transactionHash: ev.transactionHash,
          txId,
          blockHash: ev.blockHash,
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

      cursorFrom,
      cursorInput: lastHeightExclusive,
      cursorBest: bestHeight,

      overlap,

      totalSummaries: txs.length,
      newSummaries: newTxs.length,
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
