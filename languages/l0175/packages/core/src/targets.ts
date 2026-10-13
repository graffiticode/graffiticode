// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// SINGLE SOURCE OF TRUTH for L0175's per-target structure.
//
// Everything the compiler enforces about a learning target lives here — and ONLY here.
// `compiler.ts` builds its runtime `TARGETS` profiles from this data; `tools/build-static.js`
// emits a served `targets.json` from it and GENERATES the per-target tables in the spec
// `.md` files (instructions.md, stems.md) from it. The `.md` files are the generator-facing
// flip side of this data: they carry MORE (narrative, stems, examples) but must EMPHASIZE
// everything here — nothing structural the compiler checks may be absent from what the
// generator reads. To add or change a target fact, edit this file; the compiler and the docs
// follow.
//
// This is plain data (no logic) so it round-trips to JSON. It is a typed `.ts` module rather
// than a raw `.json` import because core compiles to ESM under NodeNext, where JSON imports
// need version-fragile import attributes; build-static serializes it to `dist/static/targets.json`
// for non-TS consumers (the console RAG pipeline) and humans.

export const TARGETS_REVISED = "2026-08-28";

// CCSS Grade-5 reading-standard families. A target's `standards` is the full strand for its
// text type, so any plausible CCSS code for that text type validates (the `dimStandard` map
// still picks the right companion by default). RL.8 is "not applicable to literature";
// RL.10/RI.10 are range-of-reading bands, not discrete item standards.
export const STANDARD_FAMILIES = {
  RL_G5: ["rl-1", "rl-2", "rl-3", "rl-4", "rl-5", "rl-6", "rl-7", "rl-9"],
  RI_G5: ["ri-1", "ri-2", "ri-3", "ri-4", "ri-5", "ri-6", "ri-7", "ri-8", "ri-9"],
  L_G5: ["l-4", "l-4a", "l-4b", "l-4c", "l-5", "l-5a", "l-5b", "l-5c"], // vocabulary (T10)
} as const;

export type StandardFamily = keyof typeof STANDARD_FAMILIES;

// One target's structural facts. Arrays/objects only (JSON-serializable); the compiler
// reconstructs Sets and expands `standards` families.
export type TargetData = {
  id: string; // the `target` tag, e.g. "c1-t4"
  label: string;
  grade: number; // the guideline's grade band — the default reading-level target
  // The reading SKILL this target assesses. Targets pair up as skill × textType (Reasoning &
  // Evidence is c1-t4 literary / c1-t11 informational, and so on), which is exactly how a request
  // is routed to a target — so the pairing is data here rather than a map duplicated in the RAG
  // layer and the docs. Word Meanings currently exists only in its informational form.
  skill: "reasoning-evidence" | "central-ideas" | "key-details" | "word-meanings";
  textType: "literary" | "informational";
  baseStandard: string; // always added by standardsFor (the cite-evidence standard)
  defaultDok: string; // DOK for this target's selected-response items (short-text bumps to r-dok3)
  // What the answer options are made of: "statement" → options are claims (T4/T11/T9);
  // "evidence" → the inference is GIVEN and options are passage sources (T8 Key Details);
  // "meaning" → options are candidate meanings of a targeted word (T10 Word Meanings).
  answerKind: "statement" | "evidence" | "meaning";
  // Hot Text shape: true → single-part (click the supporting / main-idea sentences). Only
  // Reasoning & Evidence pairs Hot Text with a statement Part A (two-part), so T4/T11 are false.
  singlePartHotText: boolean;
  // Per-target TASK-MODEL numbering → item type. Task-model numbers are PER-TARGET and collide
  // across targets (e.g. tm3 = short-text in T4/T11, ebsr in T9, hot-text in T8/T10), so a bare
  // number is meaningless without its target. The compiler resolves an authored `task-model`
  // against this map; the allowed item-type set is derived from its values.
  taskModels: Record<string, string>;
  standards: StandardFamily[]; // families; the compiler expands to the union of their codes
  dimensions: string[];
  errorTypes: string[]; // distractor taxonomy (ordered for coverage selection)
  dimStandard: Record<string, string>; // dimension → companion standard
};

