// SPDX-License-Identifier: MIT
/**
 * A memo for cell evaluation.
 *
 * WHY THIS EXISTS. One formula evaluation costs 3-17 ms, all of it inside TransLaTeX's
 * `translate()`; a literal costs ~0 ms and every other engine operation is under 0.05 ms. So the
 * cost of the whole system is the number of times a formula is parsed. `buildTranslator` is free —
 * it returns a closure — so caching the TRANSLATOR, which the shape of the code invites, is worth
 * nothing. Caching the RESULT is worth everything.
 *
 * THE KEY IS CONTENT-ADDRESSED, which is what makes this safe: a cell's value is a function of its
 * own text, its format, and the values of the cells it reads. Nothing else. There is therefore no
 * invalidation protocol to get wrong and no way for an entry to go stale — a changed input is a
 * different key. That is also why one cache can serve several sheets at once.
 *
 * Deliberately NOT keyed on a generation counter or on object identity. The renderer replaces the
 * cells object on essentially every transaction, so identity keying would miss on every edit, and
 * a generation counter would be wrong the moment some path forgot to bump it.
 *
 * THE INVARIANT THIS DEPENDS ON: no TransLaTeX expander reads any field of a cell except `.val`.
 * `getCellValue` and `$cell` in `spreadsheetExpanders.js` both read `env[NAME]?.val`, and `$range`
 * expands `A1:A3` by string arithmetic without touching the env at all. If a rule set ever starts
 * reading `.type` or `.text` off the env, this key becomes incomplete and must grow to match.
 * `../perf.test.ts` documents that assumption with a test rather than leaving it implicit.
 *
 * OWNERSHIP IS THE CALLER'S, and this matters more than the mechanism. There is no module-level
 * instance and there must never be one: a shared `Map` here would be correct (content-addressed
 * keys cannot go stale) and fast, and it would grow without bound inside a warm Learnosity scorer
 * process, holding every tenant's cell values live. The engine knows HOW to cache; the caller owns
 * WHEN IT DIES. `scoreCells` creates one as a local and drops it on return; the renderer keeps one
 * per editor, which dies with the editor.
 */

// Written as escapes, not literal control characters, so they are visible in the source. They
// cannot occur in a formula, a format string or a cell value, and ABSENT is deliberately distinct
// from a cell whose `val` is the empty string — see `evalKey`.
const UNIT = "\u0000";
const JOIN = "\u0001";
const ABSENT = "\u0002";

export interface SheetCache {
  /** evalCell results, keyed by `evalKey`. */
  values: Map<string, any>;
  /** formatCellValue results, keyed by `formatKey`. */
  formats: Map<string, any>;
  max: number;
}

export const createSheetCache = (max = 4096): SheetCache =>
  ({ values: new Map(), formats: new Map(), max });

/**
 * The cache key for evaluating `name`.
 *
 * The ABSENT sentinel for a dependency that is not in the map is load-bearing, and not an edge
 * case: `Object.keys(env)` becomes the parser's identifier table, so whether a referenced name
 * EXISTS changes how the formula parses, not merely what it looks up. `=A1+Q7` evaluates to "11"
 * when Q7 is in the map and "10" when it is not. A key that could not tell those apart would
 * return the wrong one.
 */
export const evalKey = (cells: any, name: string, deps: string[]): string => {
  const cell = cells[name] || {};
  let key = (cell.text ?? "") + UNIT + (cell.format ?? "") + UNIT;
  for (const dep of deps) {
    const d = cells[dep];
    key += (d === undefined ? ABSENT : String(d.val ?? "")) + JOIN;
  }
  return key;
};

/**
 * The key for FORMATTING a cell.
 *
 * `formatCellValue` reads exactly three fields off the cell — `val`, `type` and `format` — and
 * nothing else from the environment, so those three are the whole key. The JS type of `val` is
 * included because the function branches on `typeof result === "number"`, so 5 and "5" are not
 * interchangeable inputs.
 *
 * Worth the memo because formats repeat: a real 336-cell sheet was measured with 266 formatted
 * cells and exactly TWO distinct format strings, and formatting them cost 111 ms of parsing.
 */
export const formatKey = (cell: any): string => (
  (typeof cell?.val) + UNIT + String(cell?.val ?? "") + UNIT +
  String(cell?.type ?? "") + UNIT + String(cell?.format ?? "") +
  // A fraction displays as typed, so `3/4` and `6/8` (both 0.75) must not share an entry.
  (cell?.type === "fraction" ? UNIT + String(cell?.formula ?? cell?.text ?? "") : "")
);

/** Bounded, oldest-first. Stops a long editing session growing either map without limit. */
const remember = (cache: SheetCache, map: Map<string, any>, key: string, value: any): any => {
  if (map.size >= cache.max) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
  return value;
};

export const cacheGet = (cache: SheetCache | undefined, key: string): any =>
  cache && cache.values.get(key);

export const cacheSet = (cache: SheetCache | undefined, key: string, value: any): any => (
  cache ? remember(cache, cache.values, key, value) : value
);

export const formatCacheGet = (cache: SheetCache | undefined, key: string): any =>
  cache && cache.formats.get(key);

export const formatCacheSet = (cache: SheetCache | undefined, key: string, value: any): any => (
  cache ? remember(cache, cache.formats, key, value) : value
);
