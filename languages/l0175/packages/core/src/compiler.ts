// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// L0175 — a content-composition language for 5th-grade ELA assessment items
// (Smarter Balanced · Grade 5 · Claim 1 · Target 4: Reasoning & Evidence).
//
// A program authors an inline SUPERSET of tagged content for a literary passage —
// candidate inference/conclusion `claim`s and evidence `source`s, each tagged — plus one
// or more `outcome`s. The overridden PROG runs a deterministic COMPOSE that selects, per
// outcome, the subset of content that best fits and assembles a finished item.
//
// The authoring surface is the l0169 builder idiom; see lexicon.ts. The Transformer's
// attribute/collection/element handlers reconstruct plain records (L0000's deepConvertRecords
// supports `{ ...record, key: v0 }`), and PROG reads them as plain props and composes.
//
// Validation: enum membership + required fields are HARD errors (pushed into the error array,
// failing the compile, per the Compiler pipeline). Selection compromises (missing id refs,
// thin distractor pools, unsatisfiable outcomes, hot-text ambiguity) are non-fatal WARNINGS
// carried in each item's `warnings`.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";
import { TARGETS_DATA, STANDARD_FAMILIES, type TargetData } from "./targets.js";

// ---------------------------------------------------------------------------
// Enumerations (the closed vocabularies; bare kebab identifiers resolve to these strings).
// ---------------------------------------------------------------------------
const PASSAGE_TYPES = new Set(["literary", "informational"]);
const CLAIM_STATUS = new Set(["supported", "distractor"]);
const SOURCE_STATUS = new Set(["directly-supports", "supports-wrong-claim", "irrelevant"]);
// The per-target structure (item/task models, standards families, dimensions, error taxonomies,
// dimension→standard maps) is the SINGLE SOURCE OF TRUTH in ./targets.ts. `TARGETS` below is built
// from it; `ITEM_TYPES` is the union of every target's allowed types (derived, not hand-listed).

// Small prior on distractor temptingness by error type. Used by the computed plausibility score;
// author `plausibility` overrides it. Unlisted types default to 0.
const ERROR_TYPE_PRIOR: Record<string, number> = {
  "faulty-reasoning": 0.1, "erroneous-inference": 0.08, "misreads-detail": 0.05,
  "too-narrow": 0.1, "too-broad": 0.07, "insignificant": 0.05,
};

// Hand-tuned thresholds — located here for later calibration (the IRT/response-data track in
// the backlog would replace these and the plausibility weights with learned values).
const TUNING = {
  MIN_VIABLE_DISTRACTORS: 5, // below this, warn — a richer Part A pool gives selection real choice
  MIN_VIABLE_PART_B: 5, // below this many Part B foil sources, warn (item draws 3 of them)
  DISTRACTOR_SLOTS: 3, // foils chosen per item (Part A or Part B)
  PART_OPTIONS: 4, // options per part (EBSR Part A/B) and Multiple Choice
  MULTI_SELECT_OPTIONS: 6, // total options for Multi-Select (correct set + distractors)
  HOT_TEXT_SELECT_MAX: 3, // absolute cap on Part B sentence selections (per-item cap is min(this, validCount - 1))
  SHORT_TEXT_MIN_LINES: 3, // fewer than 3 passage paragraphs → warn (a constructed response wants a substantial passage)
  LENGTH_BALANCE_RATIO: 1.35, // correct option longer than this × the mean distractor length → length-giveaway warn
  GRADE_LEVEL_TOLERANCE: 1.5, // passage reading level may run up to this many grades above target before we warn
  STEM_GIVEAWAY_RATIO: 0.5, // Part A stem shares ≥ this fraction of the correct option's content words → giveaway warn
  STEM_GIVEAWAY_MIN: 4, // …and at least this many shared content words (ignore tiny overlaps)
};

// --- Target profiles -----------------------------------------------------------------------
// L0175 is one language parameterized over SBAC learning targets. The engine (task models,
// error types, statuses, DOK, TUNING, all composition/validation) is target-INVARIANT; only the
// vocabulary differs per target: expected text type, the standards set, the dimension/about
// taxonomy, and the dimension→companion-standard map. A program selects its target with a
// required top-level `target` attribute; the matching profile parameterizes validation and
// `standardsFor`. Stems live in the served catalog (stems.md), authored per target.
type TargetProfile = {
  id: string;            // the `target` tag, e.g. "c1-t4"
  label: string;
  grade: number;         // the guideline's grade band — the default reading-level target (overridable by a top-level `grade`)
  textType: string;      // expected passage type for this target
  baseStandard: string;  // always added by standardsFor (the cite-evidence standard)
  defaultDok: string;    // DOK for this target's selected-response items (short-text bumps to r-dok3)
  // What the answer options are made of: "statement" → the options are claims the student chooses
  // among (T4/T11/T9); "evidence" → the inference is GIVEN in the stem and the options are passage
  // sources the student selects as support (T8 Key Details); "meaning" → the options are the
  // candidate meanings of a targeted `word` (T10 Word Meanings).
  answerKind: "statement" | "evidence" | "meaning";
  // Hot Text shape: true → single-part (click the supporting / main-idea sentences; the authored
  // stem is the whole instruction). Only Reasoning & Evidence pairs Hot Text with a statement Part A
  // (two-part), so T4/T11 are false; T8 (Key Details) and T9 (Central Ideas) are true.
  singlePartHotText: boolean;
  // Per-target task-model numbering → item type (e.g. T9 tm3 → "ebsr"). Numbers are PER-TARGET and
  // collide across targets, so the compiler resolves an authored `task-model` against THIS map.
  taskModels: Record<string, string>;
  itemTypes: Set<string>; // the item types this target allows (derived from taskModels values)
  standards: Set<string>;
  dimensions: Set<string>;
  errorTypes: string[];  // the distractor taxonomy for this target (ordered for coverage selection)
  dimStandard: Record<string, string>; // dimension → companion standard
};

// Build a runtime profile from the JSON-shaped source data in ./targets.ts: expand the standard
// families to their codes, and derive the allowed item-type set from the task-model values (so the
// numbering and the allowed set can never disagree).
function buildProfile(d: TargetData): TargetProfile {
  return {
    id: d.id,
    label: d.label,
    grade: d.grade,
    textType: d.textType,
    baseStandard: d.baseStandard,
    defaultDok: d.defaultDok,
    answerKind: d.answerKind,
    singlePartHotText: d.singlePartHotText,
    taskModels: d.taskModels,
    itemTypes: new Set(Object.values(d.taskModels)),
    standards: new Set(d.standards.flatMap((f) => STANDARD_FAMILIES[f])),
    dimensions: new Set(d.dimensions),
    errorTypes: d.errorTypes,
    dimStandard: d.dimStandard,
  };
}

const TARGETS: Record<string, TargetProfile> = Object.fromEntries(
  Object.entries(TARGETS_DATA).map(([id, d]) => [id, buildProfile(d)]),
);

// The global set of valid item types = the union of every target's allowed types (derived, not
// hand-listed, so adding a target's item type here is impossible to forget).
const ITEM_TYPES = new Set(
  Object.values(TARGETS).flatMap((p) => [...p.itemTypes]),
);
const DEFAULT_TARGET = "c1-t4"; // best-effort fallback when `target` is missing/unknown (still a hard error)

// --- Stems (Smarter Balanced · Grade 5 · Claim 1 · Target 4) --------------------------------
// Stems are AUTHORED, not generated: the upstream code generator instantiates the guideline's
// "Appropriate Stems" catalog (spec/stems.md) and emits each item's `stem` (and `stem-b` on
// EBSR) on the outcome. The compiler trusts the authored text — it does not synthesize stems.
// The lead-in below is not per-item question text. The Hot-Text Part B instruction is synthesized
// per item from the selection cap (Hot Text has no authored Part B stem) — see hotTextPartB.
const LEAD_IN = "This question has two parts. First, answer Part A. Then, answer Part B.";
const HOT_TEXT_PART_B_PLACEHOLDER = "Click the sentence(s) from the passage that support your answer in Part A.";

// Hot Text Part B asks for an EXACT number of supporting sentences (the per-item count). The
// student must pick exactly `count`; any selection of that many drawn from the valid set is
// correct (composeOutcome).
function hotTextPartB(count: number): string {
  return count <= 1
    ? "Click 1 sentence from the passage that supports your answer in Part A."
    : `Click ${count} sentences from the passage that support your answer in Part A.`;
}

const DEFAULT_RUBRIC = [
  { score: 2, descriptor: "Makes a valid inference and supports it with specific, relevant details from the passage." },
  { score: 1, descriptor: "Makes a partially valid inference, or supports it with limited or only partially relevant details." },
  { score: 0, descriptor: "Does not make a valid inference, or provides no relevant textual support." },
];

// ---------------------------------------------------------------------------
// Builder attribute handlers — generated below. Each is arity-2 (value, continuation) and
// merges one key into the continuation record. ERROR_TYPE stores under the JS-friendly key.
// ---------------------------------------------------------------------------
// Per-element source coordinate, stamped onto the element record by the wrappers. A Symbol
// key keeps it out of Object.entries → it never reaches deepConvertRecords / the output.
const COORD = Symbol("coord");
const coordOf = (x: any): any => (x && x[COORD]) || {};

