// SPDX-License-Identifier: MIT
// The plugin's placement rules, pinned: if one of these changes, the preview and the board the
// plugin draws stop agreeing.
import { describe, expect, it } from "vitest";
import { darken, resolveColor } from "./figjam";
import { keyMap, layoutPage, resolveEnds, route } from "./layout";
import { shapeGeometry } from "./shapes";
import { estimate, fit, wrap } from "./text";

const m = estimate;

describe("nodes", () => {
  it("sit at x/y at FigJam's default sizes", () => {
    const { nodes } = layoutPage(
      [
        { type: "sticky", x: 10, y: 20 },
        { type: "shape", shapeType: "DIAMOND", x: 300 },
        { type: "shape", shapeType: "SQUARE", width: 120 },
        { type: "stamp", stamp: "like", y: -40 },
      ],
      m,
    );
    expect(nodes.map((p) => p.box)).toEqual([
      { x: 10, y: 20, w: 240, h: 240 },
      { x: 300, y: 0, w: 200, h: 200 },
      { x: 0, y: 0, w: 120, h: 200 },
      { x: 0, y: -40, w: 40, h: 40 },
    ]);
  });

  it("sizes text to its longest line", () => {
    const [p] = layoutPage([{ type: "text", text: "ab\nabcd", fontSize: 10 }], m).nodes;
    expect(p.box.w).toBeCloseTo(estimate("abcd", 10));
    expect(p.box.h).toBeCloseTo(2 * 10 * 1.3);
  });
});

describe("sections", () => {
  it("fit their children plus 24px, centring them, as renderNodeTree does", () => {
    const [s] = layoutPage(
      [
        {
          type: "section",
          x: 1000,
          y: 500,
          nodes: [
            { type: "sticky", x: 40, y: 80 },
            { type: "sticky", x: 320, y: 80 },
          ],
        },
      ],
      m,
    ).nodes;
    expect(s.box).toEqual({ x: 1000, y: 500, w: 520 + 48, h: 240 + 48 });
    expect(s.children!.map((c) => [c.box.x, c.box.y])).toEqual([
      [1024, 524],
      [1304, 524],
    ]);
  });

  it("centre their children in an explicit size", () => {
    const [s] = layoutPage([{ type: "section", x: 0, y: 0, width: 400, height: 400, nodes: [{ type: "stamp", stamp: "like", x: 999, y: 999 }] }], m).nodes;
    expect(s.children![0].box).toMatchObject({ x: 180, y: 180 });
  });

  it("register their children's keys, then their own name", () => {
    const { nodes } = layoutPage([{ type: "section", name: "S", nodes: [{ type: "sticky", id: "in" }] }], m);
    expect([...keyMap(nodes).keys()]).toEqual(["in", "S"]);
  });
});

describe("connector ends", () => {
  const { nodes } = layoutPage(
    [
      { type: "sticky", id: "a", text: "A" },
      { type: "sticky", text: "B", x: 300 },
      { type: "sticky", text: "B", x: 600 },
      { type: "stamp", stamp: "like", x: 900 },
    ],
    m,
  );
  const keys = keyMap(nodes);

  it("key by id, then text, then a stamp's reaction; the first registration wins", () => {
    expect([...keys.keys()]).toEqual(["a", "B", "like"]);
    expect(keys.get("B")!.x).toBe(300);
  });

  it("expand lists and * the way resolveEndpoints does", () => {
    expect(resolveEnds(["a", "B", "missing"], "x", keys)).toHaveLength(2);
    expect(resolveEnds("*", "a", keys).map((b) => b.x)).toEqual([300, 900]);
    expect(resolveEnds("*", "*", keys)).toHaveLength(3);
  });

  it("draw one connector per pair and skip a node joined to itself", () => {
    const page = [...nodes.map((p) => p.node), { type: "connector", from: "a", to: "*" }, { type: "connector", from: "a", to: "a" }];
    expect(layoutPage(page, m).routes).toHaveLength(2);
  });
});

describe("routing", () => {
  const A = { x: 0, y: 0, w: 100, h: 100 };
  const B = { x: 300, y: 0, w: 100, h: 100 };
  const C = { x: 300, y: 300, w: 100, h: 100 };

  it("elbows by default, between the facing sides", () => {
    const r = route({}, A, B);
    expect(r.lineType).toBe("elbowed");
    expect(r.points).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 },
    ]);
  });

  it("turns a corner between offset boxes, leaving and arriving square", () => {
    const r = route({ fromSide: "right", toSide: "top" }, A, C);
    expect(r.points).toEqual([
      { x: 100, y: 50 },
      { x: 350, y: 50 },
      { x: 350, y: 300 },
    ]);
    expect(r.endDir).toEqual({ x: 0, y: 1 });
  });

  it("goes centre to centre when straight, clipped at each edge", () => {
    const r = route({ lineType: "straight" }, A, B);
    expect(r.points).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 },
    ]);
  });

  it("treats AUTO on a straight connector as CENTER", () => {
    expect(route({ lineType: "straight", fromSide: "auto", toSide: "auto" }, A, C).points[0]).toEqual({ x: 100, y: 100 });
  });

  it("curves with controls along the sides it leaves and enters", () => {
    const r = route({ lineType: "curved", fromSide: "bottom", toSide: "top" }, A, C);
    expect(r.controls![0].x).toBe(50);
    expect(r.controls![0].y).toBeGreaterThan(100);
    expect(r.controls![1].y).toBeLessThan(300);
  });
});

describe("colours, shapes and text", () => {
  it("resolve colours as the plugin does", () => {
    expect(resolveColor("red")).toBe("#ef4444");
    expect(resolveColor("#abc")).toBe("#abc");
    expect(resolveColor("chartreuse")).toBe("#808080");
    expect(darken("#ffffff")).toBe("#a6a6a6");
  });

  it("give every FigJam shape kind its own outline", () => {
    const kinds = ["SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON", "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE"];
    const seen = new Set<string>();
    for (const k of kinds) {
      const g = shapeGeometry(k, 200, 120);
      const sig = g.d + (g.details ?? "");
      expect(seen.has(sig), `${k} draws the same as another kind`).toBe(false);
      seen.add(sig);
      expect(g.text.w).toBeGreaterThan(0);
      expect(g.text.x + g.text.w).toBeLessThanOrEqual(200);
    }
  });

  it("wrap at the box width and shrink a sticky's text to fit", () => {
    expect(wrap("one two three", estimate("one two", 10), 10, m)).toEqual(["one two", "three"]);
    const long = "word ".repeat(80).trim();
    const f = fit(long, { w: 192, h: 192 }, 24, 1.25, { shrink: true, minSize: 10, measure: m });
    expect(f.fontSize).toBeLessThan(24);
    expect(f.lines.length * f.fontSize * 1.25).toBeLessThanOrEqual(192 + f.fontSize * 1.25);
  });
});
