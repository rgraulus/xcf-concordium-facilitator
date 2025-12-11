// src/worker/pltWorker.ts
//
// XCF PLT Worker (M3.1 skeleton)
//
// This worker currently focuses on:
//  - Connecting to Postgres
//  - Periodically issuing a cheap "SELECT NOW()" ping
//
// Node gRPC / PLT event streaming will be wired in a later M3 step.
// For Concordium node connectivity, rely on the dedicated probe scripts:
//
//   npm run probe:web-sdk         # public testnet
//   npm run probe:web-sdk:local   # local P9 node

import { Client } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

function createPgClient(): Client {
  const connectionString =
    process.env.XCF_PG_DSN ??
    process.env.DATABASE_URL ??
    "postgres://postgres:pg@127.0.0.1:5432/postgres";

  return new Client({ connectionString });
}

async function run(): Promise<void> {
  // 1) Connect to DB
  const pgClient = createPgClient();
  await pgClient.connect();

  console.log(
    JSON.stringify(
      {
        source: "plt-worker",
        step: "db-connected",
        connectionStringRedacted: true,
      },
      null,
      2
    )
  );

  // 2) Start polling loop (placeholder for real PLT indexing)
  const pollMs = Number(process.env.XCF_PLT_WORKER_POLL_MS ?? 5000);
  let tick = 0;

  console.log(
    JSON.stringify(
      {
        source: "plt-worker",
        step: "loop-start",
        pollMs,
        note:
          "M3.1 skeleton: DB-only worker. PLT node gRPC / event wiring will be added in later M3 steps.",
      },
      null,
      2
    )
  );

  while (true) {
    tick += 1;

    try {
      // Cheap, DB-agnostic ping. Works on any Postgres DB.
      const res = await pgClient.query<{ now: Date }>(
        "SELECT NOW() AS now"
      );
      const now = res.rows[0]?.now;

      console.log(
        JSON.stringify(
          {
            source: "plt-worker",
            step: "loop-tick",
            tick,
            ping: now instanceof Date ? now.toISOString() : String(now),
          },
          null,
          2
        )
      );
    } catch (err) {
      console.error("[plt-worker] loop tick failed:", err);
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Entrypoint
if (require.main === module) {
  run().catch((err) => {
    console.error("[plt-worker] fatal error:", err);
    process.exitCode = 1;
  });
}