// Route a (skill, textType) pair to its target — the skill × text-type grid the docs present to
// the generator. `textType` may be omitted when a request names a skill but no genre; the literary
// target wins then, per the spec's "when the text type is ambiguous, prefer the literary target",
// falling back to the skill's only form (Word Meanings has no literary target).
export function targetForSkill(skill: string, textType?: string): TargetData | undefined {
  const all = Object.values(TARGETS_DATA).filter((d) => d.skill === skill);
  if (!all.length) return undefined;
  if (textType) return all.find((d) => d.textType === textType) ?? all[0];
  return all.find((d) => d.textType === "literary") ?? all[0];
}

// Reverse lookup: the task-model NUMBER for a (target, item type) — e.g. ("c1-t9", "ebsr") → "3",
// ("c1-t4", "short-text") → "3". Item-type → task-model is per-target (the numbers collide), so the
// target is required. Returns undefined if the target doesn't offer that item type. Used by the RAG
// signature so a number-phrased query ("task model 3") can match a target's correct exemplar.
export function taskModelNumber(target: string, itemType: string): string | undefined {
  const tms = TARGETS_DATA[target]?.taskModels;
  if (!tms) return undefined;
  const key = Object.keys(tms).find((k) => tms[k] === itemType);
  return key ? key.replace(/^tm/, "") : undefined;
}

// Distractor error taxonomies reused across targets. Reasoning & Evidence (T4/T11) classifies
// foils by reasoning failure; Central Ideas (T9) by SIGNIFICANCE (a true statement that just
// isn't the central idea); Word Meanings (T10) by meaning error.
const RE_ERROR_TYPES = ["misreads-detail", "erroneous-inference", "faulty-reasoning"];
// Shared by BOTH Central Ideas targets (T9 informational, T2 literary): their guidelines describe
// the same two distractor failures — misinterpreting a detail, and misjudging the SIGNIFICANCE of
// ideas and details — which this taxonomy splits into a misread plus three significance errors.
const CENTRAL_IDEA_ERROR_TYPES = ["too-narrow", "too-broad", "misreads-detail", "insignificant"];

// R&E (T4/T11) and the single-select families share task-model layouts.
const RE_TASK_MODELS = { tm1: "ebsr", tm2: "hot-text", tm3: "short-text" };
const SELECT_TASK_MODELS = { tm1: "multiple-choice", tm2: "multi-select", tm3: "hot-text" };
// Central Ideas (T9/T2) is the only family that offers all five item types, so its numbering
// reaches tm5. NOTE tm3 is EBSR here but hot-text in the SELECT_TASK_MODELS targets.
const CENTRAL_IDEA_TASK_MODELS = {
  tm1: "multiple-choice", tm2: "multi-select", tm3: "ebsr", tm4: "hot-text", tm5: "short-text",
};

