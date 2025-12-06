// src/worker/pltSource.concordium.ts
//
// Concordium PLT event source backed by the wallet-proxy /v3/accTransactions
// endpoint. This replaces the earlier "stub" implementation which always
// returned 0 events.
//
// The worker treats the "height" as a monotonically increasing cursor. Here we
// use the wallet-proxy transaction `id` as that cursor, since the README
// specifies that `id` is a stable, ordered identifier and `from` means
// "transactions with higher ids than this" when order is ascending.
//
// We scan transactions for a single account (CRP_STREAM_ACCOUNT) and
// heuristically select PLT-related ones based on `details.type` and
// `details.events`. Amounts remain stubbed for now; this will be refined once
// structured PLT transfer data is exposed.

import { getAccountTransactions } from "../services/walletProxyClient";

export interface ConcordiumNodeConfig {
  /**
   * Account whose CCD/PLT history we scan via wallet-proxy.
   */
  accountAddress: string;

  /**
   * Logical network name, e.g. "concordium:testnet".
   */
  network: string;

  /**
   * Logical tokenId filter for PLT, e.g. "EUDemo" or "usd:test".
   * For now this is used only for tagging events; we do not yet filter
   * on-chain data by token id.
   */
  logicalTokenId: string;
}

/**
 * Normalized PLT transfer event as seen by the worker.
 */
export interface ExtractedPltEvent {
  network: string;
  blockHash: string;
  blockHeight: number;
  txHash: string;
  tokenId: string;
  amountMinor: string;
  from: string | null;
  to: string;
  occurredAt: Date;
  eventIndex: number;
}

/**
 * Summary of a single scan step, similar in spirit to the earlier stubbed
 * "latest-block sample" logging.
 */
export interface ConcordiumPltScanSummary {
  network: string;
  tokenIdFilter: string;
  blockHash: string | null;
  blockHeight: number | null;
  totalSummaries: number;
  matchedEvents: number;
  sampleSummaries: unknown[];
  sampleEvents: Array<{
    network: string;
    blockHash: string;
    blockHeight: number;
    txHash: string;
    tokenId: string;
    amount: string;
    from: string | null;
    to: string;
  }>;
}

/**
 * Result of a scan step.
 */
export interface ConcordiumPltSourceResult {
  events: ExtractedPltEvent[];
  /**
   * Best (highest) transaction id we've seen in this scan. The worker uses this
   * as the next `lastHeightExclusive` when polling again.
   */
  bestHeight: number;
  summary: ConcordiumPltScanSummary;
}

export class ConcordiumPltSource {
  constructor(public readonly config: ConcordiumNodeConfig) {}

