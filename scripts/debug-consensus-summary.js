// scripts/debug-consensus-summary.js

const { getConsensusSummary } = require("../dist/crp/grpc");

async function main() {
  console.log("Fetching consensus summary...");
  try {
    const summary = await getConsensusSummary();
    console.log("Consensus summary (raw):");
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error("Error fetching consensus summary:", err);
    process.exitCode = 1;
  }
}

main();
