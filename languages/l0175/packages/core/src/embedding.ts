// SPDX-License-Identifier: MIT
// RAG embedding helpers for L0175.
//
// Imports the pure per-target data (no compiler) to resolve a (target, item type) pair to its
// task-model NUMBER, so the design signature carries a `task-model:<n>` facet a number-phrased
// query ("task model 3") can match.
//
// Why this exists: L0175 training examples (and live generation requests) embed the reading
// passage inside the natural-language prompt. When that prompt is fed to an embedding model the
// passage prose dominates the vector, so retrieval matches on passage topic ("tide pool",
// "bridges") instead of on item DESIGN (EBSR · character · rl-1 · error-typed distractors). These
// helpers produce a passage-free embedding text plus a passage-independent design signature.
//
// The split (see the console RAG pipeline that consumes this):
//   - embeddingText  → the prompt with the passage removed. This is what gets embedded, on BOTH
//                      the doc side (captured prompt) and the query side (live prompt), so the two
//                      vectors live in the same space.
//   - tags / facets  → a structured design signature derived from the generated code (the
//                      composed item). Stored as metadata, NOT mixed into the vector; the console
//                      uses the facets as a filter/boost at query time.
//
// This module is intentionally PURE — it takes an already-composed item (the output of
// `compiler.compile`) plus the raw prompt, and has no parser/compiler dependency of its own. The
// caller composes the program (the console already parses L0175; the core tests use the parser
// harness) and hands the composed data in.

import { TARGETS_DATA, targetForSkill, taskModelNumber } from "./targets.js";

// ---- Types -----------------------------------------------------------------------------------

export interface PassageRef {
  heading?: string;
  lines: string[];
}

export interface DesignFacets {
  target?: string; // c1-t4  (program-level, single)
  passageType?: string; // literary | informational (program-level, single)
  itemTypes?: string[]; // ebsr, hot-text, …
  taskModels?: string[]; // per-target task-model numbers ("3"), derived from target + item type
  dimensions?: string[];
  standards?: string[];
  doks?: string[];
}

export interface SignatureResult {
  tags: string[];
  facets: DesignFacets;
  normalizedStem: string;
}

export interface EmbeddingArtifacts {
  embeddingText: string;
  tags: string[];
  facets: DesignFacets;
  normalizedStem: string;
}

// `data` is whatever `compiler.compile` produced: a single composed item, or a `{kind:"items"}`
// envelope, or null. We normalize to a flat list of item records.
type ComposedData = any;

// ---- Small utilities -------------------------------------------------------------------------

const collapseWs = (s: string): string => s.replace(/\s+/g, " ").trim();

function toItems(data: ComposedData): any[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.kind === "items" && Array.isArray(data.items)) return data.items;
  if (data.kind === "item") return [data];
  // Be lenient: a bare item-shaped object with a type still works.
  if (data.type) return [data];
  return [];
}

// Escape a string for use as a literal inside a RegExp.
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function splitSentences(text: string): string[] {
  // Lightweight sentence split — good enough for prompt instructions. Keeps the delimiter off.
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- Passage stripping -----------------------------------------------------------------------

// Authoring-intent cues: words that mark the instruction part of a prompt (as opposed to the
// stimulus prose). Used by the query-side path that has no passage to subtract.
const INTENT_CUE =
  /\b(ebsr|evidence[-\s]?based|hot[-\s]?text|short[-\s]?(answer|text|response|constructed)|multiple[-\s]?choice|multi[-\s]?select|standard|dimension|dok|rl-\d|ri-\d|c1-t\d+|write|create|compose|generate|make|author|item|question|stem|distractor|inference|claim)\b/i;

/**
 * Remove the reading passage from a prompt, returning the design-intent text to embed.
 *
 * Doc side: pass `opts.passage` (heading + line paragraphs from the compiled item). Every
 * whitespace-normalized passage span is deleted from the prompt.
 *
 * Query side: omit `opts.passage`. We keep sentences that carry authoring-intent cues and, as a
 * fallback for cue-less prompts, drop the single longest paragraph (assumed to be the passage).
 */
export function stripReadingPassage(
  prompt: string,
  opts: { passage?: PassageRef } = {},
): string {
  if (!prompt) return "";

  if (opts.passage) {
    let out = collapseWs(prompt);
    const spans = [opts.passage.heading || "", ...(opts.passage.lines || [])]
      .map(collapseWs)
      .filter((s) => s.length > 0)
      // Remove longest first so a paragraph isn't partially consumed by a shorter substring.
      .sort((a, b) => b.length - a.length);
    for (const span of spans) {
      out = out.replace(new RegExp(reEscape(span), "gi"), " ");
    }
    // Tidy quotes/brackets left dangling around the removed prose.
    return collapseWs(out.replace(/["“”]{2,}/g, " ").replace(/\(\s*\)/g, " "));
  }

  // No passage available (query side): keep cue-bearing sentences.
  const sentences = splitSentences(collapseWs(prompt));
  const kept = sentences.filter((s) => INTENT_CUE.test(s));
  if (kept.length > 0) return collapseWs(kept.join(" "));

  // Fallback: drop the longest paragraph (likely the passage), keep the rest.
  const paras = prompt.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length > 1) {
    let longest = 0;
    for (let i = 1; i < paras.length; i++) if (paras[i].length > paras[longest].length) longest = i;
    return collapseWs(paras.filter((_, i) => i !== longest).join(" "));
  }
  return collapseWs(prompt);
}

// ---- Design signature (tags + facets) --------------------------------------------------------

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs.filter(Boolean)));
}

