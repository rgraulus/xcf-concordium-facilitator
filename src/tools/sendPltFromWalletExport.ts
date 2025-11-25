// src/tools/sendPltFromWalletExport.ts
//
// Local helper to send a PLT transfer from a wallet.export file,
// using the Concordium Web SDK PLT examples as reference.
//
// This is *not* called by the facilitator service; it's a standalone
// tool you run manually via ts-node or an npm script.

import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";

import { AccountAddress, parseWallet, buildAccountSigner } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { credentials } from "@grpc/grpc-js";
import { Token, TokenId, TokenAmount, TokenHolder } from "@concordium/web-sdk/plt";

/**
 * Require an env var or throw a clear error.
 */
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || !val.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val.trim();
}

/**
 * Parse CONCORDIUM_NODE_URL of the form "host:port".
 * For example: "grpc.testnet.concordium.com:20000"
 */
function parseNodeUrl(raw: string): { address: string; port: number; useTls: boolean } {
  const trimmed = raw.trim();
  const [host, portStr] = trimmed.split(":");
  const port = Number(portStr || "20000");
  if (!host || !Number.isFinite(port)) {
    throw new Error(`Invalid CONCORDIUM_NODE_URL: ${raw}`);
  }

  const insecure = process.env.CONCORDIUM_NODE_INSECURE === "1";

  return {
    address: host,
    port,
    useTls: !insecure,
  };
}

async function main() {
  // --- 1. Resolve node + token + transfer params from env ---

  const nodeUrl = process.env.CONCORDIUM_NODE_URL ?? "grpc.testnet.concordium.com:20000";
  const nodeCfg = parseNodeUrl(nodeUrl);

  // e.g. "wCCD"
  const tokenSymbol = requireEnv("CONCORDIUM_PLT_TOKEN_ID");

  // Base58 account address of the receiver (can be the same as sender for self-transfer)
  const recipientAddress = requireEnv("CONCORDIUM_RECIPIENT");

  // Human-readable amount, e.g. "1.5"
  const amountDecimalStr = process.env.CONCORDIUM_PLT_AMOUNT ?? "1.0";
  const amountDecimal = Number(amountDecimalStr);
  if (!Number.isFinite(amountDecimal) || amountDecimal <= 0) {
    throw new Error(
      `CONCORDIUM_PLT_AMOUNT must be a positive number, got: ${amountDecimalStr}`
    );
  }

  // Optional memo; we will ignore it for now (no memo wired yet)
  const memoText = (process.env.CONCORDIUM_PLT_MEMO ?? "").trim();

  // --- 2. Construct gRPC client ---

  const grpcCreds = nodeCfg.useTls ? credentials.createSsl() : credentials.createInsecure();

  const client = new ConcordiumGRPCNodeClient(nodeCfg.address, nodeCfg.port, grpcCreds);

  console.log("[PLT-SEND] Using node connection:", nodeCfg);

  // --- 3. Load wallet.export and build signer ---

  const walletPath = process.env.CONCORDIUM_WALLET_EXPORT_PATH ?? "keys/wallet.export";

  if (!existsSync(walletPath)) {
    throw new Error(
      `wallet.export file not found at ${walletPath}. ` +
        `Ensure you exported the file wallet from the Concordium wallet ` +
        `and placed it there.`
    );
  }

  const walletFile = readFileSync(walletPath, "utf8");
  const walletExport = parseWallet(walletFile);
  const sender = AccountAddress.fromBase58(walletExport.value.address);
  const signer = buildAccountSigner(walletExport);

  console.log("[PLT-SEND] Sender account:", sender.toString());

  // --- 4. Resolve token + decimals and construct transfer ---

  const tokenId = TokenId.fromString(tokenSymbol);
  const token = await Token.fromId(client, tokenId);

  const decimals = token.info.state.decimals;
  const amount = TokenAmount.fromDecimal(amountDecimal, decimals);

  const recipient = TokenHolder.fromAccountAddress(
    AccountAddress.fromBase58(recipientAddress)
  ).address;

  const transfer = {
    recipient,
    amount,
    memo: undefined as unknown, // memo not wired for now
  };

  if (memoText !== "") {
    console.warn(
      "[PLT-SEND] Memo text provided, but memo support is not yet wired. Ignoring memo."
    );
  }

  console.log("[PLT-SEND] Token symbol:", tokenId.toString());
  console.log("[PLT-SEND] Token decimals:", decimals);
  console.log("[PLT-SEND] Transfer input:", {
    recipient,
    amount: amount.toString(),
  });

  // --- 5. Submit transfer and wait for finalization ---

  const txHash = await Token.transfer(token, sender, transfer, signer);
  console.log("[PLT-SEND] Submitted PLT transfer, txHash:", txHash);

  const result = await client.waitForTransactionFinalization(txHash);
  console.log("[PLT-SEND] Transaction finalization result:");
  console.dir(result, { depth: null });

  console.log("[PLT-SEND] Done.");
}

main().catch((err) => {
  console.error("[PLT-SEND] Fatal error:", err);
  process.exit(1);
});
