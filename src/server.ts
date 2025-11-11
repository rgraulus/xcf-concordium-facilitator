// src/server.ts
import fastify from "fastify";
import dotenv from "dotenv";
dotenv.config();

// Helper: load a Fastify plugin regardless of export shape
function loadPlugin(mod: any) {
  return (mod && (mod.default || mod.routes || mod)) as Parameters<
    typeof server.register
  >[0];
}

// Use CommonJS requires to avoid TS “no default export” for route files
// (these files may export: default | routes | module.exports = fn)
const jwksMod = require("./routes/jwks");
const adminMod = require("./routes/admin");
const verifyMod = require("./routes/verify");
const challengesMod = require("./routes/challenges");

// These two were previously problematic; keep the same tolerant loading
const readsMod = require("./routes/crp.reads");
const paymentsMod = require("./routes/crp.payments");

// DB helpers may or may not be named exports in your repo; load defensively.
const dbMod = require("./db/pool");
const getDbPool =
  dbMod?.getDbPool || dbMod?.default?.getDbPool || dbMod?.pool || null;
const logDbInfo =
  dbMod?.logDbInfo || dbMod?.default?.logDbInfo || dbMod?.log || null;

const server = fastify({ logger: true });

// Initialize/log DB if helpers exist
try {
  if (getDbPool && typeof getDbPool === "function") {
    const pool = getDbPool();
    if (logDbInfo && typeof logDbInfo === "function") {
      logDbInfo(pool);
    }
  } else {
    server.log.info("[DB] Skipping optional pool init (helpers not exported).");
  }
} catch (err) {
  server.log.warn({ err }, "[DB] Optional init/log failed; continuing.");
}

// Register routes (export-shape agnostic)
server.register(loadPlugin(jwksMod));
server.register(loadPlugin(adminMod));
server.register(loadPlugin(verifyMod));
server.register(loadPlugin(challengesMod));
server.register(loadPlugin(readsMod));
server.register(loadPlugin(paymentsMod));

// Basic health
server.get("/healthz", async () => ({ ok: true }));

async function start() {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || "0.0.0.0";

  try {
    await server.listen({ port, host });
    server.log.info(`UFX listening on :${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
