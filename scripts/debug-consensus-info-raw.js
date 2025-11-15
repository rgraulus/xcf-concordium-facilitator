// scripts/debug-consensus-info-raw.js

const { debugConsensusInfoRaw } = require("../dist/crp/grpc");

async function main() {
  console.log("Fetching raw consensus info...");
  try {
    const info = await debugConsensusInfoRaw();

    console.log("Raw consensus info (BigInt → string):");
    const safeJson = JSON.stringify(
      info,
      (key, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    );
    console.log(safeJson);
  } catch (err) {
    console.error("Error fetching raw consensus info:", err);
    process.exitCode = 1;
  }
}

main();
