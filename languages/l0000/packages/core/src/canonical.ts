// SPDX-License-Identifier: MIT
//
// The args digest that binds an execution token to one request. It MUST match
// the broker's computation byte for byte (graffiticode packages/broker
// src/canonical.js): SHA-256 over canonical JSON — object keys sorted,
// `undefined` members dropped, `undefined` array slots as null, no whitespace.
// The shared vectors in canonical.test.ts pin both sides.

import { createHash } from "crypto";

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJSON(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(",")}}`;
}

export function argsDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}
