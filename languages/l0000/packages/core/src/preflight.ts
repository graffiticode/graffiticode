// SPDX-License-Identifier: MIT
//
// Preflight (capability plan W4; spec ADMIT-01, API-01): what one stage of a
// chain will do, decided before any stage executes and without executing
// anything. The gateway collects a manifest from every stage's compiler and
// asks policy for one decision; the plan it admits pins each stage, and the
// compiler checks itself against that pin before it executes (ADMIT-03).
//
// A manifest:
//   stage           the gateway's name for the stage's position (s0 leftmost)
//   lang            the compiler's language
//   sourceDigest    the program as stored (the gateway checks it against the
//                   task it loaded)
//   programDigest   the program after the language's normalization (L0176's
//                   legacy save lowering), which is what executes
//   optionsDigest   the compile options
//   revision        the running Cloud Run revision (K_REVISION)
//   imageDigest     the image it runs (GC_IMAGE_DIGEST, set by the deploy CLI)
//   registryVersion the registry version the language's declarations were
//                   written for; 0 for a language with none
//   requiredFunctions every protected function the program can reach: every
//                   explicit node, dead code included, plus implicit ones
//
// All digests are SHA-256 over the canonical JSON every component shares.

import { argsDigest } from "./canonical.js";
import { findProtectedNodes } from "./protected-functions.js";
import type { ProtectedFunctions, ProtectedFunctionSpec } from "./protected-functions.js";

export interface StageManifest {
  stage: string;
  lang: string;
  sourceDigest: string;
  programDigest: string;
  optionsDigest: string;
  revision: string;
  imageDigest: string;
  registryVersion: number;
  requiredFunctions: string[];
}

// The fields a plan's stage binding (`bind`, carried in the session) pins.
export const BINDING_FIELDS = Object.freeze([
  "lang", "sourceDigest", "programDigest", "optionsDigest", "revision", "imageDigest", "requiredFunctions",
] as const);

export const digestOf = (value: unknown): string => argsDigest(value);

// Every protected function a program can reach, by static scan: each explicit
// protected node, reachable or not, and each implicit function the language
// requires of every compile. Sorted, each once.
export function requiredProtectedFunctions(
  nodePool: any,
  protectedFunctions: ProtectedFunctions = {},
  implicit: ProtectedFunctionSpec[] = [],
): string[] {
  const fns = new Set<string>(implicit.map(spec => spec.fn));
  for (const { spec } of findProtectedNodes(nodePool, protectedFunctions)) fns.add(spec.fn);
  return [...fns].sort();
}

// This revision's identity, as deployed. Missing outside Cloud Run (or from a
// revision the deploy CLI didn't release), in which case nothing can be
// pinned to it.
export const revisionIdentity = (env: Record<string, string | undefined> = process.env) => ({
  revision: env.K_REVISION ?? null,
  imageDigest: env.GC_IMAGE_DIGEST ?? null,
});

// Where a session's binding and this stage's own manifest disagree. Empty
// means the compiler may execute what the plan admitted.
export function bindingProblems(bind: any, manifest: StageManifest): string[] {
  if (!bind || typeof bind !== "object") return ["binding"];
  return BINDING_FIELDS.filter(field => {
    const expected = field === "requiredFunctions" ? [...manifest.requiredFunctions].sort() : manifest[field];
    const actual = field === "requiredFunctions" && Array.isArray(bind[field]) ? [...bind[field]].sort() : bind[field];
    return JSON.stringify(actual) !== JSON.stringify(expected);
  });
}
