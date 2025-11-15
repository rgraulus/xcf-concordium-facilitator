// src/crp/parser.ts

/**
 * Parsed PLT transfer in a normalized form, ready to be stored in the DB.
 * (Block fetching and raw event decoding will be handled elsewhere.)
 */

export type ParsedPltTransfer = {
  blockHash: string;
  txHash: string;
  eventIndex: number;
  tokenId: string;
  from: string | null;
  to: string;
  amountMinor: string;   // integer minor units as string
  decimals: number;
  occurredAt: Date;
};

/**
 * Placeholder for future PLT event parsing from Concordium web-sdk block data.
 *
 * For now this is a stub so we have a type and call-site scaffolding.
 * Later, this function will:
 *  - Walk CIS-7 events in a finalized block.
 *  - Filter to the PLT(s) we care about.
 *  - Normalize amounts into minor units.
 */
export function parsePltTransfersFromBlock(_rawBlock: any, _network: string): ParsedPltTransfer[] {
  // TODO: implement actual parsing using @concordium/web-sdk block / event structures.
  return [];
}
