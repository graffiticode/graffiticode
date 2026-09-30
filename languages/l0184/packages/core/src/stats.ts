// SPDX-License-Identifier: MIT
/**
 * Statistics computed at compile time. Pure, and every function handles empty input before
 * applying a formula.
 */

/** Sturges' rule: `ceil(log2(n) + 1)` bins for n ≥ 1 observations. */
export const sturges = (n: number): number => Math.ceil(Math.log2(n) + 1);

/** A number written with `p` significant digits, without trailing zeros. */
const sig = (x: number, p: number): string => String(Number(x.toPrecision(p)));

/**
 * Edge labels at the fewest significant digits (at least 3) that keep every adjacent pair of
 * edges distinct, so no two bins read the same.
 */
export function edgeLabels(edges: number[]): string[] {
  for (let p = 3; p <= 17; p++) {
    const out = edges.map((e) => sig(e, p));
    if (out.every((s, i) => i === 0 || s !== out[i - 1])) return out;
  }
  return edges.map((e) => String(e));
}

/**
 * Equal-width bins over [min, max]: each bin is `[lower, upper)`, and the last is
 * `[lower, max]`, so the maximum is counted. Constant data is one bin labelled with its value.
 * Counts always sum to the number of observations.
 */
export function histogram(values: number[], binCount?: number): { labels: string[]; counts: number[] } {
  const n = values.length;
  if (n === 0) return { labels: [], counts: [] };
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return { labels: [sig(min, 3)], counts: [n] };
  const k = binCount ?? sturges(n);
  const width = (max - min) / k;
  const edges = Array.from({ length: k + 1 }, (_, i) => (i === k ? max : min + i * width));
  const counts = new Array(k).fill(0);
  for (const v of values) {
    let i = Math.min(k - 1, Math.floor((v - min) / width));
    // Floating-point can put a value a bin off at an edge; settle it against the edges themselves.
    while (i > 0 && v < edges[i]) i--;
    while (i < k - 1 && v >= edges[i + 1]) i++;
    counts[i]++;
  }
  const e = edgeLabels(edges);
  return { labels: counts.map((_, i) => `${e[i]}–${e[i + 1]}`), counts };
}

/** The R-7 (linear interpolation) quantile of sorted values. NaN for no values. */
export function quantileR7(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * A box: `[lowWhisker, q1, median, q3, highWhisker]`, with R-7 quartiles and whiskers at the
 * most extreme OBSERVED values within 1.5×IQR of the quartiles; everything beyond is an outlier.
 */
export function boxplot(values: number[]): { box: [number, number, number, number, number] | null; outliers: number[] } {
  if (values.length === 0) return { box: null, outliers: [] };
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantileR7(sorted, 0.25);
  const median = quantileR7(sorted, 0.5);
  const q3 = quantileR7(sorted, 0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr;
  const highFence = q3 + 1.5 * iqr;
  const inside = sorted.filter((v) => v >= lowFence && v <= highFence);
  const outliers = sorted.filter((v) => v < lowFence || v > highFence);
  return { box: [inside[0], q1, median, q3, inside[inside.length - 1]], outliers };
}

/**
 * The smallest number of the form 1, 2 or 5 × 10ⁿ (integer n) that is at least x, for x > 0.
 * Infinity when none is representable.
 */
export function niceCeil(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return Infinity;
  const n = Math.floor(Math.log10(x));
  for (const e of [n - 1, n, n + 1]) {
    for (const m of [1, 2, 5]) {
      const c = m * 10 ** e;
      if (c >= x && Number.isFinite(c)) return c;
    }
  }
  return Infinity;
}

/**
 * A finite, nondegenerate range around a constant value v: `[v − pad, v + pad]` with
 * `pad = max(|v|/2, 1)`, each end clamped to ±MAX_VALUE. `pad` exceeds the rounding step at any
 * magnitude, so at least one end always differs from v.
 */
export function constantRange(v: number): [number, number] {
  const pad = Math.max(Math.abs(v) / 2, 1);
  const lo = Math.max(v - pad, -Number.MAX_VALUE);
  const hi = Math.min(v + pad, Number.MAX_VALUE);
  return [lo, hi];
}
