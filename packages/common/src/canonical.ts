/* eslint-disable camelcase -- a vector carries a Learnosity wire field */
// Canonical JSON and its digest, the one definition every component uses when
// a hash must agree across services (spec TOKEN-01, ARTIFACT-01): the args
// digest that binds an execution token to one request (compiler, Policy and
// Broker), and the content digest that makes a private artifact immutable
// (gateway). Object keys sorted, `undefined` members dropped, `undefined`
// array slots as null, no whitespace; SHA-256 hex over the UTF-8 text.
//
// CANONICAL_VECTORS pins the encoding. Every implementation, including the
// TypeScript copy in languages/l0000 (packages/core/src/canonical.ts, whose
// tests carry the first four vectors), must reproduce them exactly.

import { createHash } from "node:crypto";

export const canonicalJSON = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => (v === undefined ? "null" : canonicalJSON(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(",")}}`;
};

export const canonicalDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJSON(value)).digest("hex");

// [value, canonical JSON, digest]
export const CANONICAL_VECTORS: ReadonlyArray<readonly [unknown, string, string]> = Object.freeze([
  [{ b: 2, a: 1 }, "{\"a\":1,\"b\":2}", "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"],
  [
    { questions: [{ response_id: "q-0", type: "mcq", stimulus: "Q é \"x\"" }], id: "t", skip: undefined },
    "{\"id\":\"t\",\"questions\":[{\"response_id\":\"q-0\",\"stimulus\":\"Q é \\\"x\\\"\",\"type\":\"mcq\"}]}",
    "d5e95bc25861c09b8ddb35843b33f3d27aeef4f5a3853d8133c21897a9143e4b",
  ],
  [[1, "two", null, undefined, { z: [true, false], y: 1.5 }], "[1,\"two\",null,null,{\"y\":1.5,\"z\":[true,false]}]",
    "2f51203a604c465370f084c3f413c5ce3f11bd736f1507cb2a6b96b1d46e632d"],
  ["plain", "\"plain\"", "945603a8f587786b463c3f94fce115c0fae88fac2728cc96ddf5981cf7f61741"],
  // An artifact's content: a compile envelope.
  [
    { data: { type: "questions", data: { itemBank: { saved: true, references: ["graffiticode-t-0"] } } }, errors: [] },
    "{\"data\":{\"data\":{\"itemBank\":{\"references\":[\"graffiticode-t-0\"],\"saved\":true}},\"type\":\"questions\"},\"errors\":[]}",
    "d5878057449f4231395e16ce6dfa6837b785cef4eeaeaffec47f87f18c401fd9",
  ],
  // Edges: an empty key, U+2028 kept literal, -0 as 0, exponent form.
  [{ "": { "\u2028": [{}, [], 0, -0, 1e21] } }, "{\"\":{\"\u2028\":[{},[],0,0,1e+21]}}",
    "1a91f0a4878b55e1f0f238c8ac4f15a3a9918674077ad0b2b2bb3947f442e4a2"],
] as const);