export const TARGETS_DATA: Record<string, TargetData> = {
  // Claim 1 · Target 4 — Reasoning & Evidence, literary texts (RL standards). The original L0175.
  "c1-t4": {
    id: "c1-t4",
    label: "Grade 5 · Claim 1 · Target 4 (Reasoning & Evidence)",
    grade: 5,
    skill: "reasoning-evidence",
    textType: "literary",
    baseStandard: "rl-1",
    defaultDok: "r-dok3",
    answerKind: "statement",
    singlePartHotText: false,
    taskModels: RE_TASK_MODELS,
    standards: ["RL_G5"],
    dimensions: [
      "character", "setting", "event", "point-of-view",
      "theme", "topic", "narrators-feelings", "character-relationship",
    ],
    errorTypes: RE_ERROR_TYPES,
    dimStandard: {
      "character": "rl-3", "character-relationship": "rl-3", "setting": "rl-3", "event": "rl-3",
      "point-of-view": "rl-6", "narrators-feelings": "rl-6",
      // theme/topic = determine-the-theme/summarize → RL.2 (the CCSS theme standard), not the
      // cross-text-comparison RL.9.
      "theme": "rl-2", "topic": "rl-2",
    },
  },
  // Claim 1 · Target 11 — Reasoning & Evidence, informational texts (RI standards).
  "c1-t11": {
    id: "c1-t11",
    label: "Grade 5 · Claim 1 · Target 11 (Reasoning & Evidence)",
    grade: 5,
    skill: "reasoning-evidence",
    textType: "informational",
    baseStandard: "ri-1",
    defaultDok: "r-dok3",
    answerKind: "statement",
    singlePartHotText: false,
    taskModels: RE_TASK_MODELS,
    standards: ["RI_G5"],
    dimensions: [
      "relationships-interactions", "author-use-of-information",
      "point-of-view", "purpose", "authors-opinion",
    ],
    errorTypes: RE_ERROR_TYPES,
    dimStandard: {
      "relationships-interactions": "ri-3",
      "author-use-of-information": "ri-8",
      "point-of-view": "ri-6",
      "purpose": "ri-8",
      "authors-opinion": "ri-8",
    },
  },
  // Claim 1 · Target 2 — Central Ideas, LITERARY texts (RL-1 + RL-2). The literary twin of T9, and
  // the only other target offering all five item types. Its own emphases, from the guideline:
  //   - THEME leads. RL-2 is "determine a theme of a story, drama, or poem from details in the
  //     text … summarize the text", so `theme` is a first-class dimension here, not a T4 borrowing.
  //   - SUMMARY IS SCOPED. "Items will not ask students to summarize the entire text; students will
  //     summarize a key event(s) or idea(s)." T9 has no such limit — this is the sharpest T2/T9
  //     difference and the docs must carry it.
  //   - `key-detail` covers the guideline's "key event(s) or idea(s)" — in a story the key details
  //     that build a theme are usually events, so they share one dimension rather than splitting a
  //     single skill across two tags the compiler treats identically.
  // Every dimension answers to RL-2 (the theme/summarize standard); RL-1 is added as the base, so a
  // composed item's standards is ["rl-1", "rl-2"] — exactly the guideline's pair.
  "c1-t2": {
    id: "c1-t2",
    label: "Grade 5 · Claim 1 · Target 2 (Central Ideas)",
    grade: 5,
    skill: "central-ideas",
    textType: "literary",
    baseStandard: "rl-1",
    defaultDok: "r-dok2", // tm5 short-text bumps to r-dok3 (dokFor), per the guideline
    answerKind: "statement",
    singlePartHotText: true, // T2 Hot Text (tm4): click the sentence(s) that show the theme
    taskModels: CENTRAL_IDEA_TASK_MODELS,
    standards: ["RL_G5"],
    dimensions: ["theme", "central-idea", "key-detail", "summary"],
    errorTypes: CENTRAL_IDEA_ERROR_TYPES,
    dimStandard: {
      "theme": "rl-2",
      "central-idea": "rl-2",
      "key-detail": "rl-2",
      "summary": "rl-2",
    },
  },
  // Claim 1 · Target 9 — Central Ideas, informational texts (RI-1 + RI-2). A DIFFERENT skill from
  // Reasoning & Evidence: whole-text synthesis and significance (the main idea, the key details that
  // build it, and summary), DOK 2 (3 only for the written summary). Distractors are a SIGNIFICANCE
  // taxonomy — usually true statements that just aren't the central idea. The only non-R&E target
  // that allows EBSR and short-text, so its task-model numbering reaches tm5.
  "c1-t9": {
    id: "c1-t9",
    label: "Grade 5 · Claim 1 · Target 9 (Central Ideas)",
    grade: 5,
    skill: "central-ideas",
    textType: "informational",
    baseStandard: "ri-1",
    defaultDok: "r-dok2",
    answerKind: "statement",
    singlePartHotText: true, // T9 Hot Text (tm4): click the sentence(s) that show the main idea
    taskModels: CENTRAL_IDEA_TASK_MODELS,
    standards: ["RI_G5"],
    dimensions: ["central-idea", "key-detail", "summary"],
    errorTypes: CENTRAL_IDEA_ERROR_TYPES,
    dimStandard: {
      "central-idea": "ri-2",
      "key-detail": "ri-2",
      "summary": "ri-2",
    },
  },
  // Claim 1 · Target 1 — Key Details, LITERARY texts (RL-1 only). The literary mirror of T8: the
  // inference/conclusion is GIVEN in the stem and the student selects the supporting EVIDENCE
  // (answerKind "evidence"), same three task models. Unlike T8 the guideline lists NO companion
  // standard — RL-1 (quote accurately / draw inferences) is the whole of it, so `dimStandard` maps
  // back to the base and an item's `standards` is just ["rl-1"]. Its literary stems say
  // "[author/narrator]" and add "line" as a selectable unit; Multi-Select is exactly TWO correct
  // (T8 allows two or three). DOK 1–2 (default 2).
  "c1-t1": {
    id: "c1-t1",
    label: "Grade 5 · Claim 1 · Target 1 (Key Details)",
    grade: 5,
    skill: "key-details",
    textType: "literary",
    baseStandard: "rl-1",
    defaultDok: "r-dok2",
    answerKind: "evidence",
    singlePartHotText: true,
    taskModels: SELECT_TASK_MODELS,
    standards: ["RL_G5"],
    dimensions: ["supporting-evidence"],
    errorTypes: [], // like T8, wrong answers are non-supporting sources, not distractor claims
    dimStandard: {
      "supporting-evidence": "rl-1", // no companion in the guideline — RL-1 stands alone
    },
  },
  // Claim 1 · Target 8 — Key Details, informational texts (RI-1 + RI-7). A DIFFERENT model: the
  // inference/conclusion is GIVEN in the stem and the student selects the supporting EVIDENCE
  // (answerKind "evidence"). Options are passage sources, not claims; no statement Part A, no
  // EBSR/short-text. DOK 1–2 (default 2).
  "c1-t8": {
    id: "c1-t8",
    label: "Grade 5 · Claim 1 · Target 8 (Key Details)",
    grade: 5,
    skill: "key-details",
    textType: "informational",
    baseStandard: "ri-1",
    defaultDok: "r-dok2",
    answerKind: "evidence",
    singlePartHotText: true,
    taskModels: SELECT_TASK_MODELS,
    standards: ["RI_G5"],
    dimensions: ["supporting-evidence"],
    errorTypes: [], // T8 wrong answers are non-supporting sources, not distractor claims
    dimStandard: {
      "supporting-evidence": "ri-7",
    },
  },
  // Claim 1 · Target 10 — Word Meanings, informational texts (RI-4 + the L-4 family). The most
  // different model: the question asks for the MEANING of a targeted word/phrase in context, so the
  // options are candidate MEANINGS (answerKind "meaning"), authored as `word`/`meaning`, not claims.
  // DOK 1–2. The strategy (context / roots & affixes / word relationships / reference) is expressed
  // via the authored standard (l-4a / l-4b / l-5c / l-4c).
  "c1-t10": {
    id: "c1-t10",
    label: "Grade 5 · Claim 1 · Target 10 (Word Meanings)",
    grade: 5,
    skill: "word-meanings",
    textType: "informational",
    baseStandard: "ri-4",
    defaultDok: "r-dok2",
    answerKind: "meaning",
    singlePartHotText: false, // T10 Hot Text is word-level (composeWordMeaning), not sentence-level
    taskModels: SELECT_TASK_MODELS,
    standards: ["RI_G5", "L_G5"],
    dimensions: ["word-meaning"],
    errorTypes: ["other-meaning", "misinterprets", "wrong-context"],
    dimStandard: {
      "word-meaning": "l-4",
    },
  },
};
