// SPDX-License-Identifier: MIT
/**
 * A sentence with holes, filled from a shared bank of tokens.
 *
 * Pure — no AST, no CPS — like every other builder here.
 *
 * The second interaction assembled from two halves that already existed, as `inline-choice` was:
 * the sentence and its `{{id}}` markers are `text-entry`'s, through `cutMarkers`, and the key is
 * `match`'s, a mapping over pairs of identifiers. That is not a shortcut, it is what the thing
 * IS — QTI models `gapMatchInteraction` with a `directedPair` response too — and it is why the
 * scorer needs nothing new: `scorePairs` already sums per pairing and already requires the exact
 * set to call a response correct.
 *
 * **What separates it from `inline-choice`, which also puts holes in a sentence:** a dropdown's
 * options belong to its own hole, and every hole offers its own menu. Here one bank is shared
 * across every gap and a token spent in one is gone from the others, so answering is partly a
 * process of elimination. Different question, different word.
 */
import { cutMarkers, type MarkerWords, type TextSegment } from "./textentry.js";
import { readPlaces, type PairWords, type Place } from "./pairing.js";

/** One hole in the sentence: named by its marker, and saying which token belongs in it. */
export interface Gap {
  id?: string;
  assess?: { token?: string; points?: number; rationale?: string };
}

/** A gap as the browser sees it — which hole, and nothing about what fills it. */
export interface GapSegment {
  id: string;
  gap: true;
}

export type Segment = TextSegment | GapSegment;

export interface Filled {
  segments: Segment[];
  tokens: { id: string; text: string }[];
  mapping: Record<string, { correct?: true; points: number; rationale?: string }>;
  correctResponse: string[];
  points: number;
}

const WORDS: MarkerWords = {
  one: "gap",
  list: "gaps",
  marker: "{{a}}",
  sentence: "The {{a}} orbits the {{b}}.",
  unit: "hole",
  fill: "be dragged into it",
};

/** The bank is a list of places, read exactly as a match's targets are. */
const BANK: PairWords = {
  container: "gap-match",
  key: "token",
  list: "tokens",
  itemList: "gaps",
  place: "token",
  oneToOne: true,
};

export function fill(text: string, gaps: Gap[], tokens: Place[]): Filled {
  const { known, resolved } = readPlaces(tokens, BANK);

  const declared = new Map<string, { id: string }>();
  const mapping: Record<string, { correct?: true; points: number; rationale?: string }> = {};
  const correctResponse: string[] = [];
  const spent = new Map<string, number>();
  let points = 0;

  gaps.forEach((gap, i) => {
    const at = `gap-match: gap ${i + 1}`;
    const id = typeof gap.id === "string" ? gap.id.trim() : "";
    if (!id) {
      throw new Error(
        `${at}: needs an \`id\`, which is the marker that positions it — ` +
          'e.g. [ id "a" assess [ token "moon" ] ] with {{a}} in the text.',
      );
    }
    if (declared.has(id)) {
      throw new Error(`${at}: the id "${id}" is already used. Each gap needs its own.`);
    }

    const belongs = gap.assess?.token;
    if (belongs === undefined) {
      throw new Error(
        `${at}: needs \`assess [token "…"]\` saying which token fills it, naming one of the ` +
          `tokens: ${[...known.keys()].join(", ")}.`,
      );
    }
    if (!known.has(belongs)) {
      throw new Error(
        `${at}: no token has the id "${belongs}". ` +
          `\`tokens\` declares: ${[...known.keys()].join(", ")}.`,
      );
    }
    // A token is dragged, not copied: once it is in one gap it has left the bank. Two gaps
    // wanting the same one is an item nobody can complete.
    const already = spent.get(belongs);
    if (already !== undefined) {
      throw new Error(
        `${at}: gap ${already} already takes "${belongs}", and a token can only be dragged into ` +
          "one gap. Add another token for this one, or use `inline-choice`, where each hole has " +
          "its own menu and an answer may repeat.",
      );
    }
    spent.set(belongs, i + 1);
    declared.set(id, { id });

    const value = typeof gap.assess?.points === "number" ? gap.assess.points : 1;
    const rationale = gap.assess?.rationale;
    const pairId = `${id} ${belongs}`;
    mapping[pairId] = {
      correct: true,
      points: value,
      ...(typeof rationale === "string" ? { rationale } : {}),
    };
    correctResponse.push(pairId);
    points += value;
  });

  const segments = cutMarkers(text, declared, WORDS, "gap-match", (id) => ({
    id,
    gap: true as const,
  }));

  return { segments, tokens: resolved, mapping, correctResponse, points };
}
