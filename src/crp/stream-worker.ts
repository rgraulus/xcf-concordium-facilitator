// src/crp/stream-worker.ts
//
// Legacy CRP stream worker (M2).
//
// In M3 the streaming logic has moved to:
//
//   - src/worker/main.ts
//   - src/crp/pltSource.concordium.ts
//
// This file is kept only so that older build scripts and TypeScript
// compilation still succeed. It no longer performs any work at runtime.
//
// If you need a stream worker entrypoint, use:
//
//   npm run crp:worker:demo
//   # which runs: ts-node src/worker/main.ts
//
// or point your container entrypoint directly at dist/worker/main.js
// after building.

export {};
