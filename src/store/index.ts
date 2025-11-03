// src/store/index.ts
import * as pg from "./repo.pg";

// Keep the repo namespace (matches your current imports)
export const repo = pg;

// Also re-export functions/types so callers can import directly if they prefer
export * from "./repo.pg";
export type { Challenge, Status } from "./repo.pg";