/**
 * Build the passage-free design signature from one or more composed items. The values are
 * re-projected straight off the compiler output — nothing is authored or inferred from prose.
 */
export function buildSignatureTags(
  data: ComposedData,
  opts: { subject?: string } = {},
): SignatureResult {
  const items = toItems(data);
  const tags = new Set<string>();
  const itemTypes: string[] = [];
  const taskModels: string[] = [];
  const dimensions: string[] = [];
  const standards: string[] = [];
  const doks: string[] = [];
  let target: string | undefined;
  let passageType: string | undefined;
  let normalizedStem = "";

  items.forEach((item, idx) => {
    if (item.type) { tags.add(`item:${item.type}`); itemTypes.push(item.type); }
    if (item.target) { tags.add(`target:${item.target}`); target = target || item.target; }
    if (item.target && item.type) {
      const n = taskModelNumber(item.target, item.type);
      if (n) { tags.add(`task-model:${n}`); taskModels.push(n); }
    }
    const ptype = item.passage && item.passage.type;
    if (ptype) { tags.add(`type:${ptype}`); passageType = passageType || ptype; }
    if (item.dimension) { tags.add(`dimension:${item.dimension}`); dimensions.push(item.dimension); }
    for (const s of item.standards || []) { tags.add(`standard:${s}`); standards.push(s); }
    if (item.dok) { tags.add(`dok:${item.dok}`); doks.push(item.dok); }
    tags.add(item.stem && item.stem.partB ? "shape:two-part" : "shape:single-part");
    for (const d of item.distractorAnalysis || []) {
      if (d && d.errorType) tags.add(`distractor:${d.errorType}`);
    }
    if (idx === 0) normalizedStem = normalizeStem(item, opts.subject);
  });

  return {
    tags: Array.from(tags),
    facets: {
      target,
      passageType,
      itemTypes: uniq(itemTypes),
      taskModels: uniq(taskModels),
      dimensions: uniq(dimensions),
      standards: uniq(standards),
      doks: uniq(doks),
    },
    normalizedStem,
  };
}

// Strip the passage-specific focus subject (e.g. "Mara") out of the stem so the design phrasing
// generalizes. Subject comes from the compiled item's review.correctClaim, or an explicit override.
function normalizeStem(item: any, subjectOverride?: string): string {
  const stem = item.stem || {};
  const parts = [stem.partA, stem.partB].filter(Boolean) as string[];
  let text = collapseWs(parts.join(" "));
  const subject = subjectOverride || (item.review && item.review.correctClaim && item.review.correctClaim.subject);
  if (subject) {
    text = text.replace(new RegExp(`\\b${reEscape(String(subject))}\\b`, "gi"), "the subject");
  }
  return text;
}

// ---- Query-side facet extraction -------------------------------------------------------------

const TARGET_LITERARY = /\b(short stor(?:y|ies)|stor(?:y|ies)|poem|poetry|literary|fable|folktale|myth|legend|drama|play|narrative)\b/i;
const TARGET_INFORMATIONAL = /\b(informational|nonfiction|non-fiction|article|essay|report|biograph(?:y|ies)|passage about|account|historical)\b/i;

