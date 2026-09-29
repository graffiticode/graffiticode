// SPDX-License-Identifier: MIT
/**
 * Segmenting text into selectable units, and resolving an author's quotes onto them.
 *
 * Pure: no AST, no CPS, no compiler types. It exists as its own module because the work has to
 * happen in two places — `HOTTEXT` resolves an interaction carrying its own `text`, but a
 * `within "stimulus"` interaction cannot, since children transform before parents and the
 * stimulus does not exist yet when `HOTTEXT` runs. `ITEM` finishes those, calling the same
 * functions.
 *
 * Ported from L0175 (`l0175/packages/core/src/compiler.ts`), which is the source of the
 * segmentation, the `<paragraphId>.<n>` addressing and the tolerant quote matching. Two
 * behaviours deliberately differ; both are marked below.
 */
import { assertAssessWords } from "./attributes.js";

/** One selectable (or merely rendered) span of the text. */
export interface Unit {
  /** `p2.1` for the first sentence of paragraph 2; `w7` for the seventh word. */
  id: string;
  text: string;
  /** Word granularity only: punctuation stripped off the clickable core, re-attached by the renderer. */
  pre?: string;
  post?: string;
  selectable: boolean;
}

export interface Paragraph {
  id: string;
  text: string;
}

/** One entry of an authored `selections` list, already merged. */
export interface Selection {
  quote?: string;
  assess?: { correct?: boolean; points?: number; rationale?: string };
}

/* ------------------------------------------------------------------ Segmentation */

/**
 * Abbreviations whose trailing period does not end a sentence.
 *
 * Grade-5 literary prose is full of honorifics — "Mr. Ruiz never learned who had fixed his
 * porch." — and a bare [.!?] split cuts that in half, making "Mr." its own clickable unit.
 * The list is L0175's, unchanged.
 */
const SENTENCE_ABBREVIATIONS = [
  "mr", "mrs", "ms", "mx", "dr", "prof", "rev", "fr", "hon",
  "capt", "gen", "sgt", "lt", "col", "sen", "gov", "pres",
  "jr", "sr", "st", "mt", "ft", "rd", "ave", "blvd", "no",
  "vs", "etc", "approx", "dept",
];

const ABBREV_END = new RegExp(
  `(?:^|[\\s("'‘“])(?:${SENTENCE_ABBREVIATIONS.join("|")})\\.$`,
  "i",
);

/** True when `s` ends mid-abbreviation: a known one ("Mr."), an initial ("J."), or a dotted pair ("a.m."). */
function endsMidAbbreviation(s: string): boolean {
  return (
    ABBREV_END.test(s) ||
    /(?:^|\s)[A-Za-z]\.$/.test(s) ||
    /(?:^|\s)[A-Za-z]\.[A-Za-z]\.$/.test(s)
  );
}

/**
 * Split a paragraph into sentences.
 *
 * Heuristic: take runs ending in sentence punctuation, absorbing any trailing closing
 * quote/paren, then re-join a run that broke inside an abbreviation or before a dialogue tag.
 * Correctness is anchored to the author's `quote` rather than to the split, so a quote spanning
 * a bad boundary still matches by containment — but a bad boundary is still a spurious clickable
 * unit, which is why the two cases below are worth handling.
 *
 * Departs from L0175 twice, both because a unit here is something a candidate clicks:
 *
 * - Its regex keeps only runs ending in `.!?`, so a paragraph whose last sentence has no
 *   terminator loses it silently. Here the remainder is kept.
 * - It splits `"Stop!" she called.` in two, leaving `"Stop!"` as its own selectable sentence.
 *   L0175 calls that tolerable; in Grade-5 literary prose, which is most of what T4 and T2 use,
 *   dialogue is constant. A run starting lowercase is a continuation, never a new sentence, so
 *   it rejoins.
 */
