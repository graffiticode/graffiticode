// SPDX-License-Identifier: MIT
// A verification GATE for RAG example data. It does NOT map prompt→code (that stays with the
// generator + human refinement); it inspects whatever code an example already carries and checks
// only the machine-decidable properties, so it composes with a human-in-the-loop workflow.
//
// Two tiers:
//   - BLOCKING  — objective failures that must keep an example out of the corpus: it must compile
//                 clean, and its composed design signature (target / item type / task model /
//                 dimension / standard) must match the example's declared intent. Task-model checks
//                 read ./targets.ts (the single source of truth), NOT instructions.md — so the gate
//                 is independent of the docs a bootstrap run was seeded from.
//   - ADVISORY  — compiler warnings (thin distractor pool, A↔B giveaway, above-grade reading) that a
//                 human should judge, surfaced but not fatal.
//
// The gate guards BOTH sides of the human: run it after bootstrap AND after hand-refinement.
import { buildSignatureTags, buildSignatureFromSource, type DesignFacets } from "./embedding.js";
import { TARGETS_DATA, taskModelNumber } from "./targets.js";

export interface ExampleExpectation {
  target: string; // required — the program's learning target, e.g. "c1-t9"
  taskModel?: string; // "tm3" or "3" — resolved against the target's table
  itemType?: string; // "ebsr" — provide taskModel and/or itemType (they're cross-checked)
  dimension?: string;
  standard?: string;
}

export interface VerifyResult {
  ok: boolean; // true iff there are no blocking failures
  blocking: string[]; // objective failures — an example with any of these must not enter the corpus
  advisory: string[]; // compiler warnings surfaced for human review (do not block)
  facets: DesignFacets; // the design signature actually composed, for logging/inspection
}

// Accept "tm3" or "3"; return both the table key and the bare number.
function normalizeTaskModel(s: string): { key: string; num: string } {
  const num = String(s).toLowerCase().replace(/^tm/, "");
  return { key: `tm${num}`, num };
}

/**
 * Verify one example against its declared expectation. Pure: the caller supplies the compile result
 * (`errors`, `data`) — parsing/compiling lives at the call site (the parser is not a core dep). Pass
 * `data` (a composed program from `compiler.compile`) for the authoritative signature; `code` alone
 * falls back to the source-derived signature.
 */
export function verifyExample(input: {
  errors: any[];
  data?: any;
  code?: string;
  expect: ExampleExpectation;
}): VerifyResult {
  const { errors, data, code, expect } = input;
  const blocking: string[] = [];
  const advisory: string[] = [];

  // 1. Must compile clean — any hard error is blocking.
  for (const e of errors || []) blocking.push(`compile error: ${e?.message ?? String(e)}`);

  // 2. Signature — prefer the composed data; fall back to source.
  const sig = data != null ? buildSignatureTags(data) : buildSignatureFromSource(code || "");
  const facets = sig.facets;

  const target = expect.target;
  const profile = TARGETS_DATA[target];
  if (!profile) {
    blocking.push(`unknown expected target '${target}'`);
    return { ok: blocking.length === 0, blocking, advisory, facets };
  }

  // Resolve the expected item type / task-model number from whatever the expectation provided, and
  // cross-check them when both are given.
  const expTm = expect.taskModel ? normalizeTaskModel(expect.taskModel) : undefined;
  let expItemType = expect.itemType;
  if (!expItemType && expTm) expItemType = profile.taskModels[expTm.key];
  const expTmNum = expTm?.num ?? (expItemType ? taskModelNumber(target, expItemType) : undefined);
  if (expect.itemType && expTm && profile.taskModels[expTm.key] !== expect.itemType) {
    blocking.push(
      `expectation is inconsistent: ${expTm.key} is '${profile.taskModels[expTm.key] ?? "n/a"}' for ${target}, not '${expect.itemType}'`,
    );
  }
  if (expTm && !profile.taskModels[expTm.key]) {
    blocking.push(`task model '${expTm.key}' is not available for target ${target}`);
  }

  // 3. Composed signature must match the declared intent.
  if (facets.target !== target) {
    blocking.push(`target: expected ${target}, composed ${facets.target ?? "none"}`);
  }
  const gotTypes = facets.itemTypes || [];
  if (expItemType && !(gotTypes.length === 1 && gotTypes[0] === expItemType)) {
    blocking.push(`item type: expected exactly [${expItemType}], composed [${gotTypes.join(", ") || "none"}]`);
  }
  if (expTmNum && !(facets.taskModels || []).includes(expTmNum)) {
    blocking.push(`task model: expected tm${expTmNum}, composed task-model(s) [${(facets.taskModels || []).join(", ") || "none"}]`);
  }
  if (expect.dimension && !(facets.dimensions || []).includes(expect.dimension)) {
    blocking.push(`dimension: expected ${expect.dimension}, composed [${(facets.dimensions || []).join(", ") || "none"}]`);
  }
  if (expect.standard && !(facets.standards || []).includes(expect.standard)) {
    blocking.push(`standard: expected ${expect.standard}, composed [${(facets.standards || []).join(", ") || "none"}]`);
  }

  // 4. Compiler warnings → advisory (a human decides). Warnings ride on each composed item.
  const items = data == null ? [] : Array.isArray(data) ? data : data.kind === "items" ? data.items : [data];
  for (const it of items) for (const w of (it && it.warnings) || []) advisory.push(w);

  return { ok: blocking.length === 0, blocking, advisory, facets };
}
