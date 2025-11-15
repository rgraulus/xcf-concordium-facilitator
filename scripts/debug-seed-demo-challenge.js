// scripts/debug-seed-demo-challenge.js
//
// Inserts a single demo challenge row into `challenges` using the same
// Postgres schema as the gateway/idempotency logic.
//
// This lets us exercise /v1/crp/payments/search with real data.
//
// Usage:
//   node -r dotenv/config scripts/debug-seed-demo-challenge.js

const { upsertChallenge } = require("../dist/store/repo.pg");

async function main() {
  const now = Date.now();
  const expiry = new Date(now + 60 * 60 * 1000).toISOString(); // +1 hour

  const input = {
    merchant_id: "demo-merchant-1",
    nonce: "demo-nonce-plt-1",
    network: "concordium:testnet",
    asset: {
      type: "PLT",
      tokenId: "usd:test",
      decimals: 2,
    },
    amount: "25.00", // major units
    pay_to: "ccd1qexampleaddress",
    expiry,
    policy: {
      // Arbitrary demo policy metadata; safe to ignore for matching
      kind: "demo-policy",
    },
    metadata: {
      note: "Demo seeded challenge for /v1/crp/payments/search",
    },
    status: "pending", // xcf_status enum
  };

  console.log("Seeding demo challenge with payload:");
  console.log(JSON.stringify(input, null, 2));

  const result = await upsertChallenge(input);

  console.log("\nResult from upsertChallenge:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Error in debug-seed-demo-challenge:", err);
  process.exitCode = 1;
});
