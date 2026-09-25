// The args digest binds an execution token to one request. Both sides — the
// compiler that asks policy to mint, and the broker that executes — must
// compute it the same way: SHA-256 over canonical JSON (object keys sorted,
// `undefined` members dropped, no whitespace).

import { createHash } from "node:crypto";

export const canonicalJSON = value => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => (v === undefined ? "null" : canonicalJSON(v))).join(",")}]`;
  }
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(",")}}`;
};

export const argsDigest = value => createHash("sha256").update(canonicalJSON(value)).digest("hex");