const ATTR_KEYS: Record<string, string> = {
  ID: "id", STATUS: "status", DIMENSION: "dimension", ERROR_TYPE: "errorType",
  TEXT: "text", RATIONALE: "rationale", CITES: "cites", TARGETS: "targets",
  LINE: "line", QUOTE: "quote",
  SUPPORTS: "supports", TYPE: "type", TASK_MODEL: "taskModel", SUBJECT: "subject", STANDARD: "standard",
  FOCUS: "focus", PASSAGE: "passage", LINES: "lines", TITLE: "title", TARGET: "target", GRADE: "grade", STEM: "stem",
  RUBRIC: "rubric", DOK: "dok", PLAUSIBILITY: "plausibility", MODE: "mode", OTHER: "other",
  STEM_B: "stemB", SCORE: "score", DESCRIPTOR: "descriptor",
  CLAIMS: "claims", EVIDENCE: "evidence", OUTCOMES: "outcomes",
  WORDS: "words", MEANINGS: "meanings", // T10 (Word Meanings)
};

export class Checker extends BaseChecker {
  [key: string]: any;
  // Every L0175 tag falls through to L0000's CATCH_ALL (returns the node, no error), so the
  // Checker passes our custom forms cleanly; semantic validation runs in the Transformer
  // where the assembled records are readable as plain props.
}

export class Transformer extends BaseTransformer {
  [key: string]: any;

  constructor(code: any) {
    super(code);
    // Attribute & collection builders: { ...continuation, key: value }.
    for (const [tag, key] of Object.entries(ATTR_KEYS)) {
      this[tag] = (node: any, options: any, resume: any) => {
        this.visit(node.elts[0], options, (e0: any, v0: any) => {
          this.visit(node.elts[1], options, (e1: any, v1: any) => {
            const base = isPlain(v1) ? v1 : {};
            resume([].concat(e0).concat(e1), { ...base, [key]: v0 });
          });
        });
      };
    }
    // Element wrappers: pass the assembled attribute-chain record through, stamping the
    // element's source coord (Symbol key, so it never leaks into output) for error highlighting.
    for (const tag of ["CLAIM", "SOURCE", "OUTCOME", "BAND", "WORD", "MEANING"]) {
      this[tag] = (node: any, options: any, resume: any) => {
        this.visit(node.elts[0], options, (e0: any, v0: any) => {
          if (v0 && typeof v0 === "object") v0[COORD] = node.coord ?? this.nodePool[node.elts[0]]?.coord;
          resume(e0, v0);
        });
      };
    }
  }

  PROG(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const errors: any[] = [].concat(e0 || []);
      const top = Array.isArray(v0) ? v0[v0.length - 1] : v0;
      const out = composeProgram(top || {}, errors);
      resume(errors, out);
    });
  }
}

export const compiler = new Compiler({
  langID: "0175",
  version: "v0.0.1",
  Checker,
  Transformer,
});

// ===========================================================================
// Composition (pure, deterministic — no LLM). A future error-transform pass (swap-referent,
// overgeneralize, ...) would slot in where distractor claims are gathered.
// ===========================================================================

