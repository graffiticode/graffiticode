// SPDX-License-Identifier: MIT
/**
 * L0183's scoring — DOM-free and React-free, so the Learnosity scorer bundle can load it
 * server-side. It is published on its own `./scoring` subpath for exactly that reason: the
 * scorer imports from here, never from the package root, which carries the renderer.
 *
 * This implements `@graffiticode/learnosity-cqt`'s cell-scoring contract:
 *
 *   scoreCells({cells, validation})         -> the cells, each assessed one with a `score`
 *   getCellsValidation({cells, validation}) -> the answer key per cell, for "show answers"
 *
 * `cells` is the learner's response, keyed by blank id: `{n3: {value: "Receptor"}}`.
 *
 * A blank holding a distractor from its own tray scores that distractor's `points` (0 or
 * below), so a program can make a tempting wrong answer cost something. The total never goes
 * below 0.
 */

export interface CellScore {
  points: number;
  isValid: boolean;
}

export type TrayKind = "nodes" | "edges";

export interface CellKey {
  assess: { expected: string; points: number };
  pool: string;
  /** The tray the blank is filled from, which decides whose distractors it can hold. */
  tray?: TrayKind;
}

export interface Validation {
  points: number;
  cells: Record<string, CellKey>;
  /** Per tray, what each distractor scores when dropped on a blank. */
  distractors?: Partial<Record<TrayKind, Record<string, number>>>;
}

/** How two answers are compared: exactly, after trimming and collapsing whitespace. */
export const normalize = (v: unknown): string =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";

/**
 * Score one response against the key, pool by pool.
 *
 * Blanks in the same pool accept each other's answers (the compiler assigns pools to blanks
 * the learner cannot tell apart). Within a pool, a blank holding its OWN expected answer keeps
 * it first; every other answer then claims any unclaimed expected answer in the pool. So any
 * arrangement of a pool's right answers scores in full, and a duplicate answer scores once per
 * time it is expected — never more.
 */
export function scoreResponse(
  cells: Record<string, { value?: string } | undefined>,
  validation: Validation | undefined,
): Record<string, CellScore> {
  const out: Record<string, CellScore> = {};
  const key = validation?.cells || {};
  const pools = new Map<string, string[]>();
  for (const id of Object.keys(key)) {
    const p = key[id].pool ?? id;
    pools.set(p, [...(pools.get(p) || []), id]);
  }
  for (const ids of pools.values()) {
    const open = new Set(ids);
    const value = (id: string) => normalize(cells?.[id]?.value);
    // Own answers first, so a correctly placed blank is never displaced by a pool-mate.
    for (const id of ids) {
      if (value(id) && value(id) === normalize(key[id].assess.expected)) {
        out[id] = { points: key[id].assess.points, isValid: true };
        open.delete(id);
      }
    }
    for (const id of ids) {
      if (out[id]) continue;
      const v = value(id);
      const match = v ? [...open].find((k) => normalize(key[k].assess.expected) === v) : undefined;
      if (match !== undefined) {
        out[id] = { points: key[match].assess.points, isValid: true };
        open.delete(match);
      } else {
        out[id] = { points: penalty(validation, key[id], v), isValid: false };
      }
    }
  }
  return out;
}

/** What a wrong answer costs: a distractor's own `points`, else nothing. */
function penalty(validation: Validation | undefined, key: CellKey, value: string): number {
  if (!value || !key.tray) return 0;
  const costs = validation?.distractors?.[key.tray] || {};
  for (const [text, points] of Object.entries(costs)) {
    if (normalize(text) === value) return points;
  }
  return 0;
}

/** The cqt contract: the response's cells, each assessed one carrying its `score`. */
export const scoreCells = ({ cells, validation }: { cells: any; validation: any }): any => {
  const scores = scoreResponse(cells || {}, validation);
  const out: any = {};
  for (const id of Object.keys(scores)) out[id] = { ...(cells?.[id] || {}), score: scores[id] };
  return out;
};

/** The cqt contract: the answer key per assessed cell, read by its "show answers" list. */
export const getCellsValidation = ({ validation }: { cells?: any; validation: any }): any => ({
  ...(validation?.cells || {}),
});

/** Total points a response earns. Distractor penalties can take it to 0, never below. */
export const totalScore = (cells: any, validation: Validation | undefined): number =>
  Math.max(
    0,
    Object.values(scoreResponse(cells || {}, validation)).reduce((n, s) => n + s.points, 0),
  );

/**
 * The shared View's `score` binding: what its Check button reports. Reads the live model, where
 * the /form embed keeps the learner's answers in `interaction.cells`. Nothing to check — no answer
 * key, or no blanks — is `undefined`, and the View then shows no Check button.
 */
export const score = (data: any): { score: number; max: number } | undefined => {
  const validation: Validation | undefined = data?.validation;
  if (!validation || !Object.keys(validation.cells || {}).length) return undefined;
  return { score: totalScore(data?.interaction?.cells, validation), max: validation.points };
};