const ITEM_TYPE_CUES: Array<[RegExp, string]> = [
  [/\bebsr\b|evidence[-\s]?based selected response/i, "ebsr"],
  [/\bhot[-\s]?text\b/i, "hot-text"],
  [/\bshort[-\s]?(answer|text|response|constructed)\b/i, "short-text"],
  [/\bmultiple[-\s]?choice\b/i, "multiple-choice"],
  [/\bmulti[-\s]?select\b/i, "multi-select"],
];

// Skill cues, MOST SPECIFIC FIRST — the order is the disambiguation. A prompt about a word's
// meaning is Word Meanings even though it also says "passage"; and a prompt naming the main idea is
// Central Ideas even though its Part B asks for a supporting detail. Reasoning & Evidence is last:
// its cues (infer, conclude, purpose) appear inside the other skills' phrasing too.
//
// KEY DETAILS vs REASONING & EVIDENCE is the hard pair, and the reason `key-details` is written
// the way it is. Both skills end in "find the line that supports it", so a cue keyed on supporting
// evidence — which is what this was — matches BOTH and, being earlier in the list, stole every
// T4/T11 prompt for T1/T8. That is not a cosmetic ranking error: facetAdjustment in the console
// (src/lib/lang-embedding.ts) treats a confident target mismatch as a HARD EXCLUSION, so a
// misread here removes the correct examples from retrieval entirely.
//
// What actually separates them is WHO SUPPLIES THE CONCLUSION, which is how targets.ts and the
// spec define them:
//   Key Details (T1/T8)          — the conclusion is HANDED to the student; the whole task is
//                                  finding the evidence for it. "Give students a conclusion ...
//                                  which line best supports it."
//   Reasoning & Evidence (T4/T11) — the student DERIVES the claim (a motive, a mood, a point of
//                                  view, how the author uses information) and then backs it up.
// So `key-details` now requires the handed-over frame, and Reasoning & Evidence carries the
// derive-it verbs. Prompts matching neither still fall through to the reasoning-evidence default,
// which is the safer of the two: it is the broadest skill.
const SKILL_CUES: Array<[RegExp, string]> = [
  // Word Meanings. The L-4 strategies each get a cue, because the dimension spans four of them
  // (context, roots and affixes, dictionary, word relationships) and a prompt naming only its
  // strategy — "using its Greek or Latin root", "a short dictionary definition", "words that mean
  // about the same" — otherwise matched nothing at all and fell through to a wrong target.
  [/\bword meanings?\b|\bwhat does\b[^.?!]{0,25}\bmeans?\b|\bmean(?:s|ing)?\b[^.?!]{0,30}\b(?:of|as used|in context|used|here)\b|\bvocabulary\b|\b(?:greek|latin)\b|\b(?:root|prefix|suffix|affix)e?s?\b|\bdictionary\b|\bsynonyms?\b|\bantonyms?\b|\bmean about the same\b/i, "word-meanings"],
  // `lesson`, `moral` and a bare `message` belong here as much as `theme` does — a fifth-grade
  // teacher asking "what's the lesson of this fable?" is asking for the theme. Requiring the
  // possessive in `author's message` missed the far commoner bare noun.
  [/\b(?:theme|central idea|main idea|summar(?:y|ize|izes|izing)|message|lesson|moral)\b/i, "central-ideas"],
  // The conclusion is GIVEN. Without this frame a supporting-evidence prompt is Reasoning &
  // Evidence, not Key Details. Two registers, and both are needed:
  //   authoring — "Give students a conclusion about X ... which line supports it" (examples.md)
  //   user      — "The article says X — which detail best supports that?" (the claim stated
  //               inline, then a pure evidence question). Matching only the authoring voice
  //               scores well on examples.md and still misroutes what a person actually types,
  //               which is the register the query side sees.
  // The `which <noun> <verb>` anchor is what keeps this off Reasoning & Evidence: T4/T11 phrase
  // the same evidence step without it ("then click the sentences that support it"), so requiring
  // an interrogative confines this to prompts whose WHOLE task is finding the evidence.
  [/\b(?:give|gives|given|giving|provide[sd]?|hand(?:s|ed)?|shows?)\s+(?:the\s+)?students?\b[^.?!]{0,40}\b(?:conclusion|inference|statement|claim|idea)\b|\bwhich\s+(?:\w+\s+){0,3}(?:detail|line|sentence|evidence|quotation|quote|fact|reason|example)s?\b[^.?!]{0,40}\b(?:supports?|proves?|backs?|shows?|demonstrates?)\b/i, "key-details"],
  // The student derives it: the verbs of reasoning, not of evidence-hunting. `work out`,
  // `determine` and `decide` are the same act as `figure out` and a teacher uses them
  // interchangeably; `writer` is as common as `author` for the same referent.
  [/\b(?:infer|inference|conclude|conclusion|point of view|purpose|motivation|motives?|opinion|figure out|work out|determine|decide|feels?|feelings?|reacts?|mood|relate)\b|\bhow (?:the )?(?:author|writer|narrator|two|characters?|setting)\b|\bwhat the (?:author|writer|narrator)\b/i, "reasoning-evidence"],
];

