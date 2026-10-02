// Jest settings for this package. JavaScript runs as it always has; the .ts
// transform (@swc/jest, transpile only: tsc does the type checking) and the
// .js -> .ts resolver only take effect once a file is converted (TS migration
// phase 3).
import { fileURLToPath } from "node:url";

export default {
  transform: {
    "^.+\\.ts$": ["@swc/jest", { jsc: { parser: { syntax: "typescript" }, target: "es2022" }, module: { type: "es6" } }],
    "^.+\\.[cm]?js$": "babel-jest",
  },
  extensionsToTreatAsEsm: [".ts"],
  resolver: fileURLToPath(new URL("../../scripts/jest-ts-resolver.cjs", import.meta.url)),
};
