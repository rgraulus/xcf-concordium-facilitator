// jest.config.ts
import type { Config } from "jest";

const config: Config = {
  testEnvironment: "node",
  transform: { "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
  testMatch: ["**/test/**/*.test.ts"],
  moduleFileExtensions: ["ts", "tsx", "js", "json"],
  clearMocks: true,
  verbose: false,
};

export default config;