// Every known target id, longest-first so `c1-t1` cannot shadow `c1-t10`/`c1-t11`. Built from
// targets.ts so a new target is recognized in prompts the moment it is declared there.
const TARGET_ID_RE = new RegExp(
  `\\b(?:${Object.keys(TARGETS_DATA).sort((a, b) => b.length - a.length).join("|")})\\b`,
  "i",
);

/**
 * Best-effort facets from a raw prompt (the query side has no code). Only fields with a confident
 * cue are set, so the console can use them as a filter; absent fields fall back to vector ranking.
 */
export function extractQueryFacets(prompt: string): DesignFacets {
  const facets: DesignFacets = {};
  if (!prompt) return facets;

  // Explicit target wins over prose cues. Both the id set and each target's text type come from
  // targets.ts, so adding a target does not silently leave its id unrecognized here.
  const explicitTarget = prompt.match(TARGET_ID_RE);
  if (explicitTarget) {
    const id = explicitTarget[0].toLowerCase();
    facets.target = id;
    facets.passageType = TARGETS_DATA[id].textType;
  } else {
    // No id named: route on the same two axes the spec's routing table uses — the SKILL asked and
    // the TEXT TYPE. An RL/RI standard is the strongest text-type cue; otherwise a genre word.
    const rl = /\brl-\d\b/i.test(prompt);
    const ri = /\bri-\d\b/i.test(prompt);
    const textType = rl || TARGET_LITERARY.test(prompt) ? "literary"
      : ri || TARGET_INFORMATIONAL.test(prompt) ? "informational"
      : undefined;
    const skill = SKILL_CUES.find(([re]) => re.test(prompt))?.[1];
    // Skill + text type resolves exactly; a skill alone still resolves (literary preferred).
    const hit = skill ? targetForSkill(skill, textType) : undefined;
    // With a text type but no skill cue, fall back to Reasoning & Evidence for that type — the
    // broadest skill, and the historical default.
    const chosen = hit ?? (textType ? targetForSkill("reasoning-evidence", textType) : undefined);
    if (chosen) {
      facets.target = chosen.id;
      // Prefer a text type the prompt actually stated over the chosen target's own.
      facets.passageType = textType ?? chosen.textType;
    }
  }

  const itemTypes = ITEM_TYPE_CUES.filter(([re]) => re.test(prompt)).map(([, t]) => t);
  if (itemTypes.length) facets.itemTypes = itemTypes;

  // Task model: an explicit number in the prompt ("task model 3", "TM3") wins; otherwise derive it
  // from the target + item type. The number is per-target, so it only disambiguates alongside the
  // target facet — which is exactly the c1-t9-tm3-means-EBSR case.
  const explicitTm = prompt.match(/\b(?:tm|task[-\s]?model)\s*[-:]?\s*(\d)\b/i);
  if (explicitTm) {
    facets.taskModels = [explicitTm[1]];
  } else if (facets.target && itemTypes.length) {
    const tms = uniq(itemTypes.map((t) => taskModelNumber(facets.target as string, t)).filter(Boolean) as string[]);
    if (tms.length) facets.taskModels = tms;
  }

  const stds = uniq((prompt.match(/\br[li]-\d\b/gi) || []).map((s) => s.toLowerCase()));
  if (stds.length) facets.standards = stds;

  return facets;
}

// ---- Signature from source code --------------------------------------------------------------

// The L0175 surface syntax is flat, kebab-case tagged content, so the design signature can be read
// straight off the generated `code` with no parser/compiler. This is the path the console RAG
// pipeline uses: its scripts hold the program SOURCE (not a composed item), and it avoids wiring a
// compiler into an offline batch job. (Selection nuances the compiler applies — which distractors
// it picks, companion standards — aren't reflected; for facet filtering the authored vocabulary is
// what matters.)

const matchAll = (code: string, re: RegExp): string[] =>
  Array.from(code.matchAll(re), (m) => m[1]).filter(Boolean);