export function splitSentences(text: string): string[] {
  const t = String(text ?? "").trim();
  if (!t) return [];
  const parts = t.match(/[^.!?]+[.!?]+["'”’)\]]*\s*/g);
  if (!parts) return [t];
  const out: string[] = [];
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    const continues = /^[a-z]/.test(piece); // a dialogue tag: `"Stop!"` + `she called.`
    if (out.length && (continues || endsMidAbbreviation(out[out.length - 1]))) {
      out[out.length - 1] += ` ${piece}`;
    } else out.push(piece);
  }
  // An unterminated tail — "…and then she left" with no full stop — is real text the candidate
  // can see, so it has to be selectable too.
  const tail = t.slice(parts.join("").length).trim();
  if (tail) {
    if (out.length && endsMidAbbreviation(out[out.length - 1])) out[out.length - 1] += ` ${tail}`;
    else out.push(tail);
  }
  return out;
}

/** Sentence units over a stimulus's paragraphs. Every sentence is selectable. */
export function sentenceUnits(paragraphs: Paragraph[]): Unit[] {
  const units: Unit[] = [];
  for (const p of paragraphs) {
    splitSentences(p.text).forEach((sentence, i) => {
      units.push({ id: `${p.id}.${i + 1}`, text: sentence, selectable: true });
    });
  }
  return units;
}

/**
 * Word units over a single run of text. Nothing is selectable until a selection names it.
 *
 * L0175 falls back to "every content word over two characters that is not a stopword" when the
 * author curates no candidates. L0180 requires a `selections` list, so the clickable words are
 * exactly the authored ones — which keeps a stopword list out of the language.
 */
export function wordUnits(text: string): Unit[] {
  return String(text ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((raw, i) => {
      const pre = (raw.match(/^[^A-Za-z0-9]+/) || [""])[0];
      const post = (raw.match(/[^A-Za-z0-9]+$/) || [""])[0];
      const core = pre.length + post.length >= raw.length ? "" : raw.slice(pre.length, raw.length - post.length);
      return { id: `w${i + 1}`, text: core || raw, pre: core ? pre : "", post: core ? post : "", selectable: false };
    });
}

/* --------------------------------------------------------------- Quote matching */

/** Case, punctuation and spacing all stop mattering, so an author's quote need not be byte-exact. */
export function norm(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Levenshtein, for naming the nearest unit when a quote matches none. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** Show a long sentence as enough of itself to be recognised in an error. */
const excerpt = (s: string, n = 60): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * Which units a quote names.
 *
 * Equality or containment in either direction, over normalized text — L0175's rule. Both
 * directions matter: a quote may span a sentence boundary the segmentation drew (so the quote
 * contains the unit), or name a phrase inside one sentence (so the unit contains the quote).
 */
function matches(units: Unit[], quote: string): Unit[] {
  const q = norm(quote);
  if (!q) return [];
  return units.filter((u) => {
    const n = norm(u.text);
    return q === n || q.includes(n) || n.includes(q);
  });
}

export interface Resolved {
  units: Unit[];
  mapping: Record<string, { correct?: boolean; points: number }>;
  feedback: Record<string, string>;
  correctIds: string[];
}

/**
 * Resolve authored selections onto segmented units.
 *
 * A quote that names nothing, or names more than one unit, is a compile ERROR here — where
 * L0175 warns and composes on. The difference is that L0175 selects from a superset it
 * generated, while an L0180 author naming a sentence that is not in the passage has written a
 * broken item, and the compiler is the only place that will ever tell them.
 */
export function resolveSelections(units: Unit[], selections: Selection[], where: string): Resolved {
  const mapping: Record<string, { correct?: boolean; points: number }> = {};
  const feedback: Record<string, string> = {};
  const correctIds: string[] = [];
  const claimed = new Map<string, number>();

  selections.forEach((sel, i) => {
    const at = `${where}: selection ${i + 1}`;
    const quote = typeof sel.quote === "string" ? sel.quote : "";
    if (!quote.trim()) {
      throw new Error(`${at}: needs a \`quote\` naming the text to select, e.g. [ quote "…" assess [ correct ] ].`);
    }

    const hits = matches(units, quote);
    if (!hits.length) {
      const q = norm(quote);
      const near = units.slice().sort((a, b) => distance(norm(a.text), q) - distance(norm(b.text), q))[0];
      throw new Error(
        `${at}: "${excerpt(quote)}" does not appear in the text. ` +
          (near ? `The closest is "${excerpt(near.text)}". ` : "") +
          "A quote must match the text it selects; copy it from the passage.",
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `${at}: "${excerpt(quote)}" matches ${hits.length} places — ` +
          `"${excerpt(hits[0].text, 40)}" and "${excerpt(hits[1].text, 40)}". ` +
          "Quote more of the surrounding text so it names one.",
      );
    }

    const unit = hits[0];
    const prior = claimed.get(unit.id);
    if (prior !== undefined) {
      throw new Error(
        `${at}: selects the same text as selection ${prior}. Each selection must name a different place.`,
      );
    }
    claimed.set(unit.id, i + 1);
    unit.selectable = true;

    const assess = sel.assess;
    if (assess === undefined) return; // a plain distractor: clickable, worth nothing, unexplained
    assertAssessWords(assess, ["correct", "points", "rationale"], at);
    const isCorrect = assess.correct === true;
    const hasPoints = typeof assess.points === "number";
    const hasRationale = typeof assess.rationale === "string";
    if (!isCorrect && !hasPoints && !hasRationale) {
      throw new Error(
        `${at}: assess must say what it asserts — \`correct\`, \`points\`, or \`rationale\`.`,
      );
    }
    if (hasRationale) feedback[unit.id] = assess.rationale as string;
    if (isCorrect) correctIds.push(unit.id);
    if (isCorrect || hasPoints) {
      const value = hasPoints ? (assess.points as number) : 1;
      mapping[unit.id] = isCorrect ? { correct: true, points: value } : { points: value };
    }
  });

  return { units, mapping, feedback, correctIds };
}
