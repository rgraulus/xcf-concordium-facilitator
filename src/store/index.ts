// src/store/index.ts
import * as pg from "./repo.pg";

// In future, you can switch by env (e.g., USE_INMEM=true) to a memory repo.
// For now, always export PG-backed repo.
export const repo = pg;
export type { Challenge, Status } from "./repo.pg";