function passageFromSource(code: string): PassageRef | undefined {
  const heading = (code.match(/\bpassage\s+"((?:[^"\\]|\\.)*)"/) || [])[1];
  const linesBlock = (code.match(/\blines\s*\[([\s\S]*?)\]/) || [])[1] || "";
  const lines = matchAll(linesBlock, /"((?:[^"\\]|\\.)*)"/g);
  if (!heading && lines.length === 0) return undefined;
  return { heading, lines };
}

/** Design signature read directly from L0175 program source. */
export function buildSignatureFromSource(code: string): SignatureResult {
  const tags = new Set<string>();
  const facets: DesignFacets = {};

  const target = (code.match(/\btarget\s+(c1-t\d+)/) || [])[1];
  if (target) { tags.add(`target:${target}`); facets.target = target; }
  const ptype = (code.match(/\btype\s+(literary|informational)\b/) || [])[1];
  if (ptype) { tags.add(`type:${ptype}`); facets.passageType = ptype; }

  const itemTypes = uniq(matchAll(code, /\btype\s+(ebsr|hot-text|short-text|multiple-choice|multi-select)\b/g));
  itemTypes.forEach((t) => tags.add(`item:${t}`));
  if (itemTypes.length) facets.itemTypes = itemTypes;

  // Task-model numbers, derived from target + item type (per-target, so the target is required).
  if (target) {
    const taskModels = uniq(itemTypes.map((t) => taskModelNumber(target, t)).filter(Boolean) as string[]);
    taskModels.forEach((n) => tags.add(`task-model:${n}`));
    if (taskModels.length) facets.taskModels = taskModels;
  }

  const dimensions = uniq(matchAll(code, /\bdimension\s+([a-z][a-z0-9-]*)/g));
  dimensions.forEach((d) => tags.add(`dimension:${d}`));
  if (dimensions.length) facets.dimensions = dimensions;

  const standards = uniq(matchAll(code, /\bstandard\s+(r[li]-\d+)/g));
  standards.forEach((s) => tags.add(`standard:${s}`));
  if (standards.length) facets.standards = standards;

  const doks = uniq(matchAll(code, /\bdok\s+(r-dok\d+)/g));
  doks.forEach((d) => tags.add(`dok:${d}`));
  if (doks.length) facets.doks = doks;

  uniq(matchAll(code, /\berror-type\s+([a-z][a-z0-9-]*)/g)).forEach((e) => tags.add(`distractor:${e}`));

  // Two-part if any outcome has a stem-b (EBSR) or is hot-text; else single-part.
  tags.add(/\bstem-b\b/.test(code) || itemTypes.includes("hot-text") ? "shape:two-part" : "shape:single-part");

  const stemA = (code.match(/\bstem\s+"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
  const stemB = (code.match(/\bstem-b\s+"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
  const subject = (code.match(/\bsubject\s+"((?:[^"\\]|\\.)*)"/) || [])[1];
  let normalizedStem = collapseWs([stemA, stemB].filter(Boolean).join(" "));
  if (subject) normalizedStem = normalizedStem.replace(new RegExp(`\\b${reEscape(subject)}\\b`, "gi"), "the subject");

  return { tags: Array.from(tags), facets, normalizedStem };
}

// ---- Doc-side convenience --------------------------------------------------------------------

/**
 * Doc-side artifacts for one captured example: a passage-free `embeddingText` (to embed) plus the
 * design `tags`/`facets` (metadata). Pass `code` (the generated program source — the console's
 * path, no compiler needed) and/or `data` (a composed program from `compiler.compile`). `prompt`
 * is the captured natural-language request.
 */
export function buildEmbeddingArtifacts(
  { prompt, data, code, subject }: { prompt: string; data?: ComposedData; code?: string; subject?: string },
): EmbeddingArtifacts {
  let passage: PassageRef | undefined;
  let sig: SignatureResult;

  if (data != null && toItems(data).length > 0) {
    const first = toItems(data)[0];
    passage = first && first.passage
      ? { heading: first.passage.heading, lines: (first.passage.lines || []).map((l: any) => (typeof l === "string" ? l : l.text)) }
      : undefined;
    sig = buildSignatureTags(data, { subject });
  } else {
    passage = code ? passageFromSource(code) : undefined;
    sig = code ? buildSignatureFromSource(code) : { tags: [], facets: {}, normalizedStem: "" };
  }

  const embeddingText = stripReadingPassage(prompt, passage ? { passage } : {});
  return { embeddingText, tags: sig.tags, facets: sig.facets, normalizedStem: sig.normalizedStem };
}
