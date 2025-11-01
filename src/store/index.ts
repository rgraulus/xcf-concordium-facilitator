// src/store/index.ts
import * as pg from "./repo.pg";

// Export the Postgres-backed repo (can add env-based switching later)
export const repo = pg;
export type { Challenge, Status } from "./repo.pg";

