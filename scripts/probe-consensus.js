const { GrpcTransport } = require("@protobuf-ts/grpc-transport");
const grpcjs = require("@grpc/grpc-js");
require("dotenv/config");

function cfg() {
  return {
    host: process.env.CONCORDIUM_GRPC_HOST || "127.0.0.1",
    port: Number(process.env.CONCORDIUM_GRPC_PORT || "20000"),
    tls: String(process.env.CONCORDIUM_GRPC_TLS || "false").toLowerCase() === "true",
  };
}

function makeTransport({ host, port, tls }) {
  const creds = tls ? grpcjs.credentials.createSsl() : grpcjs.credentials.createInsecure();
  return new GrpcTransport({ host: `${host}:${port}`, channelCredentials: creds });
}

function toUint8(b) {
  if (!b) return undefined;
  if (b instanceof Uint8Array) return b;
  if (b && b.value instanceof Uint8Array) return b.value;
  if (Array.isArray(b)) return Uint8Array.from(b);
  return undefined;
}
const toHex = (u) => (u ? Buffer.from(u).toString("hex") : "");

async function main() {
  const { QueriesClient } = require("@concordium/common-sdk/grpc/v2/concordium/service.client");
  const transport = makeTransport(cfg());
  const client = new QueriesClient(transport);

  // IMPORTANT: protobuf-ts returns a UnaryCall wrapper. Await .response.
  const call = client.getConsensusInfo({});
  const info = await call.response;

  const bestRaw = info.bestBlock ?? info.bestBlockHash ?? info.bestBlockDigest ?? null;
  const finalizedRaw = info.lastFinalizedBlock ?? info.lastFinalizedBlockHash ?? info.finalizedBlock ?? null;

  const bestHex = toHex(toUint8(bestRaw));
  const finalizedHex = toHex(toUint8(finalizedRaw));

  console.log("CONSENSUS OK:", {
    genesisIndex: info.genesisIndex,
    bestBlockHex: bestHex,
    lastFinalizedBlockHex: finalizedHex,
    // Keep a tiny bit of debug in case fields differ across versions
    _debugKeys: Object.keys(info || {}),
  });
}

main().catch((e) => {
  console.error("PROBE FAILED:", { code: e.code, message: e.message });
  process.exit(1);
});
