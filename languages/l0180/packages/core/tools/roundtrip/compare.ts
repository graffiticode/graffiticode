// SPDX-License-Identifier: MIT
/**
 * Does the delivered item score the way the authored one does?
 *
 * `conformance.test.ts` proves L0180 CAN express each L0175 shape — it compiles programs a
 * person wrote. This asks the harder question the design record has been holding open: when a
 * real L0175 item goes through the hand-off and comes back as a GENERATED L0180 program, does
 * a candidate earn the same marks?
 *
 * Two things make that answerable across a language boundary:
 *
 * - **Responses are semantic.** L0175 keys `A`, `B`, `C`; L0180 derives its own ids and the
 *   generator may order the options differently. So a case says "pick the option that reads
 *   like this", and alignment turns it into ids on each side. Aligning by text is also what
 *   makes content loss visible: an option the delivered item does not have is a finding, not a
 *   comparison that quietly skips.
 * - **The expectation is L0175's rule, not L0180's output.** Every scored L0175 type is worth
 *   one point, all or nothing. Anything short of the whole key earns zero, which is why the
 *   battery is mostly near-misses: a subset, a superset, one part of two. An additive item
 *   worth 2 that awards 1 for half an EBSR passes a shape check and fails here, which is the
 *   whole point.
 *
 * Imports the scorer by relative path, as `conformance.test.ts` does — legal only because
 * `score.ts` has no DOM in its import graph.
 */
import { norm } from "../../src/hottext.js";
import { scoreInteraction, type Score } from "../../../view/src/scoring/score.js";
import { keyOf, type SourceItem, type SourcePart } from "./source.js";

/* ------------------------------------------------------------------ the delivered side */

/** One answerable thing in the compiled L0180 item, flattened the way `SourcePart` is. */
export interface TargetPart {
  /** The key a response is filed under in a multi-part item; null for a bare interaction. */
  key: string | null;
  type: string;
  options: { id: string; text: string }[];
  /** True for a response that is typed rather than picked — nothing here can be aligned. */
  written: boolean;
}

/** Everything the delivered item renders as text, wherever it puts it. */
export function deliveredText(compiled: any): string[] {
  const interaction = compiled?.interaction ?? {};
  const out: string[] = [];
  const stim = interaction.stimulus;
  for (const p of stim?.paragraphs ?? []) out.push(String(p?.text ?? ""));
  const parts = interaction.type === "item" ? (interaction.parts ?? []) : [interaction];
  for (const p of parts) {
    for (const u of p?.units ?? []) out.push(String(u?.text ?? ""));
  }
  return out.filter(Boolean);
}

const pickable = (part: any): { id: string; text: string }[] => {
  if (part?.type === "choice") {
    return (part.options ?? []).map((o: any) => ({ id: String(o?.id), text: String(o?.text ?? "") }));
  }
  if (part?.type === "hottext") {
    return (part.units ?? [])
      .filter((u: any) => u?.selectable)
      .map((u: any) => ({ id: String(u?.id), text: String(u?.text ?? "") }));
  }
  return [];
};

export function readTarget(compiled: any): { parts: TargetPart[]; isItem: boolean } {
  const interaction = compiled?.interaction ?? {};
  const raw = interaction.type === "item" ? (interaction.parts ?? []) : [interaction];
  return {
    isItem: interaction.type === "item",
    parts: raw.map((p: any, i: number) => ({
      key: interaction.type === "item" ? String(p?.id ?? i + 1) : null,
      type: String(p?.type ?? ""),
      options: pickable(p),
      written: p?.type === "extended-text" || p?.type === "text-entry",
    })),
  };
}

/* ------------------------------------------------------------------------- alignment */

/**
 * Which delivered option is this authored one?
 *
 * Equality over normalized text first, then containment either way — hottext's rule, for the
 * same reason: a generator may split, join or re-punctuate a sentence without changing what it
 * says. An exact match always wins over a containment, so a sentence that contains a shorter
 * one cannot steal it.
 */
