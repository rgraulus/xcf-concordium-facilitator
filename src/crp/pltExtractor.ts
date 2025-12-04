// src/crp/pltExtractor.ts
//
// Shared extractor for PLT (CIS-2) token transfer events from
// Concordium block item summaries.
//
// Used by:
//   - src/tools/debugPltBlock.ts
//   - src/worker/pltSource.concordium.ts

export interface IndexedPltEvent {
  network: string;
  blockHash: string;
  blockHeight: number;
  txHash: string;
  tokenId: string;
  amount: string; // human-readable with decimals, e.g. "1.000000"
  from?: string;
  to?: string;
}

/**
 * Extract PLT transfer events for a given logical token id from a
 * list of Concordium block item summaries.
 */
export function extractPltEventsFromBlockSummaries(
  network: string,
  blockHash: string,
  blockHeight: number,
  logicalTokenId: string,
  summaries: any[]
): IndexedPltEvent[] {
  const results: IndexedPltEvent[] = [];

  for (const summary of summaries ?? []) {
    const txType: string =
      summary.transactionType ?? summary.type ?? "<unknown>";

    // On Concordium, PLT transfers come in "tokenUpdate" account txs.
    if (txType !== "tokenUpdate" && txType !== "TokenUpdate") {
      continue;
    }

    const events: any[] = Array.isArray(summary.events)
      ? summary.events
      : [];

    for (const ev of events) {
      if (!ev || ev.tag !== "TokenTransfer") continue;

      // tokenId can be a TokenId object or plain string
      const tokenIdVal = ev.tokenId;
      const tokenIdStr =
        tokenIdVal && typeof tokenIdVal.toString === "function"
          ? tokenIdVal.toString()
          : String(tokenIdVal ?? "");

      if (tokenIdStr !== logicalTokenId) {
        continue;
      }

      // Amount can be a TokenAmount or plain object
      const amountVal = ev.amount;
      let amountStr: string;

      if (
        amountVal &&
        typeof amountVal === "object" &&
        "value" in amountVal &&
        "decimals" in amountVal
      ) {
        const raw = BigInt((amountVal as any).value);
        const decimals = Number((amountVal as any).decimals ?? 0);
        const scale = 10n ** BigInt(decimals);
        const whole = raw / scale;
        const frac = raw % scale;
        const fracStr = frac.toString().padStart(decimals, "0");
        amountStr = `${whole.toString()}.${fracStr}`;
      } else if (amountVal && typeof amountVal.toString === "function") {
        amountStr = amountVal.toString();
      } else {
        amountStr = String(amountVal ?? "");
      }

      const fromVal = ev.from;
      const toVal = ev.to;

      const fromStr =
        fromVal && typeof fromVal.toString === "function"
          ? fromVal.toString()
          : fromVal
          ? JSON.stringify(fromVal)
          : undefined;

      const toStr =
        toVal && typeof toVal.toString === "function"
          ? toVal.toString()
          : toVal
          ? JSON.stringify(toVal)
          : undefined;

      const txHashVal = summary.hash;
      const txHashStr =
        txHashVal && typeof txHashVal.toString === "function"
          ? txHashVal.toString()
          : String(txHashVal ?? "");

      results.push({
        network,
        blockHash,
        blockHeight,
        txHash: txHashStr,
        tokenId: logicalTokenId,
        amount: amountStr,
        from: fromStr,
        to: toStr,
      });
    }
  }

  return results;
}
