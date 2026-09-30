// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { boxplot, constantRange, edgeLabels, histogram, niceCeil, quantileR7, sturges } from "./stats.js";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("histogram", () => {
  it("uses Sturges' rule by default", () => {
    expect(sturges(1)).toBe(1);
    expect(sturges(8)).toBe(4);
    expect(sturges(100)).toBe(8);
    expect(histogram(Array.from({ length: 100 }, (_, i) => i)).counts).toHaveLength(8);
  });

  it("bins [lower, upper) and counts the maximum in the last bin", () => {
    const { labels, counts } = histogram([0, 1, 2, 3, 4], 2);
    expect(labels).toEqual(["0–2", "2–4"]);
    expect(counts).toEqual([2, 3]);
  });

  it("counts sum to the number of observations, even at floating-point edges", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i * 0.1);
    for (const k of [1, 3, 7, 10, 33]) expect(sum(histogram(values, k).counts)).toBe(1000);
    const tenths = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
    expect(sum(histogram(tenths, 3).counts)).toBe(7);
  });

  it("puts constant data in one bin labelled with its value", () => {
    expect(histogram([5, 5, 5])).toEqual({ labels: ["5"], counts: [3] });
  });

  it("is empty for no observations", () => {
    expect(histogram([])).toEqual({ labels: [], counts: [] });
  });

  it("labels with enough precision that adjacent edges differ", () => {
    expect(edgeLabels([1, 1.0001, 1.0002])).toEqual(["1", "1.0001", "1.0002"]);
    expect(edgeLabels([0, 33.333333, 66.666667, 100])).toEqual(["0", "33.3", "66.7", "100"]);
    const { labels } = histogram([1, 1.0001, 1.0002, 1.0003], 3);
    expect(new Set(labels).size).toBe(3);
  });
});

describe("quartiles and boxes", () => {
  it("computes R-7 quantiles", () => {
    const s = [1, 2, 3, 4];
    expect(quantileR7(s, 0.25)).toBeCloseTo(1.75);
    expect(quantileR7(s, 0.5)).toBeCloseTo(2.5);
    expect(quantileR7(s, 0.75)).toBeCloseTo(3.25);
    expect(quantileR7([7], 0.5)).toBe(7);
    expect(Number.isNaN(quantileR7([], 0.5))).toBe(true);
  });

  it("puts whiskers at observed values within 1.5 × IQR and separates outliers", () => {
    const { box, outliers } = boxplot([1, 2, 3, 4, 5, 6, 7, 8, 100]);
    expect(box).toEqual([1, 3, 5, 7, 8]);
    expect(outliers).toEqual([100]);
  });

  it("has no box for no observations", () => {
    expect(boxplot([])).toEqual({ box: null, outliers: [] });
  });
});

describe("niceCeil", () => {
  it("is the smallest 1, 2 or 5 × 10^n at least x", () => {
    expect([0.7, 3, 12, 50, 51, 1, 0.012].map(niceCeil)).toEqual([1, 5, 20, 50, 100, 1, 0.02]);
  });
  it("is Infinity when none is representable", () => {
    expect(niceCeil(Number.MAX_VALUE)).toBe(Infinity);
    expect(niceCeil(0)).toBe(Infinity);
  });
});

describe("constantRange", () => {
  for (const v of [7, 0, -3, 1e300, -1e300, Number.MAX_VALUE, -Number.MAX_VALUE, 1e-300]) {
    it(`is finite and nondegenerate around ${v}`, () => {
      const [lo, hi] = constantRange(v);
      expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true);
      expect(lo).toBeLessThan(hi);
      expect(lo).toBeLessThanOrEqual(v);
      expect(hi).toBeGreaterThanOrEqual(v);
    });
  }
});
