// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { exitPoint, layout, segment, SPACE } from "./layout";

const ring = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i + 1}` }));
const overlap = (a: any, b: any) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

describe("layout", () => {
  test("puts the hub in the centre and the first node at the top", () => {
    const [hub, first] = layout({ id: "hub" }, ring(4));
    expect([hub.x, hub.y]).toEqual([SPACE / 2, SPACE / 2]);
    expect(first.x).toBe(SPACE / 2);
    expect(first.y).toBeLessThan(hub.y);
  });

  test("keeps every node inside the square", () => {
    for (const n of [1, 3, 6, 12]) {
      for (const b of layout({ id: "hub", size: "large" }, ring(n))) {
        expect(b.x - b.w / 2).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w / 2).toBeLessThanOrEqual(SPACE);
        expect(b.y - b.h / 2).toBeGreaterThanOrEqual(0);
        expect(b.y + b.h / 2).toBeLessThanOrEqual(SPACE);
      }
    }
  });

  test("no two nodes overlap, even crowded", () => {
    for (const n of [2, 5, 8, 12]) {
      const boxes = layout({ id: "hub" }, ring(n));
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          expect(overlap(boxes[i], boxes[j]), `${n} nodes: ${i} and ${j}`).toBe(false);
    }
  });

  test("a circle is as tall as it is wide", () => {
    const [hub] = layout({ id: "hub", shape: "circle" }, ring(3));
    expect(hub.h).toBe(hub.w);
  });
});

describe("edges", () => {
  const box = { id: "a", x: 500, y: 500, w: 200, h: 100, shape: "rect" };
  test("leave a rectangle on its edge", () => {
    expect(exitPoint(box, 1000, 500)).toEqual({ x: 600, y: 500 });
    expect(exitPoint(box, 500, 0)).toEqual({ x: 500, y: 450 });
  });
  test("leave a circle on its circumference", () => {
    const c = { ...box, shape: "circle", h: 200 };
    const p = exitPoint(c, 800, 800);
    expect(Math.hypot(p.x - 500, p.y - 500)).toBeCloseTo(100);
  });
  test("put a label between the visible ends, not the centres", () => {
    const small = { id: "s", x: 100, y: 500, w: 40, h: 40, shape: "rect" };
    const s = segment(small, box);
    expect(s.mx).toBeCloseTo((s.x1 + s.x2) / 2);
    expect(s.mx).not.toBeCloseTo((small.x + box.x) / 2);
  });
});