function findOption(target: TargetPart, text: string): string | null {
  const q = norm(text);
  if (!q) return null;
  const exact = target.options.filter((o) => norm(o.text) === q);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const loose = target.options.filter((o) => {
    const n = norm(o.text);
    return n.includes(q) || q.includes(n);
  });
  return loose.length === 1 ? loose[0].id : null;
}

export interface Alignment {
  /** Per source part, its authored option text mapped to the delivered option's id. */
  ids: Record<string, string>[];
  problems: string[];
  matched: number;
  total: number;
}

export function align(
  source: SourceItem,
  target: ReturnType<typeof readTarget>,
  compiled: any,
): Alignment {
  const problems: string[] = [];
  const ids: Record<string, string>[] = [];
  let matched = 0;
  let total = 0;

  // A hand-scored source has no answered parts to align, and the written-part check below is
  // the one that matters for it.
  if (!source.handScored && source.parts.length !== target.parts.length) {
    problems.push(
      `${source.type} has ${source.parts.length} answered part(s); the delivered item has ` +
        `${target.parts.length} (${target.parts.map((p) => p.type).join(", ") || "none"})`,
    );
  }
  // A hand-scored source delivered as anything auto-scoring is a fidelity failure by itself:
  // L0175 says a person marks it, and text-entry would mark it in the browser.
  if (source.handScored) {
    const written = target.parts.filter((p) => p.type === "extended-text").length;
    if (written !== 1) {
      problems.push(
        `short-text is hand-scored, but the delivered item has ${written} extended-text part(s) ` +
          `(${target.parts.map((p) => p.type).join(", ") || "none"})`,
      );
    }
  }

  // The passage is content, not key material, so nothing above would miss its absence: an item
  // that dropped it scores every response exactly right and asks a question nobody can answer.
  if (source.passage.length) {
    const rendered = deliveredText(compiled).map(norm);
    const lost = source.passage.filter((line) => {
      const n = norm(line);
      return !rendered.some((r) => r === n || r.includes(n) || n.includes(r));
    });
    if (lost.length) {
      problems.push(
        `the passage lost ${lost.length} of ${source.passage.length} lines, starting ` +
          `${JSON.stringify(excerpt(lost[0]))}`,
      );
    }
  }

  source.parts.forEach((sp, i) => {
    const tp = target.parts[i];
    const map: Record<string, string> = {};
    if (!tp) {
      ids.push(map);
      return;
    }
    for (const opt of sp.options) {
      total++;
      const id = findOption(tp, opt.text);
      if (id) {
        matched++;
        map[opt.text] = id;
      } else {
        problems.push(
          `part ${sp.label}: no delivered option reads like ${JSON.stringify(excerpt(opt.text))}` +
            (opt.correct ? " (it is part of the key)" : ""),
        );
      }
    }
    ids.push(map);
  });

  return { ids, problems, matched, total };
}

const excerpt = (s: string, n = 56): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/* -------------------------------------------------------------------------- the battery */

/** A response written the only way both languages understand: as the text of what was picked. */
export interface Case {
  name: string;
  /** Per part, in `source.parts` order, the option texts the candidate picked. */
  picks: string[][];
  /** What L0175's SCORING rule says this earns. */
  expected: { points: number; correct: boolean; pending?: boolean };
}

const wrongOf = (p: SourcePart): string[] => {
  const wrong = p.options.find((o) => !o.correct);
  return wrong ? [wrong.text] : [];
};

/**
 * Every case but the first is a near-miss, because near-misses are where the two scoring models
 * come apart. Per-option points award half an EBSR; L0175 awards nothing.
 */
