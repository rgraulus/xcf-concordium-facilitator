// scripts/debug-run-finalized-once.js

// Use the built JS from dist, not the TS sources.
const { runFinalizedIngestOnce } = require("../dist/crp/stream-worker");

async function main() {
  console.log("Running finalized ingest once...");
  try {
    const res = await runFinalizedIngestOnce();
    console.log("Finalized ingest result:");
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error("Error during finalized ingest:", err);
    process.exitCode = 1;
  }
}

main();
