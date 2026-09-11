// SPDX-License-Identifier: MIT
/**
 * Classify a compiled corpus for display.
 *
 * The compiler scores each case `1` or `-1` (core/src/compiler.ts `runCorpus`), and that is
 * all it scores — it is transcribed from L120 and the recovered rule sets carry exactly those
 * values. The view needs one more distinction the score cannot carry: an EMPTY `expected`
 * means "capture what the rule set does today", which is how the original ~50-case LaTeX
 * corpus was written. Those score `-1` whenever the translation is non-empty, so showing the
 * raw score would paint an entire capture-style corpus as failing. They get their own status.
 *
 * `captured` is decided before `pass` on purpose: a capture case whose translation is also
 * empty scores `1`, but it has asserted nothing, and calling it a pass would overstate it.
 */

export type CaseStatus = "pass" | "fail" | "captured";

export interface CaseResult {
  status: CaseStatus;
  source: string;
  expected: string;
  actual: string;
}

export interface Summary {
  cases: CaseResult[];
  pass: number;
  fail: number;
  captured: number;
}

const asString = (v: unknown): string => (v == null ? "" : String(v));

export function summarize(tests: unknown): Summary {
  const out: Summary = { cases: [], pass: 0, fail: 0, captured: 0 };
  if (!Array.isArray(tests)) return out;
  for (const t of tests) {
    if (!t || typeof t !== "object") continue;
    const { score, source, expected, actual } = t as Record<string, unknown>;
    const exp = asString(expected);
    const status: CaseStatus = exp === "" ? "captured" : score === 1 ? "pass" : "fail";
    out[status]++;
    out.cases.push({ status, source: asString(source), expected: exp, actual: asString(actual) });
  }
  return out;
}
