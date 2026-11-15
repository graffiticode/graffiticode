// The admission and execution contract (spec RELEASE-01; capability plan W4),
// versioned apart from the registry. Version 2 binds a compile through a
// connection to an admitted plan: every stage of the chain pinned to an
// approved compiler revision, with its normalized program, source and options
// digests and the protected functions it may call. A token's `cv` says which
// contract its claims meet; consumers refuse versions they don't support, and
// below their configured minimum.

import { canonicalDigest } from "./canonical.js";

export const CONTRACT_VERSION = 2;
export const SUPPORTED_CONTRACT_VERSIONS = Object.freeze([1, 2]);

// Version 3 (docs/c5-l0013-commands-plan.md decision 6): a plan with any
// item-scoped intent, mixed L0013/L0176 chains included. The plan names its
// static scopes and holds a connection only if some intent needs one; an
// execution token selects exactly one scope. A connection-only plan stays
// version 2, byte for byte. Nothing issues version 3 yet, and it joins
// SUPPORTED_CONTRACT_VERSIONS only with the Broker and Policy releases that
// implement it (C5a slices 2 and 3).
export const CONTRACT_VERSION_SCOPED = 3;

// One stage of a chain as its compiler's preflight reports it (and as the
// plan pins it). `stage` is the gateway's name for its position (`s0` is the
// leftmost task).
export type StageManifest = {
  stage: string,
  lang: string,
  sourceDigest: string,
  programDigest: string,
  optionsDigest: string,
  revision: string,
  imageDigest: string,
  registryVersion: number,
  requiredFunctions: string[],
};

// What one intent, or one execution, is authorized against.
export type Scope =
  | { kind: "connection", id: string }
  | { kind: "item", id: string };

export type Plan = {
  contractVersion: 2,
  invocationId: string,
  taskIds: string[],
  connectionId: string,
  inputDigest: string,
  registryVersion: number,
  stages: StageManifest[],
};

// A v3 plan: `connectionId` only when some intent has a connection scope, and
// `scopes`, the static scopes (literal in the models), sorted and without
// duplicates, inside the digest. Scopes bound from data are recorded on their
// occurrences, never here.
export type ScopedPlan = {
  contractVersion: 3,
  invocationId: string,
  taskIds: string[],
  connectionId?: string,
  inputDigest: string,
  registryVersion: number,
  scopes: Scope[],
  stages: StageManifest[],
};

const SCOPE_ID = /^[A-Za-z0-9_:.-]{1,200}$/;

// What's wrong with a scope's shape (not its authority).
export const scopeProblems = (scope: unknown): string[] => {
  const s = scope as Record<string, unknown>;
  if (!s || typeof s !== "object" || Array.isArray(s)) return ["scope is not an object"];
  const problems: string[] = [];
  if (s.kind !== "connection" && s.kind !== "item") problems.push("kind");
  if (typeof s.id !== "string" || !SCOPE_ID.test(s.id)) problems.push("id");
  const extra = Object.keys(s).filter(k => k !== "kind" && k !== "id");
  if (extra.length) problems.push(`unknown fields: ${extra.sort().join(", ")}`);
  return problems;
};

// A scope's one string form, for keys and comparison.
export const scopeKey = (scope: Scope): string => `${scope.kind}:${scope.id}`;

// Scopes as a plan pins them: only `kind` and `id`, sorted by kind then id,
// each once.
export const canonicalScopes = (scopes: Scope[]): Scope[] => {
  const seen = new Map<string, Scope>();
  for (const s of scopes) {
    if (scopeProblems(s).length) throw new Error(`malformed scope: ${scopeProblems(s).join(", ")}`);
    seen.set(scopeKey(s), { kind: s.kind, id: s.id } as Scope);
  }
  return [...seen.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
};

const DIGEST = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
// A Cloud Run revision name.
const REVISION = /^[a-z][a-z0-9-]{0,62}$/;

// The fields of a stage manifest, checked for shape (not authority). Returns
// a list of what's wrong.
export const manifestProblems = (m: unknown, expectedStage?: string): string[] => {
  const s = m as Record<string, unknown>;
  if (!s || typeof s !== "object" || Array.isArray(s)) return ["manifest is not an object"];
  const problems: string[] = [];
  if (typeof s.stage !== "string" || !/^s\d{1,3}$/.test(s.stage) || (expectedStage !== undefined && s.stage !== expectedStage)) problems.push("stage");
  if (typeof s.lang !== "string" || !/^\d{4}$/.test(s.lang)) problems.push("lang");
  for (const field of ["sourceDigest", "programDigest", "optionsDigest"]) {
    if (typeof s[field] !== "string" || !DIGEST.test(s[field] as string)) problems.push(field);
  }
  if (typeof s.revision !== "string" || !REVISION.test(s.revision)) problems.push("revision");
  if (typeof s.imageDigest !== "string" || !IMAGE.test(s.imageDigest)) problems.push("imageDigest");
  if (!Number.isInteger(s.registryVersion)) problems.push("registryVersion");
  if (!Array.isArray(s.requiredFunctions) || !s.requiredFunctions.every(f => typeof f === "string" && f.length > 0) ||
      new Set(s.requiredFunctions).size !== s.requiredFunctions.length) problems.push("requiredFunctions");
  return problems;
};

// Only the manifest's own fields, functions sorted: what a plan pins.
export const pinnedStage = (m: StageManifest): StageManifest => ({
  stage: m.stage,
  lang: m.lang,
  sourceDigest: m.sourceDigest,
  programDigest: m.programDigest,
  optionsDigest: m.optionsDigest,
  revision: m.revision,
  imageDigest: m.imageDigest,
  registryVersion: m.registryVersion,
  requiredFunctions: [...m.requiredFunctions].sort(),
});

// The plan's identity: SHA-256 over its canonical JSON (the same
// canonicalization as argsDigest).
export const planDigest = (plan: Plan | ScopedPlan): string => canonicalDigest(plan);

// The stage binding a v2 session carries (`bind`), and that the compiler
// checks before it executes: everything the plan pins for its stage.
export const stageBinding = (m: StageManifest) => {
  const { stage: _stage, registryVersion: _rv, ...binding } = pinnedStage(m);
  return binding;
};
export const sameStage = (a: StageManifest, b: StageManifest): boolean =>
  canonicalDigest(pinnedStage(a)) === canonicalDigest(pinnedStage(b));