export function battery(source: SourceItem): Case[] {
  if (source.handScored) {
    return [
      {
        name: "a written response waits for a person",
        picks: [],
        expected: { points: 0, correct: false, pending: true },
      },
    ];
  }

  const key = source.parts.map(keyOf);
  const zero = { points: 0, correct: false };
  const cases: Case[] = [
    { name: "the whole key", picks: key, expected: { points: source.points, correct: true } },
    { name: "nothing selected", picks: source.parts.map(() => []), expected: zero },
  ];

  source.parts.forEach((p, i) => {
    const label = source.parts.length > 1 ? ` in part ${p.label}` : "";
    const swap = (picks: string[]) => key.map((k, j) => (j === i ? picks : k));

    if (wrongOf(p).length) {
      cases.push({ name: `a distractor${label}`, picks: swap(wrongOf(p)), expected: zero });
    }
    if (p.exactSet) {
      const corrects = keyOf(p);
      cases.push({
        name: `all but one of the key${label}`,
        picks: swap(corrects.slice(0, -1)),
        expected: zero,
      });
      if (wrongOf(p).length) {
        cases.push({
          name: `the key plus a distractor${label}`,
          picks: swap([...corrects, ...wrongOf(p)]),
          expected: zero,
        });
      }
    }
    if (source.parts.length > 1) {
      cases.push({
        name: `only part ${p.label} answered`,
        picks: source.parts.map((_, j) => (j === i ? key[j] : [])),
        expected: zero,
      });
    }
  });

  return cases;
}

/* ------------------------------------------------------------------------- comparison */

export interface CaseResult {
  name: string;
  expected: Case["expected"];
  actual: { points: number; maxPoints: number; correct: boolean; pending: boolean };
  ok: boolean;
  note?: string;
}

export interface Report {
  id: string;
  type: string;
  scoring: string;
  aligned: { matched: number; total: number };
  problems: string[];
  cases: CaseResult[];
  /** True when nothing is unaligned, the item is worth what L0175 says, and every case agrees. */
  ok: boolean;
}

/** Turn a semantic case into the response shape the delivered item is keyed by. */
function responseFor(
  picks: string[][],
  target: ReturnType<typeof readTarget>,
  alignment: Alignment,
): unknown {
  const perPart = picks.map((texts, i) =>
    texts.map((t) => alignment.ids[i]?.[t]).filter((id): id is string => !!id),
  );
  if (!target.isItem) return perPart[0] ?? [];
  const out: Record<string, unknown> = {};
  target.parts.forEach((p, i) => {
    if (p.key) out[p.key] = perPart[i] ?? [];
  });
  return out;
}

export function compare(source: SourceItem, compiled: any): Report {
  const target = readTarget(compiled);
  const alignment = align(source, target, compiled);
  const problems = [...alignment.problems];

  const cases: CaseResult[] = battery(source).map((c) => {
    const response = source.handScored ? writtenResponse(target) : responseFor(c.picks, target, alignment);
    const score: Score = scoreInteraction({
      interaction: compiled?.interaction,
      validation: compiled?.validation,
      response,
    });
    const actual = {
      points: score.points,
      maxPoints: score.maxPoints,
      correct: score.correct === true,
      pending: score.pending === true,
    };
    const ok =
      actual.points === c.expected.points &&
      actual.correct === c.expected.correct &&
      actual.pending === (c.expected.pending === true);
    return { name: c.name, expected: c.expected, actual, ok };
  });

  // Worth the same, not merely graded the same way: an EBSR delivered additively can award the
  // right zero on every near-miss and still be out of 2.
  const max = cases[0]?.actual.maxPoints;
  if (max !== undefined && max !== source.points) {
    problems.push(`worth ${max} point(s); L0175 says ${source.points} — "${source.scoring}"`);
  }

  return {
    id: source.id,
    type: source.type,
    scoring: source.scoring,
    aligned: { matched: alignment.matched, total: alignment.total },
    problems,
    cases,
    ok: problems.length === 0 && cases.every((c) => c.ok),
  };
}

/** Something for a written part to hold. Nothing reads it — the point is that nothing scores it. */
function writtenResponse(target: ReturnType<typeof readTarget>): unknown {
  const text = "The narrator changes because of what she notices, and the passage shows it.";
  if (!target.isItem) return text;
  const out: Record<string, unknown> = {};
  target.parts.forEach((p) => {
    if (p.key) out[p.key] = text;
  });
  return out;
}
