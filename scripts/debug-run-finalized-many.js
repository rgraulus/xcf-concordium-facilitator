// scripts/debug-run-finalized-many.js
//
// Usage:
//   node -r dotenv/config scripts/debug-run-finalized-many.js [COUNT]
//
// Example (20 iterations):
//   node -r dotenv/config scripts/debug-run-finalized-many.js 20
//
// This will call runFinalizedIngestOnce() COUNT times, with a short pause
// between iterations, and print the result each time.

const { runFinalizedIngestOnce } = require("../dist/crp/stream-worker");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const arg = process.argv[2];
  const count = arg ? Number(arg) : 10;

  if (!Number.isFinite(count) || count <= 0) {
    console.error("COUNT must be a positive number");
    process.exit(1);
  }

  console.log(`Running finalized ingest ${count} time(s)...`);

  for (let i = 0; i < count; i++) {
    console.log(`\n=== Iteration ${i + 1} of ${count} ===`);
    try {
      const res = await runFinalizedIngestOnce();
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error("Error during runFinalizedIngestOnce:", err);
    }

    // Small pause between iterations so we track new finalized blocks as they appear.
    await sleep(2000);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error in debug-run-finalized-many:", err);
  process.exitCode = 1;
});