  /**
   * Fetch PLT-related events strictly above `lastHeightExclusive`, where
   * "height" here is the wallet-proxy transaction `id`.
   *
   * We call wallet-proxy /v3/accTransactions with:
   *   - order=ascending
   *   - from=lastHeightExclusive (proxy returns ids > this when ascending)
   *   - limit=some sane page size
   *
   * We then:
   *   - compute `bestHeight` as the max `id` among all returned txs
   *   - heuristically select PLT-related txs as events
   */
  async fetchSince(
    lastHeightExclusive: number
  ): Promise<ConcordiumPltSourceResult> {
    const { accountAddress, network, logicalTokenId } = this.config;

    // Sane page size; we only run this in a demo/worker context right now.
    const limit = 100;

    let resp;
    try {
      resp = await getAccountTransactions(accountAddress, {
        limit,
        order: "ascending",
        from: lastHeightExclusive > 0 ? lastHeightExclusive : undefined,
        includeRewards: "none",
      });
    } catch (err) {
      console.error(
        "[CRP-STREAM][concordium] wallet-proxy request failed:",
        err
      );
      throw err;
    }

    const txs = resp.transactions ?? [];

    // Compute the bestHeight as the highest transaction id we've seen,
    // even if none of the transactions turn into PLT events. This ensures
    // we make forward progress and don't re-scan the same range repeatedly.
    let bestHeight = lastHeightExclusive;
    for (const tx of txs) {
      if (typeof tx.id === "number" && tx.id > bestHeight) {
        bestHeight = tx.id;
      }
    }

    const events: ExtractedPltEvent[] = [];
    const sampleEvents: ConcordiumPltScanSummary["sampleEvents"] = [];

    for (const tx of txs) {
      const details = (tx.details ?? {}) as any;

      const detailsType = String(details.type ?? "");
      const detailsEvents = Array.isArray(details.events)
        ? details.events.map((e: unknown) => String(e))
        : [];

      // Heuristic: treat PLT-related transactions as:
      // - those with PLT-specific types in v3 ("updateCreatePLT", "tokenGovernance", "tokenHolder"), or
      // - those whose localized event descriptions mention "PLT".
      const isPltTx =
        detailsType === "updateCreatePLT" ||
        detailsType === "tokenGovernance" ||
        detailsType === "tokenHolder" ||
        detailsEvents.some((e: string) => e.toLowerCase().includes("plt"));

      if (!isPltTx) {
        continue;
      }

      const txId =
        typeof tx.id === "number" && Number.isFinite(tx.id)
          ? tx.id
          : bestHeight;

      const blockHash = String((tx as any).blockHash ?? "");
      const blockHeight = Number((tx as any).blockHeight ?? 0);
      const txHash = tx.transactionHash ?? `id:${txId}`;

      // TODO: Once wallet-proxy (or Concordium SDK) exposes structured PLT
      // transfer amounts, map that here. For now we store "0" as a placeholder
      // to keep the schema happy.
      const amountMinor = "0";

      const from =
        typeof details.transferSource === "string"
          ? details.transferSource
          : null;
      const to =
        typeof details.transferDestination === "string"
          ? details.transferDestination
          : accountAddress;

      const occurredAt = new Date(Number(tx.blockTime) * 1000);
      const eventIndex = 0;

      events.push({
        network,
        blockHash,
        blockHeight,
        txHash,
        tokenId: logicalTokenId,
        amountMinor,
        from,
        to,
        occurredAt,
        eventIndex,
      });

      if (sampleEvents.length < 3) {
        sampleEvents.push({
          network,
          blockHash,
          blockHeight,
          txHash,
          tokenId: logicalTokenId,
          amount: amountMinor,
          from,
          to,
        });
      }
    }

    const lastTx = txs.length > 0 ? (txs[txs.length - 1] as any) : undefined;

    const summary: ConcordiumPltScanSummary = {
      network,
      tokenIdFilter: logicalTokenId,
      blockHash: lastTx ? String(lastTx.blockHash ?? "") : null,
      blockHeight: lastTx
        ? Number(lastTx.blockHeight ?? bestHeight)
        : bestHeight,
      totalSummaries: txs.length,
      matchedEvents: events.length,
      sampleSummaries: [],
      sampleEvents,
    };

    console.log("[CRP-STREAM][concordium] wallet-proxy scan", summary);

    return {
      events,
      bestHeight,
      summary,
    };
  }
}

/**
 * Helper to build a config from environment variables.
 *
 * We no longer depend on CONCORDIUM_NODE_URL here; the PLT source is backed
 * by wallet-proxy instead. We still keep the "Concordium*" naming so the
 * worker wiring (M3) remains unchanged.
 */
export function createConcordiumNodeConfigFromEnv(): ConcordiumNodeConfig {
  const network = process.env.CRP_STREAM_NETWORK ?? "concordium:testnet";
  const logicalTokenId =
    process.env.CONCORDIUM_PLT_TOKEN_ID ??
    process.env.CRP_STREAM_TOKEN_ID ??
    "EUDemo";

  const accountAddress =
    process.env.CRP_STREAM_ACCOUNT ??
    process.env.CRP_STREAM_PAYTO_ACCOUNT ??
    process.env.CRP_STREAM_ACCOUNT_ADDRESS;

  if (!accountAddress || accountAddress.trim() === "") {
    throw new Error(
      "CRP_STREAM_ACCOUNT (or CRP_STREAM_PAYTO_ACCOUNT / CRP_STREAM_ACCOUNT_ADDRESS) " +
        "is required for the concordium PLT source (wallet-proxy account address)."
    );
  }

  const config: ConcordiumNodeConfig = {
    accountAddress,
    network,
    logicalTokenId,
  };

  console.log("[CRP-STREAM][concordium] Using wallet-proxy-backed source", {
    accountAddress: config.accountAddress,
    network: config.network,
    logicalTokenId: config.logicalTokenId,
  });

  return config;
}
