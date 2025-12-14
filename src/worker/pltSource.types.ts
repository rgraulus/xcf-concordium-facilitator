export interface ExtractedPltEvent {
  network: string;
  networkGenesisIndex: number;

  blockHash: string;
  blockHeight: number;

  transactionHash: string;
  eventIndex: number;

  eventType: string;
  fromAddress: string | null;
  toAddress: string | null;

  amountRaw: string;
  assetId: string;

  occurredAt: Date;
  finalized: boolean;
}

/**
 * Shared scan summary shape that both Concordium(wallet-proxy) and fixture sources can satisfy.
 * Keep it strict (no index signature) so concrete summary types remain assignable.
 */
export interface PltSourceSummary {
  // optional: fixture sources may populate this
  source?: string;

  network: string;

  cursorFrom: number;
  cursorBest: number;

  // either style is OK (depends on source)
  totalItems?: number;
  totalSummaries?: number;

  matchedEvents: number;

  // common concordium extras (optional so fixtures aren't forced to provide them)
  assetId?: string;
  networkGenesisIndex?: number;

  sampleEvents: Array<{
    transactionHash: string;
    blockHeight: number;
    assetId: string;
    amountRaw: string;
    fromAddress: string | null;
    toAddress: string | null;
  }>;
}

export interface PltSourceResult {
  events: ExtractedPltEvent[];
  bestHeight: number; // monotonic cursor used by worker
  summary?: PltSourceSummary;
}

export interface PltSource {
  fetchSince(lastHeightExclusive: number): Promise<PltSourceResult>;
}
