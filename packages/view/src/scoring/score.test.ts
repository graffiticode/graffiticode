// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { getCellsValidation, scoreCells, scoreResponse, totalScore } from "./index";

// Three spokes: n1 and n2 are interchangeable (pool p1), n3 stands alone, e1 is a label.
const validation = {
  points: 5,
  cells: {
    n1: { assess: { expected: "Mitochondria", points: 1 }, pool: "p1" },
    n2: { assess: { expected: "Ribosome", points: 1 }, pool: "p1" },
    n3: { assess: { expected: "Glucose", points: 2 }, pool: "p2" },
    e1: { assess: { expected: "makes", points: 1 }, pool: "p3" },
  },
};
const v = (value: string | null) => ({ value });

describe("scoreResponse", () => {
  test("every blank right scores in full", () => {
    const cells = { n1: v("Mitochondria"), n2: v("Ribosome"), n3: v("Glucose"), e1: v("makes") };
    expect(totalScore(cells, validation as any)).toBe(5);
  });

  test("a pool accepts its answers in either order", () => {
    const cells = { n1: v("Ribosome"), n2: v("Mitochondria") };
    const s = scoreResponse(cells, validation as any);
    expect(s.n1).toEqual({ points: 1, isValid: true });
    expect(s.n2).toEqual({ points: 1, isValid: true });
  });

  test("an answer never scores outside its pool", () => {
    const cells = { n1: v("Glucose"), n3: v("Mitochondria") };
    const s = scoreResponse(cells, validation as any);
    expect(s.n1.isValid).toBe(false);
    expect(s.n3.isValid).toBe(false);
  });

  test("the same answer twice scores once", () => {
    const cells = { n1: v("Ribosome"), n2: v("Ribosome") };
    expect(totalScore(cells, validation as any)).toBe(1);
  });

  test("a blank holding its own answer keeps it against a pool-mate", () => {
    // n2 is right in place; n1 duplicates it. n2 must score, not n1.
    const s = scoreResponse({ n1: v("Ribosome"), n2: v("Ribosome") }, validation as any);
    expect(s.n2.isValid).toBe(true);
    expect(s.n1.isValid).toBe(false);
  });

  test("empty and cleared blanks score nothing", () => {
    const s = scoreResponse({ n1: v(null), n2: {} as any }, validation as any);
    expect(s.n1).toEqual({ points: 0, isValid: false });
    expect(s.n2).toEqual({ points: 0, isValid: false });
    expect(s.n3).toEqual({ points: 0, isValid: false });
  });

  test("whitespace is not a wrong answer", () => {
    expect(scoreResponse({ n3: v("  Glucose ") }, validation as any).n3.isValid).toBe(true);
  });
});

describe("the learnosity-cqt contract", () => {
  test("scoreCells returns the cells with a score each, summing to the total", () => {
    const cells = { n1: v("Ribosome"), n2: v("Mitochondria"), n3: v("Water"), e1: v("makes") };
    const scored = scoreCells({ cells, validation });
    expect(scored.n1).toEqual({ value: "Ribosome", score: { points: 1, isValid: true } });
    const sum = Object.values(scored).reduce((n: number, c: any) => n + c.score.points, 0);
    expect(sum).toBe(3);
  });

  test("getCellsValidation exposes assess.expected per cell, which cqt's labels read", () => {
    expect(getCellsValidation({ validation }).n3.assess.expected).toBe("Glucose");
  });
});

describe("distractor penalties", () => {
  const withCosts = {
    points: 3,
    cells: {
      n1: { assess: { expected: "Mitochondria", points: 1 }, pool: "p1", tray: "nodes" },
      n2: { assess: { expected: "Ribosome", points: 2 }, pool: "p2", tray: "nodes" },
      e1: { assess: { expected: "makes", points: 1 }, pool: "p3", tray: "edges" },
    },
    distractors: { nodes: { Chlorophyll: -1, Golgi: 0 }, edges: { eats: -2 } },
  };

  test("a blank holding a distractor from its tray scores the distractor's points", () => {
    const s = scoreResponse({ n1: v(" Chlorophyll "), n2: v("Golgi") }, withCosts as any);
    expect(s.n1).toEqual({ points: -1, isValid: false });
    expect(s.n2).toEqual({ points: 0, isValid: false });
  });

  test("another tray's distractor costs nothing", () => {
    expect(scoreResponse({ e1: v("Chlorophyll") }, withCosts as any).e1).toEqual({
      points: 0,
      isValid: false,
    });
  });

  test("penalties offset right answers, and the total never goes below 0", () => {
    expect(totalScore({ n1: v("Mitochondria"), n2: v("Chlorophyll") }, withCosts as any)).toBe(0);
    expect(totalScore({ n2: v("Ribosome"), n1: v("Chlorophyll") }, withCosts as any)).toBe(1);
    expect(totalScore({ n1: v("Chlorophyll"), e1: v("eats") }, withCosts as any)).toBe(0);
  });
});
