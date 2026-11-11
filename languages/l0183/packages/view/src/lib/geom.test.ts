// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import {
  advance,
  curveHitsBox,
  enterParam,
  exitParam,
  extremumT,
  pointAt,
  straight,
  subCurve,
  type Box,
  type Quad,
} from "./geom";

const rect: Box = { id: "a", x: 0, y: 0, w: 200, h: 100, shape: "rect" };
const circle: Box = { id: "c", x: 0, y: 0, w: 200, h: 200, shape: "circle" };

describe("quadratic curves", () => {
  const q: Quad = { p0: { x: 0, y: 0 }, c: { x: 100, y: 200 }, p2: { x: 200, y: 0 } };

  test("a sub-curve lies exactly on the curve", () => {
    const s = subCurve(q, 0.2, 0.7);
    for (let i = 0; i <= 10; i++) {
      const p = pointAt(s, i / 10);
      // Its point at u is the full curve's point at 0.2 + 0.5u.
      const r = pointAt(q, 0.2 + 0.5 * (i / 10));
      expect(Math.abs(p.x - r.x)).toBeLessThan(1e-6);
      expect(Math.abs(p.y - r.y)).toBeLessThan(1e-6);
    }
  });

  test("finds the turning point", () => {
    expect(extremumT(q, "y")).toBeCloseTo(0.5);
    expect(extremumT(q, "x")).toBeUndefined();
  });

  test("advance moves by arc length along a straight line", () => {
    const line = straight({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(pointAt(line, advance(line, 0.5, 10)).x).toBeCloseTo(60);
    expect(pointAt(line, advance(line, 0.5, -10)).x).toBeCloseTo(40);
  });
});

describe("leaving and entering outlines", () => {
  test("a line leaves a rectangle on its side", () => {
    const line = straight({ x: 0, y: 0 }, { x: 1000, y: 0 });
    expect(pointAt(line, exitParam(line, rect)).x).toBeCloseTo(100);
    const up = straight({ x: 0, y: 0 }, { x: 0, y: -1000 });
    expect(pointAt(up, exitParam(up, rect)).y).toBeCloseTo(-50);
  });

  test("a curve leaves a rectangle on its outline", () => {
    const q: Quad = { p0: { x: 0, y: 0 }, c: { x: 300, y: 300 }, p2: { x: 600, y: 0 } };
    const p = pointAt(q, exitParam(q, rect));
    const onSide = Math.abs(Math.abs(p.x) - 100) < 1e-6 || Math.abs(Math.abs(p.y) - 50) < 1e-6;
    expect(onSide).toBe(true);
  });

  test("a line leaves a circle on its circumference", () => {
    const line = straight({ x: 0, y: 0 }, { x: 800, y: 800 });
    const p = pointAt(line, exitParam(line, circle));
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(100, 3);
  });

  test("enters the far box on its outline", () => {
    const far: Box = { ...rect, id: "b", x: 1000 };
    const line = straight({ x: 0, y: 0 }, { x: 1000, y: 0 });
    expect(pointAt(line, enterParam(line, far)).x).toBeCloseTo(900);
  });
});

describe("curves against boxes", () => {
  test("a line through a box hits it, and one past it does not", () => {
    const line = straight({ x: -500, y: 0 }, { x: 500, y: 0 });
    expect(curveHitsBox(line, 0, 1, rect, 0)).toBe(true);
    const past = straight({ x: -500, y: 200 }, { x: 500, y: 200 });
    expect(curveHitsBox(past, 0, 1, rect, 0)).toBe(false);
  });

  test("a bend clears a box the straight line hits", () => {
    const bent: Quad = { p0: { x: -500, y: 0 }, c: { x: 0, y: -400 }, p2: { x: 500, y: 0 } };
    expect(curveHitsBox(bent, 0, 1, rect, 0)).toBe(false);
  });
});