function isPlain(v: any): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function str(v: any): string {
  // Enum values may arrive as a bare lexeme string (IDENT fallback) or, when registered as
  // tags, as a { tag } object — normalize both to the plain string.
  if (v && typeof v === "object" && typeof v.tag === "string") return v.tag;
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function slug(s: string): string {
  return str(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "p";
}

function composeProgram(top: any, errors: any[]): any {
  // Resolve the learning target first — it parameterizes validation and standards. `target` is
  // required; when missing/unknown we record a hard error but fall back to a profile so the rest
  // of composition still runs (best-effort, like a missing `focus`).
  const targetTag = str(top.target);
  const profile = TARGETS[targetTag] || TARGETS[DEFAULT_TARGET];
  // Resolve the grade: an explicit top-level `grade` (from the user's prompt) wins; otherwise use
  // the guideline's grade carried on the target profile. Drives the reading-level guard below.
  const grade = Number(top.grade) > 0 ? Number(top.grade) : profile.grade;
  const heading = str(top.passage);
  const passageType = top.type !== undefined ? str(top.type) : profile.textType;
  const lineTexts: string[] = Array.isArray(top.lines) ? top.lines.map(str) : [];
  const claims: any[] = Array.isArray(top.claims) ? top.claims : [];
  const sources: any[] = Array.isArray(top.evidence) ? top.evidence : [];
  const words: any[] = Array.isArray(top.words) ? top.words : []; // T10 targeted words
  const outcomes: any[] = Array.isArray(top.outcomes) ? top.outcomes : [];

  // --- hard validation (fails the compile) ---
  // `target` should be authored explicitly (the instructions tell the generator to always pick
  // one), but an OMITTED target defaults to c1-t4 with a warning rather than a hard error — so
  // minimal/template generation and legacy programs still compile. An explicit but UNKNOWN tag is
  // a genuine mistake and stays a hard error.
  if (targetTag && !TARGETS[targetTag]) {
    errors.push({ message: `unknown target '${targetTag}'. Expected one of: ${Object.keys(TARGETS).join(", ")}.` });
  }
  if (passageType && !PASSAGE_TYPES.has(passageType)) {
    errors.push({ message: `Unknown passage type '${passageType}'. Expected one of: ${[...PASSAGE_TYPES].join(", ")}.` });
  }
  if (lineTexts.length === 0) {
    errors.push({ message: "Passage has no `lines`." });
  }
  for (const c of claims) validateClaim(c, errors, profile);
  for (const s of sources) validateSource(s, errors);
  for (const w of words) validateWord(w, errors, profile);
  for (const o of outcomes) validateOutcome(o, errors, profile);

  const passageId = slug(heading);
  const passage = {
    id: passageId,
    heading,
    type: passageType,
    lines: lineTexts.map((text, i) => ({ id: i + 1, text })),
  };
  const ctx = {
    passage,
    claims,
    sources,
    words,
    outcomes,
    profile,
    claimById: index(claims, "id"),
    sourceById: index(sources, "id"),
    wordById: index(words, "id"),
    outcomeById: index(outcomes, "id"),
  };

  const targetWarnings = !targetTag
    ? [`No target declared; defaulting to ${DEFAULT_TARGET}. Author a top-level 'target' (${Object.keys(TARGETS).join(" | ")}).`]
    : [];
  const readabilityWarnings: string[] = [];
  checkReadability(passage, grade, readabilityWarnings);
  const graphWarnings = [...targetWarnings, ...readabilityWarnings, ...validateGraph(ctx, errors)];
  const title = str(top.title);

  const items = outcomes.map((o, i) => composeOutcome(o, ctx, graphWarnings, i));
  if (items.length === 1) {
    items[0].grade = grade;
    if (title) items[0].title = title;
    return items[0];
  }
  const result: any = { kind: "items", items, grade };
  if (title) result.title = title;
  return result;
}

function validateClaim(c: any, errors: any[], profile: TargetProfile) {
  const id = str(c.id);
  const where = id ? `claim '${id}'` : "a claim";
  const at = coordOf(c);
  const push = (message: string) => errors.push({ message, ...at });
  if (!CLAIM_STATUS.has(str(c.status))) {
    push(`${where}: invalid status '${str(c.status)}'. Expected supported or distractor.`);
  }
  // dimension is required on supported claims (it must match the outcome); on distractors the
  // binding is by `targets` (not dimension), so it is optional there but validated if present.
  if (str(c.dimension)) {
    if (!profile.dimensions.has(str(c.dimension))) push(`${where}: invalid dimension '${str(c.dimension)}' for target ${profile.id}.`);
  } else if (str(c.status) === "supported") {
    push(`${where}: supported claim needs a dimension.`);
  }
  if (!str(c.text)) push(`${where}: missing text.`);
  if (str(c.status) === "distractor") {
    if (!profile.errorTypes.includes(str(c.errorType))) {
      push(`${where}: distractor needs a valid error-type for target ${profile.id} (${profile.errorTypes.join(", ")}).`);
    }
    if (!str(c.rationale)) {
      push(`${where}: distractor needs a rationale (the justification for the foil).`);
    }
    if (!Array.isArray(c.targets) || c.targets.length === 0) {
      push(`${where}: distractor needs targets (the outcome id(s) of the question(s) it foils).`);
    }
  }
  if (c.plausibility !== undefined && (typeof c.plausibility !== "number" || c.plausibility < 0 || c.plausibility > 1)) {
    push(`${where}: plausibility must be a number between 0 and 1.`);
  }
}

function validateSource(s: any, errors: any[]) {
  const id = str(s.id);
  const where = id ? `source '${id}'` : "a source";
  const at = coordOf(s);
  const push = (message: string) => errors.push({ message, ...at });
  if (!id) push(`${where}: missing id.`);
  if (!SOURCE_STATUS.has(str(s.status))) {
    push(`${where}: invalid status '${str(s.status)}'. Expected directly-supports, supports-wrong-claim, or irrelevant.`);
  }
  if (s.line === undefined && !str(s.quote)) {
    push(`${where}: needs a line number or a quote.`);
  }
}

// A T10 `word`: a targeted word/phrase plus its candidate `meaning`s. Each meaning is `correct`
// (the answer) or `distractor` (with a T10 error-type + rationale). A usable word needs ≥1 correct
// and ≥1 distractor meaning; Multi-Select questions need ≥2 correct (checked at compose).
function validateWord(w: any, errors: any[], profile: TargetProfile) {
  const id = str(w.id);
  const where = id ? `word '${id}'` : "a word";
  const at = coordOf(w);
  const push = (message: string) => errors.push({ message, ...at });
  if (!id) push(`${where}: missing id.`);
  if (!str(w.text)) push(`${where}: missing text (the targeted word/phrase).`);
  // `meanings` are for MC/Multi-Select (the candidate meanings of this word). A word with no
  // meanings is a click-the-word (TM3) candidate — valid; the meaning shape is checked only when
  // meanings are present, and the MC/MS compose path warns if a focused word has no correct meaning.
  const meanings: any[] = Array.isArray(w.meanings) ? w.meanings : [];
  if (meanings.length === 0) return;
  let nCorrect = 0;
  for (const m of meanings) {
    const mw = `${where} meaning '${str(m.id) || "?"}'`;
    const st = str(m.status);
    if (st !== "correct" && st !== "distractor") push(`${mw}: invalid status '${st}'. Expected correct or distractor.`);
    if (!str(m.text)) push(`${mw}: missing text (the meaning).`);
    if (st === "correct") nCorrect++;
    if (st === "distractor") {
      if (!profile.errorTypes.includes(str(m.errorType))) push(`${mw}: distractor meaning needs a valid error-type for target ${profile.id} (${profile.errorTypes.join(", ")}).`);
      if (!str(m.rationale)) push(`${mw}: distractor meaning needs a rationale.`);
    }
  }
  if (nCorrect === 0) push(`${where}: needs at least one meaning with status correct.`);
  if (meanings.length - nCorrect === 0) push(`${where}: needs at least one distractor meaning.`);
}

function validateOutcome(o: any, errors: any[], profile: TargetProfile) {
  const id = str(o.id);
  const where = id ? `outcome '${id}'` : "an outcome";
  const at = coordOf(o);
  const push = (message: string) => errors.push({ message, ...at });
  if (!id) push(`${where}: missing id (each question needs a unique id so distractors can target it).`);
  // Resolve an authored `task-model` (tm1..tmN) against THIS target's table. Task-model numbers are
  // PER-TARGET and collide across targets (e.g. tm3 = short-text in c1-t4/t11, ebsr in c1-t9), so a
  // number is meaningless without its target — resolution is always relative to the program's
  // target. The resolved item type must agree with an explicit `type`; if `type` is omitted, the
  // task model supplies it. This moves the number→type step off the generator and makes it a hard,
  // deterministic check (the c1-t9 "tm3 EBSR drifts to hot-text/short-text" failure mode).
  const tm = str(o.taskModel);
  if (tm) {
    const resolved = profile.taskModels[tm];
    if (!resolved) {
      const allowed = Object.entries(profile.taskModels).map(([k, v]) => `${k}→${v}`).join(", ");
      push(`${where}: task model '${tm}' is not available for target ${profile.id} (allowed: ${allowed}).`);
    } else if (!str(o.type)) {
      o.type = resolved; // infer the item type from the task model
    } else if (str(o.type) !== resolved) {
      push(`${where}: task model '${tm}' is ${resolved} for target ${profile.id}, but type is '${str(o.type)}'.`);
    }
  }
  const t = str(o.type);
  if (!ITEM_TYPES.has(t)) {
    push(`${where}: invalid type '${t}'. Expected ${[...ITEM_TYPES].join(", ")}.`);
  } else if (!profile.itemTypes.has(t)) {
    push(`${where}: item type '${t}' is not available for target ${profile.id} (allowed: ${[...profile.itemTypes].join(", ")}).`);
  }
  if (!profile.dimensions.has(str(o.dimension))) push(`${where}: invalid dimension '${str(o.dimension)}' for target ${profile.id}.`);
  if (o.standard !== undefined && !profile.standards.has(str(o.standard))) push(`${where}: invalid standard '${str(o.standard)}' for target ${profile.id}.`);
  // Item-first contract: the question owns its correct answer (focus) and its stem text,
  // authored from the guideline's Appropriate-Stem catalog (the compiler no longer synthesizes stems).
  // `focus` names the supported claim(s). For STATEMENT multi-select it's the correct SET (≥2); for
  // every other case it's a single claim — including T8's EVIDENCE multi-select, where `focus` is
  // the one GIVEN inference and the correct set is sources, not focus claims.
  const focus = focusIds(o);
  const statementMultiSelect = t === "multi-select" && profile.answerKind === "statement";
  if (focus.length === 0) push(`${where}: missing focus (the id of the supported claim this question is built around).`);
  else if (statementMultiSelect && focus.length < 2) push(`${where}: multi-select needs at least 2 focus claims (the correct set).`);
  else if (!statementMultiSelect && focus.length > 1) push(`${where}: ${t} takes a single focus claim; only statement multi-select takes a list.`);
  if (!str(o.stem)) push(`${where}: missing stem (author it from the guideline's Appropriate-Stem catalog).`);
  if (str(o.type) === "ebsr" && !str(o.stemB)) push(`${where}: EBSR needs a Part B stem (stem-b).`);
}

function index(arr: any[], key: string): Record<string, any> {
  const m: Record<string, any> = {};
  for (const x of arr) if (x && x[key] !== undefined) m[str(x[key])] = x;
  return m;
}

// `focus` names the question's correct claim(s). One id for single-answer items (MC / EBSR /
// Hot-Text / Short-Text); a list of ids for Multi-Select (the full correct set).
function focusIds(outcome: any): string[] {
  return (Array.isArray(outcome.focus) ? outcome.focus.map(str) : [str(outcome.focus)]).filter(Boolean);
}

// DOK for an item: an explicit `dok` wins; otherwise the target's default, with the written summary
// (Short Text) bumped to r-dok3 (strategic reasoning) per the guidelines.
function dokFor(profile: TargetProfile, itemType: string): string {
  return itemType === "short-text" ? "r-dok3" : profile.defaultDok;
}

// Program-level referential integrity. Duplicate ids corrupt the indices → hard errors;
// dangling references and out-of-range lines are non-fatal warnings (the plan's deferred
// cross-reference checks). Returns the warnings to seed each item's `warnings`.
function validateGraph(ctx: any, errors: any[]): string[] {
  const warnings: string[] = [];
  const lineCount = ctx.passage.lines.length;
  // The guideline ties each target to a text type; flag a mismatch (non-fatal — dual-text is future scope).
  if (ctx.passage.type && ctx.passage.type !== ctx.profile.textType) {
    warnings.push(`Target ${ctx.profile.id} expects an ${ctx.profile.textType} passage, but this passage is ${ctx.passage.type}.`);
  }
  for (const [label, arr] of [["claim", ctx.claims], ["source", ctx.sources], ["outcome", ctx.outcomes]] as const) {
    const seen = new Set<string>();
    for (const x of arr) {
      const id = str(x.id);
      if (!id) continue;
      if (seen.has(id)) errors.push({ message: `Duplicate ${label} id '${id}'.`, ...coordOf(x) });
      seen.add(id);
    }
  }
  for (const c of ctx.claims) {
    for (const ref of Array.isArray(c.cites) ? c.cites : []) {
      if (!ctx.sourceById[str(ref)]) warnings.push(`claim '${str(c.id)}' cites unknown evidence id '${str(ref)}'.`);
    }
    // A distractor's targets must name real questions (hard error — the binding is the contract).
    if (str(c.status) === "distractor") {
      for (const ref of Array.isArray(c.targets) ? c.targets : []) {
        if (!ctx.outcomeById[str(ref)]) errors.push({ message: `distractor '${str(c.id)}' targets unknown outcome id '${str(ref)}'.`, ...coordOf(c) });
      }
    }
  }
  // T10 click-the-word: a distractor candidate `word` targets the hot-text outcome it foils.
  for (const w of ctx.words) {
    for (const ref of Array.isArray(w.targets) ? w.targets : []) {
      if (!ctx.outcomeById[str(ref)]) warnings.push(`word '${str(w.id)}' targets unknown outcome id '${str(ref)}'.`);
    }
  }
  // Each question must pin a real, supported correct answer, and (for option items) have enough
  // foils bound to it — both hard errors, so a thin or mis-wired item fails the compile.
  for (const o of ctx.outcomes) {
    const oid = str(o.id);
    for (const f of focusIds(o)) {
      if (ctx.profile.answerKind === "meaning") {
        // T10: focus names a `word` (the targeted word), not a claim.
        if (!ctx.wordById[f]) errors.push({ message: `outcome '${oid}' focus '${f}' is not a known word id.`, ...coordOf(o) });
      } else {
        const fc = ctx.claimById[f];
        if (!fc) errors.push({ message: `outcome '${oid}' focus '${f}' is not a known claim id.`, ...coordOf(o) });
        else if (str(fc.status) !== "supported") errors.push({ message: `outcome '${oid}' focus '${f}' must be a supported claim, not a ${str(fc.status)}.`, ...coordOf(o) });
      }
    }
    // Items whose options are distractor CLAIMS need enough distinct ones bound to them, or they
    // can't be composed (hard error). EBSR / two-part Hot-Text / Multiple-Choice want 3 (4 options);
    // Multi-Select wants ≥2 foils beyond its correct set. Items whose foils are SOURCES — evidence
    // targets (T8) and any single-part Hot-Text (T8/T9) — don't use distractor claims, so this gate
    // doesn't apply (their viability is warned in composition).
    const t = str(o.type);
    const sourceFoils = ctx.profile.answerKind !== "statement" || (t === "hot-text" && ctx.profile.singlePartHotText);
    const min = sourceFoils ? 0
      : (t === "ebsr" || t === "hot-text" || t === "multiple-choice") ? TUNING.DISTRACTOR_SLOTS
        : t === "multi-select" ? 2 : 0;
    if (oid && min > 0) {
      const distinct = new Set(
        ctx.claims
          .filter((c: any) => str(c.status) === "distractor" && (Array.isArray(c.targets) ? c.targets.map(str) : []).includes(oid))
          .map((c: any) => norm(str(c.text))),
      ).size;
      if (distinct < min) {
        errors.push({ message: `outcome '${oid}': only ${distinct} distractor(s) target it; a ${t} item needs at least ${min}.`, ...coordOf(o) });
      }
    }
  }
  for (const s of ctx.sources) {
    for (const ref of Array.isArray(s.supports) ? s.supports : []) {
      if (!ctx.claimById[str(ref)]) warnings.push(`source '${str(s.id)}' supports unknown claim id '${str(ref)}'.`);
    }
    if (s.line !== undefined && !str(s.quote)) {
      const ln = Number(s.line);
      if (!Number.isFinite(ln) || ln < 1 || ln > lineCount) {
        warnings.push(`source '${str(s.id)}' line ${str(s.line)} is outside the passage (1..${lineCount}).`);
      }
    }
  }
  return warnings;
}

function standardsFor(outcome: any, correct: any, dim: string, profile: TargetProfile): string[] {
  const companion = str(outcome.standard) || str(correct && correct.standard) || profile.dimStandard[dim];
  const out = [profile.baseStandard];
  if (companion && companion !== profile.baseStandard) out.push(companion);
  return out;
}

function sourceText(s: any, passage: any): string {
  if (str(s.quote)) return str(s.quote);
  const ln = passage.lines.find((l: any) => l.id === s.line);
  return ln ? ln.text : "";
}

// Abbreviations whose trailing period does NOT end a sentence. Grade-5 literary prose (the T1/T2/T4
// targets) is full of honorifics — "Mr. Ruiz never learned who had fixed his porch." — which a bare
// [.!?] split would cut in half, making "Mr." its own clickable Hot Text option.
const SENTENCE_ABBREVIATIONS = [
  "mr", "mrs", "ms", "mx", "dr", "prof", "rev", "fr", "hon",
  "capt", "gen", "sgt", "lt", "col", "sen", "gov", "pres",
  "jr", "sr", "st", "mt", "ft", "rd", "ave", "blvd", "no",
  "vs", "etc", "approx", "dept",
];
const ABBREV_END = new RegExp(`(?:^|[\\s("'‘“])(?:${SENTENCE_ABBREVIATIONS.join("|")})\\.$`, "i");

// True when `s` ends mid-abbreviation: a known abbreviation ("Mr."), a single-letter initial
// ("J."), or a dotted pair ("a.m.", "U.S.").
function endsMidAbbreviation(s: string): boolean {
  return ABBREV_END.test(s) || /(?:^|\s)[A-Za-z]\.$/.test(s) || /(?:^|\s)[A-Za-z]\.[A-Za-z]\.$/.test(s);
}

// Segment a paragraph into sentences for Hot Text selection. Heuristic: take runs ending in
// sentence punctuation (.!?), absorbing any trailing closing quote/paren, then trim, then re-join
// any run that broke inside an abbreviation. The passage keeps its paragraph structure (one `lines`
// entry per paragraph); Hot Text makes each sentence within a paragraph individually selectable. An
// occasional dialogue-tag mis-split is acceptable for grade-level prose, and correctness is anchored
// to authored `quote`s rather than the split.
function splitSentences(text: string): string[] {
  const t = str(text).trim();
  if (!t) return [];
  const parts = t.match(/[^.!?]+[.!?]+["'”’)\]]*\s*/g);
  if (!parts) return [t];
  const out: string[] = [];
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    if (out.length && endsMidAbbreviation(out[out.length - 1])) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out;
}

// Deterministic shuffle (seeded) so recompiling the same program yields stable option labels.
function strHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle<T>(arr: T[], seed: string): T[] {
  const rnd = mulberry32(strHash(seed));
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const LABELS = ["A", "B", "C", "D", "E", "F"];

// Distinct = not a normalized-text duplicate of an already-chosen option.
function norm(t: string): string {
  return str(t).toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// How tempting a distractor is to a partial-understander, in [0,1]. An author-supplied
// `plausibility` overrides (pins) the score; otherwise it is computed from graph signals:
// evidence that also backs the correct claim (a confused student would cite it), same
// dimension as the correct answer, structural parallelism, and an error-type prior.
export function plausibility(d: any, correct: any, ctx: any): number {
  if (typeof d.plausibility === "number") return clamp01(d.plausibility); // author override
  let s = 0.4; // base
  const cited = (Array.isArray(d.cites) ? d.cites : [])
    .map((id: any) => ctx.sourceById[str(id)])
    .filter(Boolean);
  const overlaps = cited.some((src: any) =>
    str(src.status) === "supports-wrong-claim" &&
    (Array.isArray(src.supports) ? src.supports.map(str) : []).includes(str(correct.id)));
  if (overlaps) s += 0.3; // strongest tell: real text seems to back the foil
  if (str(d.dimension) && str(d.dimension) === str(correct.dimension)) s += 0.15;
  const la = str(d.text).length, lb = str(correct.text).length;
  if (la && lb) s += 0.1 * (1 - Math.abs(la - lb) / Math.max(la, lb)); // structural parallelism
  s += ERROR_TYPE_PRIOR[str(d.errorType)] ?? 0;
  return clamp01(s);
}

// Select up to 3 foils for an item from the distractors explicitly bound to this question via
// `targets` (NOT a dimension join) — so the foils are authored against this exact stem + key.
function selectDistractorClaims(outcome: any, correct: any, ctx: any, warnings: string[], slots = TUNING.DISTRACTOR_SLOTS): any[] {
  const oid = str(outcome.id);
  const errorTypes: string[] = ctx.profile.errorTypes;
  const correctSet = new Set(focusIds(outcome)); // never let a correct claim become its own foil (multi-select)
  const pool = ctx.claims.filter((c: any) =>
    str(c.status) === "distractor" && !correctSet.has(str(c.id)) &&
    (Array.isArray(c.targets) ? c.targets.map(str) : []).includes(oid));
  const seen = new Set([norm(correct.text)]);
  // Rank candidates by plausibility (desc), tie-break by id for determinism.
  const byScore = (a: any, b: any) =>
    plausibility(b, correct, ctx) - plausibility(a, correct, ctx) || str(a.id).localeCompare(str(b.id));
  const byType: Record<string, any[]> = {};
  for (const c of pool) (byType[str(c.errorType)] = byType[str(c.errorType)] || []).push(c);
  for (const t of errorTypes) byType[t]?.sort(byScore);
  const chosen: any[] = [];
  const take = (c: any) => {
    if (!c) return;
    const n = norm(c.text);
    if (seen.has(n)) { warnings.push(`Dropped near-duplicate distractor '${str(c.id)}'.`); return; }
    seen.add(n); chosen.push(c);
  };
  // Coverage: take the most plausible foil of each error type (in taxonomy order).
  for (const t of errorTypes) if (chosen.length < slots && byType[t] && byType[t].length) take(byType[t].shift());
  // Fill remaining slots with the most plausible leftovers.
  const rest = pool.filter((c: any) => !chosen.includes(c)).sort(byScore);
  while (chosen.length < slots && rest.length) take(rest.shift());
  if (chosen.length < slots) warnings.push(`Only ${chosen.length} distractor claim(s) target this outcome; this item wants ${slots}.`);
  // Only nudge for full error-type coverage when the taxonomy fits the slot count (R&E: 3 types, 3
  // slots). Wider taxonomies (e.g. T9's 4) can't all appear in 3 options, so don't warn.
  if (errorTypes.length <= slots) {
    const missing = errorTypes.filter((t) => !chosen.some((c) => str(c.errorType) === t));
    if (missing.length) warnings.push(`Distractor error types not represented: ${missing.join(", ")}.`);
  }
  return chosen.slice(0, slots);
}

function labelize(opts: any[]) {
  return opts.map((o, i) => ({ key: LABELS[i], ...o }));
}

// Rough syllable count for one word — the vowel-group heuristic the classic readability formulas
// assume: count runs of vowels, drop a silent trailing "e", floor at 1. Not linguistically exact,
// but stable and dependency-free, which is all the grade-level estimate needs.
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 0;
  if (w.length > 2 && w.endsWith("e") && !/[aeiouy]e$/.test(w)) n -= 1; // silent final e
  return Math.max(1, n);
}

// Flesch–Kincaid grade level over a block of prose: 0.39·(words/sentence) + 11.8·(syllables/word)
// − 15.59. A rough proxy for text complexity — enough to flag prose that reads well above the
// target grade. Returns null when the sample is too small to be meaningful.
function estimateGradeLevel(text: string): number | null {
  const sentences = splitSentences(text).length || (text.trim() ? 1 : 0);
  const words: string[] = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
  if (sentences === 0 || words.length < 20) return null; // too little text to judge
  const syllables = words.reduce((sum: number, w: string) => sum + countSyllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
}

// Reading-level guard: estimate the passage's grade level and warn (non-fatal) when it reads
// notably above the target grade, so the upstream generator's repair loop can simplify the prose.
// The threshold is RELATIVE to the resolved grade (the guideline's grade, or a top-level `grade`
// override) — not a fixed grade-5 constant — so the same check serves future grade bands.
function checkReadability(passage: any, grade: number, warnings: string[]): void {
  const text = (Array.isArray(passage.lines) ? passage.lines : []).map((l: any) => str(l.text)).join(" ");
  const est = estimateGradeLevel(text);
  if (est === null) return;
  if (est > grade + TUNING.GRADE_LEVEL_TOLERANCE) {
    warnings.push(
      `Passage reads above grade ${grade} (est. grade ${est.toFixed(1)}); shorten sentences and use simpler, more concrete vocabulary to match the target reading level.`,
    );
  }
}

// Length-giveaway guard: the correct option should not stand out as the longest/most-detailed
// choice — a partial-understander can pick the key on heft alone. Warn (non-fatal) when the
// correct option's text runs notably longer than the mean distractor length, so the author/
// generator can pad the foils or trim the key until the options read as parallel in length.
function checkLengthBalance(options: any[], label: string, warnings: string[]): void {
  const correct = options.find((o: any) => o.correct);
  const foils = options.filter((o: any) => !o.correct);
  if (!correct || foils.length === 0) return;
  const len = (o: any) => str(o.text).length;
  const correctLen = len(correct);
  const meanFoil = foils.reduce((sum: number, o: any) => sum + len(o), 0) / foils.length;
  if (meanFoil === 0) return;
  const ratio = correctLen / meanFoil;
  const isLongest = foils.every((o: any) => len(o) <= correctLen);
  if (isLongest && ratio >= TUNING.LENGTH_BALANCE_RATIO) {
    warnings.push(
      `${label}: the correct option (${correctLen} chars) is ${Math.round((ratio - 1) * 100)}% longer than the average distractor (${Math.round(meanFoil)} chars) — possible length giveaway. Balance the options' length/detail.`,
    );
  }
}

// Function words + stem boilerplate excluded when comparing a stem against the answer — only
// distinctive content words should count toward an overlap.
const STEM_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "and", "or", "but", "that", "this", "these",
  "those", "is", "are", "was", "were", "be", "been", "being", "it", "its", "as", "by", "with", "from",
  "into", "about", "which", "what", "how", "who", "whose", "why", "where", "when", "your", "their",
  "them", "they", "had", "has", "have", "do", "does", "did", "will", "would", "can", "could", "more",
  "than", "then", "so", "such", "best", "most", "two", "three",
  // stem-template boilerplate
  "passage", "sentence", "sentences", "inference", "inferences", "conclusion", "conclusions", "click",
  "statement", "statements", "supported", "support", "supports", "answer", "part", "show", "shows",
  "select", "provides", "author", "most", "likely",
]);

function contentWords(s: string, subject: string): Set<string> {
  const subj = new Set(norm(subject).split(" ").filter(Boolean));
  return new Set(
    norm(s).split(" ").filter((w) => w.length > 2 && !STEM_STOPWORDS.has(w) && !subj.has(w)),
  );
}

// Stem-giveaway guard: the Part A stem should not echo the correct answer's wording. When the stem
// reuses most of the correct option's distinctive content words (ignoring function words, stem
// boilerplate, and the subject), the answer is obvious without reading the options. Warn (non-fatal)
// so the generator rewords the stem into a neutral question. The subject is excluded so a stem that
// merely names what the question is about (e.g. the character/topic) is not flagged.
function checkStemGiveaway(stem: string, correctText: string, subject: string, warnings: string[]): void {
  const stemWords = contentWords(stem, subject);
  const ansWords = [...contentWords(correctText, subject)];
  if (ansWords.length < TUNING.STEM_GIVEAWAY_MIN) return; // too short to judge
  const shared = ansWords.filter((w) => stemWords.has(w));
  if (shared.length >= TUNING.STEM_GIVEAWAY_MIN && shared.length / ansWords.length >= TUNING.STEM_GIVEAWAY_RATIO) {
    warnings.push(
      `Part A: the stem reuses much of the correct option's wording (shared: ${shared.slice(0, 8).join(", ")}) — reword the stem into a neutral question so it doesn't echo the answer.`,
    );
  }
}

// Place the correct option at a balanced slot, then label. A per-item seeded shuffle distributes
// uniformly in expectation but, over the few items in one program, can land the answer key first
// (or last) for every item — the pattern authors noticed. Instead the distractors are seeded-
// shuffled among themselves and the correct option is inserted at a slot that round-robins by
// outcome index, rotated by a per-program/part offset so the key neither always starts at A nor
// repeats the same position across items. Deterministic: same program → same labels.
function placeCorrect(
  correctOpt: any, distractorOpts: any[], seed: string, programSeed: string, part: string, outcomeIndex: number,
) {
  const opts = seededShuffle(distractorOpts, `${seed}:${part}`);
  const n = opts.length + 1;
  const slot = (outcomeIndex + (strHash(`${programSeed}:${part}`) % n)) % n;
  opts.splice(slot, 0, correctOpt);
  return labelize(opts);
}

function partAOptions(correct: any, distractors: any[], seed: string, programSeed: string, outcomeIndex: number) {
  const correctOpt = { text: str(correct.text), correct: true, claimId: str(correct.id) };
  const distractorOpts = distractors.map((d) => ({ text: str(d.text), correct: false, claimId: str(d.id), errorType: str(d.errorType) }));
  return placeCorrect(correctOpt, distractorOpts, seed, programSeed, "A", outcomeIndex);
}

// Multi-Select options: the full correct set plus distractors, seeded-shuffled together and labelled.
// (Unlike placeCorrect, more than one option is correct, so there is no single insertion slot.)
function multiSelectOptions(correctClaims: any[], distractors: any[], seed: string) {
  const opts = [
    ...correctClaims.map((c) => ({ text: str(c.text), correct: true, claimId: str(c.id) })),
    ...distractors.map((d) => ({ text: str(d.text), correct: false, claimId: str(d.id), errorType: str(d.errorType) })),
  ];
  return labelize(seededShuffle(opts, `${seed}:MS`));
}

// Per-option distractor analysis (the non-correct options), shared by Part A, Multiple Choice, and
// Multi-Select. `part` tags the entry ("A" for the single-part selected-response items).
function optionAnalysis(options: any[], correct: any, ctx: any, part = "A"): any[] {
  return options
    .filter((o: any) => !o.correct)
    .map((o: any) => {
      const claim = ctx.claimById[o.claimId];
      return {
        part, key: o.key, claimId: o.claimId, errorType: o.errorType,
        tiesTo: [o.claimId],
        plausibility: Math.round(plausibility(claim, correct, ctx) * 100) / 100,
        rationale: str(claim?.rationale),
      };
    });
}

// Function words that are never the answer in a click-the-word item, so they aren't clickable.
const CLICK_STOPWORDS = new Set([
  "the", "and", "are", "was", "were", "for", "but", "with", "this", "that", "these", "those",
  "its", "into", "their", "they", "them", "from", "has", "have", "had", "not", "you", "your",
]);

// T10 Word Meanings: compose a Multiple-Choice / Multi-Select item whose options are the candidate
// `meaning`s of the targeted `word` named by `focus`. correct meanings are the key(s); distractor
// meanings (with T10 error-types) are the foils. The targeted word + its context ride along on
// `item.word` for the renderer.
function composeWordMeaning(
  outcome: any, ctx: any, dim: string, dok: string, itemType: string, seed: string, outcomeIndex: number, warnings: string[],
): any {
  const wordId = focusIds(outcome)[0];
  const word = ctx.wordById[wordId];
  const meanings: any[] = word && Array.isArray(word.meanings) ? word.meanings : [];
  const correctM = meanings.filter((m: any) => str(m.status) === "correct");
  const distractorM = meanings.filter((m: any) => str(m.status) === "distractor");
  const key0 = correctM[0];
  const correct = key0 ? { id: str(key0.id), text: str(key0.text), standard: key0.standard } : null;
  const item = baseItem(itemType, outcome, ctx, dim, dok, correct, warnings);
  if (word) item.word = { text: str(word.text), line: word.line, quote: str(word.quote) || undefined };
  if (!word) {
    warnings.push(`Outcome '${str(outcome.id)}' focus '${wordId}' is not a known word; cannot compose.`);
    return item;
  }

  // Task Model 3 — click the word: show the PARAGRAPH containing the target word and let the student
  // click the word matching the definition (in the stem). The clickable CANDIDATES are the authored
  // `word`s that appear in that paragraph (the curated, underlined choices) — the focus word is the
  // correct one; the others are distractor candidates. If only the correct word is authored, every
  // content word in the paragraph becomes a choice. The excerpt is the passage paragraph identified
  // by the word's `line`, else the first paragraph that contains it, else its `quote`.
  if (itemType === "hot-text") {
    const oid = str(outcome.id);
    const correctNorm = norm(str(word.text));
    const byLine = str(ctx.passage.lines.find((l: any) => l.id === word.line)?.text);
    const byContains = str(ctx.passage.lines.find((l: any) => norm(l.text).split(" ").includes(correctNorm))?.text);
    const excerpt = byLine || byContains || str(word.quote);
    if (!excerpt) warnings.push(`Outcome '${oid}': word '${wordId}' needs a 'line' (the paragraph it appears in) or a 'quote' so there is an excerpt to select from.`);
    const excerptNorms = new Set(norm(excerpt).split(" ").filter(Boolean));
    // Curated candidates come from two authoring styles, both keyed to words in this paragraph:
    //   1. other authored `word`s (the canonical hot-text model), and
    //   2. the focus word's single-word distractor MEANINGS — the generator often authors the
    //      click candidates this way (reusing the MC/MS shape: a word + meanings) rather than as
    //      separate `word`s. A meaning whose text is one word in the paragraph IS a candidate word;
    //      multi-word definitions (e.g. the correct meaning "very tiring and difficult") are ignored.
    // If neither yields a candidate, fall back to every content word being a choice.
    const otherWords = ctx.words.filter((w: any) => str(w.id) !== str(word.id));
    const wordCandidates = otherWords.filter((w: any) => excerptNorms.has(norm(str(w.text))));
    const meaningCandidates = distractorM.filter(
      (m: any) => str(m.text).trim().split(/\s+/).length === 1 && excerptNorms.has(norm(str(m.text))),
    );
    const candTexts = [...wordCandidates.map((w: any) => str(w.text)), ...meaningCandidates.map((m: any) => str(m.text))];
    const curated = candTexts.length >= 1;
    const candNorms = new Set([correctNorm, ...candTexts.map((t: string) => norm(t))]);
    const tokens = excerpt.split(/\s+/).filter(Boolean).map((raw: string, idx: number) => {
      const pre = (raw.match(/^[^A-Za-z0-9]+/) || [""])[0];
      const post = (raw.match(/[^A-Za-z0-9]+$/) || [""])[0];
      const core = raw.slice(pre.length, raw.length - post.length);
      const n = norm(core);
      const selectable = curated ? candNorms.has(n) : (core.length > 2 && !CLICK_STOPWORDS.has(n));
      return { idx, pre, text: core || raw, post, selectable, correct: selectable && n === correctNorm };
    });
    // An authored candidate word that isn't in the correct word's paragraph can't be a choice — warn
    // (skip words that are another outcome's focus, which belong to a different item).
    const focusedIds = new Set(ctx.outcomes.flatMap((o: any) => focusIds(o)));
    for (const w of otherWords) {
      if (focusedIds.has(str(w.id)) || w.meanings) continue; // another item's word, or an MC/MS word
      if (!excerptNorms.has(norm(str(w.text)))) warnings.push(`word '${str(w.id)}' ("${str(w.text)}") is not in the correct word's paragraph, so it cannot be a click-the-word choice — keep all candidates in that paragraph.`);
    }
    if (!tokens.some((t: any) => t.correct)) warnings.push(`Outcome '${oid}': the correct word "${str(word.text)}" is not a selectable word in the excerpt.`);
    const nSelectable = tokens.filter((t: any) => t.selectable).length;
    if (nSelectable < 3) warnings.push(`Click-the-word: only ${nSelectable} selectable word(s) — author a few distractor candidate words in the correct word's paragraph (or use a fuller paragraph).`);
    if (excerpt && norm(str(outcome.stem)).includes(norm(excerpt))) warnings.push("Click-the-word stem should be just the instruction and the definition — the paragraph is shown separately; do not paste it into the stem.");
    item.wordSelect = { excerpt, tokens };
    item.selectCount = 1;
    item.stem = { partA: str(outcome.stem) }; // single-part: the authored definition + click instruction
    item.review.correctClaim = { id: str(word.id), text: str(word.text) };
    item.distractorAnalysis = [];
    item.answerKey = { word: str(word.text), rationale: str(key0?.rationale) };
    return item;
  }

  const toOpt = (m: any, correctFlag: boolean) => ({ text: str(m.text), correct: correctFlag, meaningId: str(m.id), errorType: str(m.errorType) || undefined });
  const meaningById = index(meanings, "id");
  const analysis = (options: any[]) => options.filter((o: any) => !o.correct).map((o: any) => ({
    part: "A", key: o.key, meaningId: o.meaningId, errorType: o.errorType, rationale: str(meaningById[o.meaningId]?.rationale),
  }));

  if (itemType === "multi-select") {
    if (correctM.length < 2) warnings.push("Multi-select (word meaning) needs at least 2 correct meanings.");
    const slots = Math.max(1, TUNING.MULTI_SELECT_OPTIONS - correctM.length);
    const opts = [...correctM.map((m) => toOpt(m, true)), ...distractorM.slice(0, slots).map((m) => toOpt(m, false))];
    const options = labelize(seededShuffle(opts, `${seed}:WM`));
    checkLengthBalance(options, "Options", warnings);
    item.choice = { options };
    item.selectCount = options.filter((o: any) => o.correct).length;
    item.distractorAnalysis = analysis(options);
    item.answerKey = { choices: options.filter((o: any) => o.correct).map((o: any) => o.key), rationale: str(key0?.rationale) };
    return item;
  }

  // Multiple Choice: one correct meaning + up to 3 distractor meanings.
  const correctOpt = key0 ? toOpt(key0, true) : null;
  const distractorOpts = distractorM.slice(0, TUNING.PART_OPTIONS - 1).map((m) => toOpt(m, false));
  const options = correctOpt
    ? placeCorrect(correctOpt, distractorOpts, seed, ctx.passage.id, "MC", outcomeIndex)
    : labelize(seededShuffle(distractorOpts, `${seed}:MC`));
  if (!correctOpt) warnings.push("No correct meaning for the targeted word; this item has no correct option.");
  checkLengthBalance(options, "Options", warnings);
  checkStemGiveaway(str(outcome.stem), str(correctOpt?.text), str(outcome.subject), warnings);
  item.choice = { options };
  item.distractorAnalysis = analysis(options);
  item.answerKey = { choice: options.find((o: any) => o.correct)?.key, rationale: str(key0?.rationale) };
  return item;
}

function composeOutcome(outcome: any, ctx: any, graphWarnings: string[] = [], outcomeIndex = 0): any {
  const warnings: string[] = [...graphWarnings];
  const dim = str(outcome.dimension);
  const itemType = str(outcome.type);
  const dok = str(outcome.dok) || dokFor(ctx.profile, itemType);
  const seed = `${ctx.passage.id}:${str(outcome.id)}:${itemType}`;

  // `task-model` is optional, but recommended: it makes the item's task model explicit
  // (type→task-model is per-target and not reliably invertible). Warn — don't error — when
  // it's omitted, so the authored task model can be shown and verified.
  if (!str(outcome.taskModel)) {
    warnings.push(`Outcome '${str(outcome.id)}' does not specify a task-model; add one (e.g. \`task-model tm3\`) so the item's task model is explicit.`);
  }

  // T10 Word Meanings: `focus` names a `word`, and the options are its candidate meanings — a
  // separate compose path (no claim/evidence graph).
  if (ctx.profile.answerKind === "meaning") {
    return composeWordMeaning(outcome, ctx, dim, dok, itemType, seed, outcomeIndex, warnings);
  }

  // 1. The question pins its correct answer(s) via `focus`. One claim for single-answer items; the
  // full correct set for multi-select. `correct` is the primary (first) for the shared machinery.
  const fids = focusIds(outcome);
  const correctClaims = fids.map((id) => ctx.claimById[id]).filter(Boolean);
  const correct: any = correctClaims[0];
  if (!correct) {
    warnings.push(`Outcome '${str(outcome.id)}' focus '${fids.join(", ")}' not found; cannot compose.`);
    return baseItem(itemType, outcome, ctx, dim, dok, null, warnings);
  }
  const alternativeClaims = Math.max(0,
    ctx.claims.filter((c: any) => str(c.status) === "supported" && str(c.dimension) === dim).length - 1);

  const item = baseItem(itemType, outcome, ctx, dim, dok, correct, warnings);
  item.review.alternativeClaims = alternativeClaims;

  const directSources = (Array.isArray(correct.cites) ? correct.cites : [])
    .map((id: any) => ctx.sourceById[str(id)])
    .filter((s: any) => s && str(s.status) === "directly-supports");

  if (itemType === "short-text") {
    item.prompt = str(outcome.stem); // authored from the guideline catalog (required)
    item.rubric = Array.isArray(outcome.rubric) && outcome.rubric.length
      ? outcome.rubric.map((b: any) => ({ score: Number(b.score), descriptor: str(b.descriptor) }))
      : DEFAULT_RUBRIC;
    item.distractorAnalysis = [];
    item.answerKey = { rationale: str(correct.rationale) };
    if (ctx.passage.lines.length < TUNING.SHORT_TEXT_MIN_LINES) warnings.push("Short Text items should use a long literary passage; this passage is short.");
    return item;
  }

  // Multiple Choice (single-part, 4 options, exactly one correct).
  if (itemType === "multiple-choice") {
    if (ctx.profile.answerKind === "evidence") {
      // T8: the inference is given in the stem; the options are passage evidence. Correct = a
      // directly-supporting source for the focus claim; foils = non-supporting sources.
      if (directSources.length === 0) warnings.push("No directly-supporting evidence for the given inference; this item has no correct option.");
      const { options, pool } = evidenceOptions(correct, directSources, ctx, seed, outcomeIndex, false);
      if (pool < TUNING.MIN_VIABLE_PART_B) warnings.push(`Only ${pool} non-supporting evidence source(s) available; author at least ${TUNING.MIN_VIABLE_PART_B} so the best foils can be chosen.`);
      checkLengthBalance(options, "Options", warnings);
      checkStemGiveaway(str(outcome.stem), str(options.find((o: any) => o.correct)?.text), str(outcome.subject), warnings);
      item.choice = { options };
      item.distractorAnalysis = evidenceAnalysis(options, ctx);
      item.answerKey = { choice: options.find((o: any) => o.correct)?.key, rationale: str(correct.rationale) };
      return item;
    }
    // Statement targets: the `focus` claim is the key; its `targets` distractor claims are the foils.
    const distractors = selectDistractorClaims(outcome, correct, ctx, warnings);
    const options = partAOptions(correct, distractors, seed, ctx.passage.id, outcomeIndex);
    checkLengthBalance(options, "Options", warnings);
    checkStemGiveaway(str(outcome.stem), str(correct.text), str(outcome.subject), warnings);
    item.choice = { options };
    item.distractorAnalysis = optionAnalysis(options, correct, ctx);
    item.answerKey = { choice: options.find((o: any) => o.correct)?.key, rationale: str(correct.rationale) };
    return item;
  }

  // Multi-Select (single-part, 5–6 options, an exact correct SET; guideline: "all responses correct").
  if (itemType === "multi-select") {
    if (ctx.profile.answerKind === "evidence") {
      // T8: the correct set is the directly-supporting sources; foils are non-supporting sources.
      if (directSources.length < 2) warnings.push("Multi-select (evidence) needs at least 2 directly-supporting sources as the correct set.");
      const { options, pool } = evidenceOptions(correct, directSources, ctx, seed, outcomeIndex, true);
      if (pool < TUNING.MIN_VIABLE_PART_B) warnings.push(`Only ${pool} non-supporting evidence source(s) available; author at least ${TUNING.MIN_VIABLE_PART_B}.`);
      checkLengthBalance(options, "Options", warnings);
      item.choice = { options };
      item.selectCount = options.filter((o: any) => o.correct).length;
      item.distractorAnalysis = evidenceAnalysis(options, ctx);
      item.answerKey = { choices: options.filter((o: any) => o.correct).map((o: any) => o.key), rationale: str(correct.rationale) };
      return item;
    }
    // Statement targets: the full correct set is `focus` (a list); distractor claims are the foils.
    const correctCount = correctClaims.length;
    const slots = Math.max(1, TUNING.MULTI_SELECT_OPTIONS - correctCount);
    const distractors = selectDistractorClaims(outcome, correct, ctx, warnings, slots);
    const options = multiSelectOptions(correctClaims, distractors, seed);
    checkLengthBalance(options, "Options", warnings);
    checkStemGiveaway(str(outcome.stem), str(correct.text), str(outcome.subject), warnings);
    item.choice = { options };
    item.selectCount = correctCount; // how many to select (the stem says "Choose two", etc.)
    item.distractorAnalysis = optionAnalysis(options, correct, ctx);
    item.answerKey = { choices: options.filter((o: any) => o.correct).map((o: any) => o.key), rationale: str(correct.rationale) };
    return item;
  }

  // Single-part Hot Text (T8 Key Details, T9 Central Ideas): the authored stem is the whole click
  // instruction (it states the given inference, or asks for the main-idea sentences); the student
  // clicks the directly-supporting sentences. No Part A statement options.
  if (itemType === "hot-text" && ctx.profile.singlePartHotText) {
    const { selectable, selectCount } = buildSelectable(ctx, directSources, warnings);
    item.selectable = selectable;
    item.selectCount = selectCount;
    item.stem = { partA: str(outcome.stem) }; // single-part: the authored click instruction (no lead-in / Part B)
    item.distractorAnalysis = [];
    item.answerKey = { partB: selectable.filter((s: any) => s.correct).map((s: any) => s.id).join(", "), rationale: str(correct.rationale) };
    return item;
  }

  // EBSR & Hot Text share Part A (statement options).
  // Viability check: a healthy pool has >=5 distinct distractors bound to THIS question (via
  // `targets`), so selection (and the plausibility ranking) has real choice. Thin pools warn — a
  // signal the upstream generator's repair loop can use to regenerate more foils. (Fewer than 3
  // targeted foils is a hard error raised earlier in validateGraph.)
  const oid = str(outcome.id);
  const viableDistractors = new Set(
    ctx.claims
      .filter((c: any) => str(c.status) === "distractor" && (Array.isArray(c.targets) ? c.targets.map(str) : []).includes(oid))
      .map((c: any) => norm(str(c.text))),
  ).size;
  if (viableDistractors < TUNING.MIN_VIABLE_DISTRACTORS) {
    warnings.push(`Only ${viableDistractors} viable distractor(s) target outcome '${oid}'; author at least 5 for stronger selection.`);
  }
  const distractors = selectDistractorClaims(outcome, correct, ctx, warnings);
  item.partA = { options: partAOptions(correct, distractors, seed, ctx.passage.id, outcomeIndex) };
  checkLengthBalance(item.partA.options, "Part A", warnings);
  checkStemGiveaway(str(outcome.stem), str(correct.text), str(outcome.subject), warnings);
  const aKey = item.partA.options.find((o: any) => o.correct)?.key;
  const analysis: any[] = optionAnalysis(item.partA.options, correct, ctx);

  if (itemType === "hot-text") {
    // Part A asks for the best STATEMENT (an inference), authored from the Task Model 2 "Click on
    // the statement that best…" catalog. Selecting passage sentences is Part B (fixed by the
    // compiler). A Part A stem that asks the student to click sentences from the passage is the
    // wrong form — warn so the generator swaps in a statement stem.
    if (/\bsentences?\b/i.test(str(outcome.stem))) {
      warnings.push(
        "Hot Text Part A must ask for the best STATEMENT (an inference), not passage sentences — selecting sentences is Part B (fixed by the compiler). Use a \"Click on the statement that best…\" stem from stems.md Task Model 2.",
      );
    }
    // The passage is segmented into sentences (grouped by paragraph) and the directly-supporting
    // ones are marked correct; the student selects an exact count (a proper subset of the valid
    // superset). See buildSelectable.
    const { selectable, selectCount } = buildSelectable(ctx, directSources, warnings);
    item.selectable = selectable;
    item.selectCount = selectCount;
    item.stem.partB = hotTextPartB(selectCount);
    item.distractorAnalysis = analysis;
    item.answerKey = { partA: aKey, partB: selectable.filter((s: any) => s.correct).map((s: any) => s.id).join(", "), rationale: str(correct.rationale) };
    return item;
  }

  // EBSR Part B — curated 4 line options.
  const correctSrc = directSources[0];
  const { pool: partBPool, chosen: distractorSrcs } = pickPartBDistractors(correct, distractors, ctx);
  if (partBPool < TUNING.MIN_VIABLE_PART_B) {
    warnings.push(`Only ${partBPool} Part B foil source(s) available; author at least ${TUNING.MIN_VIABLE_PART_B} non-supporting evidence lines (supports-wrong-claim + irrelevant) so the best 3 can be chosen.`);
  }
  const correctOpt = correctSrc
    ? { line: correctSrc.line, text: sourceText(correctSrc, ctx.passage), correct: true, sourceId: str(correctSrc.id) }
    : null;
  const distractorOpts = distractorSrcs.map((s: any) => ({
    line: s.line, text: sourceText(s, ctx.passage), correct: false, sourceId: str(s.id),
    status: str(s.status), tiesTo: firstWrongClaim(s, correct),
  }));
  const bCount = (correctOpt ? 1 : 0) + distractorOpts.length;
  if (!correctSrc) warnings.push("No directly-supporting evidence for the correct claim; EBSR Part B has no correct option.");
  if (bCount < TUNING.PART_OPTIONS) warnings.push(`Only ${bCount} Part B option(s) available; EBSR wants 4. Add irrelevant or supports-wrong-claim evidence sources.`);
  item.partB = {
    options: correctOpt
      ? placeCorrect(correctOpt, distractorOpts, seed, ctx.passage.id, "B", outcomeIndex)
      : labelize(seededShuffle(distractorOpts, `${seed}:B`)),
  };
  const bKey = item.partB.options.find((o: any) => o.correct)?.key;
  checkLengthBalance(item.partB.options, "Part B", warnings);

  // A<->B no-giveaway check: at least one Part B distractor should also tie to the correct claim.
  const overlap = distractorSrcs.some((s: any) => (Array.isArray(s.supports) ? s.supports.map(str) : []).includes(str(correct.id)));
  if (distractorSrcs.length && !overlap) {
    warnings.push("Part B options do not overlap the correct Part A option — possible A↔B giveaway.");
  }

  for (const o of item.partB.options) {
    if (!o.correct) {
      analysis.push({
        part: "B", key: o.key, sourceId: o.sourceId, status: o.status, tiesTo: o.tiesTo,
        rationale: partBRationale(ctx.sourceById[o.sourceId], o.status),
      });
    }
  }
  item.distractorAnalysis = analysis;
  item.answerKey = { partA: aKey, partB: bKey, rationale: str(correct.rationale) };
  return item;
}

// Part B foils come from sources that don't directly support the correct claim:
// `supports-wrong-claim` (real text backing an erroneous inference) and `irrelevant` lines.
// Rank so the most tempting win — a wrong-claim source tied to a CHOSEN distractor AND to the
// correct claim (plausibly supports more than one Part A option) scores highest; irrelevant
// lines lowest. Returns the full candidate `pool` size (for the viability floor) + the best 3.
function pickPartBDistractors(correct: any, distractors: any[], ctx: any, slots = TUNING.DISTRACTOR_SLOTS): { pool: number; chosen: any[] } {
  const distractorIds = new Set(distractors.map((d) => str(d.id)));
  const correctId = str(correct.id);
  const candidates = ctx.sources.filter((s: any) => {
    const st = str(s.status);
    return st === "supports-wrong-claim" || st === "irrelevant";
  });
  const score = (s: any): number => {
    if (str(s.status) !== "supports-wrong-claim") return 0; // irrelevant
    const sup = Array.isArray(s.supports) ? s.supports.map(str) : [];
    return 0.5 + (sup.some((id: string) => distractorIds.has(id)) ? 2 : 0) + (sup.includes(correctId) ? 1 : 0);
  };
  const ranked = candidates.slice().sort((a: any, b: any) => score(b) - score(a) || str(a.id).localeCompare(str(b.id)));
  return { pool: candidates.length, chosen: ranked.slice(0, slots) };
}

function firstWrongClaim(s: any, correct: any): string {
  const ids = (Array.isArray(s.supports) ? s.supports.map(str) : []).filter((id: string) => id !== str(correct.id));
  return ids[0] || "";
}

function partBRationale(s: any, status: string): string {
  if (s && str(s.rationale)) return str(s.rationale);
  if (status === "supports-wrong-claim") return "Real evidence, but it supports a different (erroneous) inference, not the correct one.";
  return "Does not directly support the inference.";
}

// Segment the passage into selectable sentences and mark the ones the `directSources` support (the
// Hot-Text selection set). A directly-supporting source with a `quote` marks the matching sentence
// (normalized equality → containment); without a `quote` it marks every sentence of its paragraph.
// Returns the grouped-by-paragraph `selectable` plus the exact-count `selectCount` (one less than
// the valid set, capped at HOT_TEXT_SELECT_MAX, floored at 1); pushes viability warnings.
function buildSelectable(ctx: any, directSources: any[], warnings: string[]): { selectable: any[]; selectCount: number } {
  const directNoQuote = new Set(directSources.filter((s: any) => !str(s.quote)).map((s: any) => s.line));
  const directQuotes = directSources.filter((s: any) => str(s.quote)).map((s: any) => norm(str(s.quote)));
  const isCorrect = (lineId: number, text: string): boolean => {
    if (directNoQuote.has(lineId)) return true;
    const n = norm(text);
    return directQuotes.some((q) => q === n || q.includes(n) || n.includes(q));
  };
  const selectable: any[] = [];
  for (const l of ctx.passage.lines) {
    splitSentences(l.text).forEach((sentence: string, i: number) => {
      selectable.push({ id: `${l.id}.${i + 1}`, lineId: l.id, sentence: i + 1, text: sentence, correct: isCorrect(l.id, sentence) });
    });
  }
  const valid = selectable.filter((s: any) => s.correct).length;
  if (valid === 0) warnings.push("No directly-supporting evidence; Part B has no correct selection.");
  if (valid === 1) warnings.push("Only 1 valid supporting sentence; author a superset (2+ directly-supporting sentences) so the expected answer is a subset of the valid responses.");
  const selectCount = valid <= 1 ? 1 : Math.min(TUNING.HOT_TEXT_SELECT_MAX, valid - 1);
  return { selectable, selectCount };
}

// Build labeled EVIDENCE options (answerKind "evidence", e.g. T8): the correct option(s) are the
// directly-supporting sources for the given-inference claim; foils are the most tempting
// non-supporting sources. `correctMany` controls Multiple-Choice (1 correct) vs Multi-Select (the
// full directly-supporting set). Returns the options + the candidate-pool size.
function evidenceOptions(
  correct: any, directSources: any[], ctx: any, seed: string, outcomeIndex: number, correctMany: boolean,
): { options: any[]; pool: number } {
  const correctSrcs = correctMany ? directSources : directSources.slice(0, 1);
  const foilSlots = Math.max(1, (correctMany ? TUNING.MULTI_SELECT_OPTIONS : TUNING.PART_OPTIONS) - correctSrcs.length);
  const { pool, chosen } = pickPartBDistractors(correct, [], ctx, foilSlots);
  const correctOpts = correctSrcs.map((s: any) => ({ text: sourceText(s, ctx.passage), correct: true, sourceId: str(s.id) }));
  const foilOpts = chosen.map((s: any) => ({
    text: sourceText(s, ctx.passage), correct: false, sourceId: str(s.id), status: str(s.status), tiesTo: firstWrongClaim(s, correct),
  }));
  const options = correctMany
    ? labelize(seededShuffle([...correctOpts, ...foilOpts], `${seed}:ev`))
    : (correctOpts.length
      ? placeCorrect(correctOpts[0], foilOpts, seed, ctx.passage.id, "MC", outcomeIndex)
      : labelize(seededShuffle(foilOpts, `${seed}:MC`)));
  return { options, pool };
}

// Per-option analysis for evidence options (the non-correct sources), tagged part "A".
function evidenceAnalysis(options: any[], ctx: any): any[] {
  return options
    .filter((o: any) => !o.correct)
    .map((o: any) => ({
      part: "A", key: o.key, sourceId: o.sourceId, status: o.status, tiesTo: o.tiesTo,
      rationale: partBRationale(ctx.sourceById[o.sourceId], o.status),
    }));
}

// Stems are authored on the outcome (from the guideline catalog). Part A is the authored `stem`;
// EBSR Part B is the authored `stem-b`; Hot Text Part B is the fixed selection instruction. The
// two-part lead-in is added ONLY for the two-part models (EBSR, Hot Text); Short Text is a single
// constructed-response prompt with one answer box, so it carries no Part A/B lead-in.
function stemFor(itemType: string, outcome: any) {
  const stem: any = { partA: str(outcome.stem) };
  if (itemType === "ebsr") { stem.leadIn = LEAD_IN; stem.partB = str(outcome.stemB); }
  else if (itemType === "hot-text") { stem.leadIn = LEAD_IN; stem.partB = HOT_TEXT_PART_B_PLACEHOLDER; }
  return stem;
}

const SCORING: Record<string, string> = {
  "short-text": "0–2 points; hand-scored against the rubric.",
  "multiple-choice": "Correct option = 1 point; otherwise 0.",
  "multi-select": "All correct selections (and no others) = 1 point; otherwise 0.",
  "ebsr": "Both parts correct = 1 point; otherwise 0.",
  "hot-text": "Both parts correct = 1 point; otherwise 0.",
};

function baseItem(itemType: string, outcome: any, ctx: any, dim: string, dok: string, correct: any, warnings: string[]): any {
  const scoring = SCORING[itemType] || "Both parts correct = 1 point; otherwise 0.";
  const standards = standardsFor(outcome, correct, dim, ctx.profile);
  return {
    kind: "item",
    id: `${ctx.passage.id}-${str(outcome.id) || itemType + "-" + dim}`,
    type: itemType,
    target: ctx.profile.id,
    // The AUTHORED task model (e.g. "3" from `task-model tm3`), for the TM metadata
    // pill. Authored only — type→task-model is per-target and not injective, so it is
    // NOT reverse-derived; absent when the outcome omits `task-model`.
    taskModel: str(outcome.taskModel).replace(/^tm/i, "") || undefined,
    standards,
    dok,
    dimension: dim,
    passage: ctx.passage,
    passages: null,
    stem: stemFor(itemType, outcome),
    distractorAnalysis: [],
    answerKey: {},
    review: {
      target: ctx.profile.id,
      standards,
      dok,
      dimension: dim,
      scoring,
      correctClaim: correct ? { id: str(correct.id), text: str(correct.text), subject: str(correct.subject) || undefined } : null,
      alternativeClaims: 0,
    },
    warnings,
  };
}
