// SPDX-License-Identifier: MIT
// The plugin's placement rules, pinned: if one of these changes, the preview and the board the
// plugin draws stop agreeing.
import { describe, expect, it } from "vitest";
import { darken, resolveColor } from "./figjam";
import { autoSides, autoSidesCurved, keyMap, layoutPage, legs, resolveEnds, route } from "./layout";
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
      { x: 300, y: 0, w: 176, h: 176 },
      { x: 0, y: 0, w: 120, h: 176 },
      { x: 0, y: -40, w: 40, h: 40 },
    ]);
  });

  it("sizes text to its longest line", () => {
    const [p] = layoutPage([{ type: "text", text: "ab\nabcd", fontSize: 10 }], m).nodes;
    expect(p.box.w).toBeCloseTo(estimate("abcd", 10));
    expect(p.box.h).toBeCloseTo(2 * 10 * 1.21);
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

  it("bends once between diagonal boxes, leaving vertically and arriving from the side", () => {
    // Measured in FigJam: "Elbowed" above-right of "Curved" leaves its bottom, enters Curved's right.
    const elbowed = { x: 1400, y: 400, w: 240, h: 240 };
    const curved = { x: 1000, y: 800, w: 240, h: 240 };
    expect(autoSides(elbowed, curved)).toEqual(["bottom", "right"]);
    expect(route({}, elbowed, curved).points).toEqual([
      { x: 1520, y: 640 },
      { x: 1520, y: 920 },
      { x: 1240, y: 920 },
    ]);
  });

  it("connects across when the boxes share rows, and up or down when they share columns", () => {
    expect(autoSides(A, { x: 300, y: 60, w: 100, h: 100 })).toEqual(["right", "left"]);
    expect(autoSides(A, { x: 40, y: 300, w: 100, h: 100 })).toEqual(["bottom", "top"]);
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

  it("defaults a curve to AUTO, which leaves diagonal boxes along the dominant axis", () => {
    const at = (x: number, y: number) => ({ x, y, w: 240, h: 240 });
    const o = at(0, 0);
    // Measured: b's offset from a → [a's side, b's side].
    const cases: [number, number, string, string][] = [
      [500, 0, "right", "left"],
      [500, 150, "right", "left"],
      [500, 400, "right", "top"],
      [150, 500, "bottom", "top"],
      [-400, 400, "bottom", "right"],
      [400, -400, "top", "left"],
      [-500, 100, "left", "right"],
    ];
    for (const [dx, dy, s0, s1] of cases) expect(autoSidesCurved(o, at(dx, dy)), `(${dx},${dy})`).toEqual([s0, s1]);
    const r = route({ lineType: "curved" }, o, at(500, 400));
    expect(r.points).toEqual([{ x: 240, y: 120 }, { x: 620, y: 400 }]);
    expect(route({ lineType: "curved", fromSide: "center" }, o, at(500, 400)).points).toEqual(r.points);
  });

  it("curves with controls along the sides it leaves and enters", () => {
    const r = route({ lineType: "curved", fromSide: "bottom", toSide: "top" }, A, C);
    expect(r.controls![0].x).toBe(50);
    expect(r.controls![0].y).toBeGreaterThan(100);
    expect(r.controls![1].y).toBeLessThan(300);
  });
});

describe("waypoints", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 400, y: 0, w: 100, h: 100 };
  const c = { from: "a", to: "b", label: "via", toCap: "triangle-filled", fromSide: "bottom", waypoints: [{ x: 50, y: 300 }, { x: 450, y: 300 }] };

  it("draw one leg per pair of stops, meeting at each point", () => {
    const rs = legs({ ...c, lineType: "straight" }, a, b);
    expect(rs.map((r) => [r.points[0], r.points[r.points.length - 1]])).toEqual([
      [{ x: 50, y: 100 }, { x: 50, y: 300 }],
      [{ x: 50, y: 300 }, { x: 450, y: 300 }],
      [{ x: 450, y: 300 }, { x: 450, y: 100 }],
    ]);
  });

  it("cap the outer ends only, and label the middle leg", () => {
    const rs = legs(c, a, b);
    expect(rs.map((r) => [r.connector.fromCap, r.connector.toCap])).toEqual([
      [undefined, "none"],
      ["none", "none"],
      ["none", "triangle-filled"],
    ]);
    expect(rs.map((r) => r.connector.label)).toEqual([undefined, "via", undefined]);
  });

  it("keep from-side on the first leg; an elbowed leg into a point ends on it", () => {
    const [first, , last] = legs(c, a, b);
    expect(first.points[0]).toEqual({ x: 50, y: 100 });
    expect(first.points[first.points.length - 1]).toEqual({ x: 50, y: 300 });
    expect(last.points[last.points.length - 1].y).toBe(100);
  });

  it("aim a curve at a point as FigJam does (the measured grid)", () => {
    // A 240 sticky centred on the origin; the point is offset from its right edge's centre line.
    const node = { x: -120, y: -120, w: 240, h: 240 };
    const at = (dx: number, dy: number) => ({ x: 120 + dx, y: dy, w: 0, h: 0 });
    const axis = (d: { x: number; y: number }) => (Math.abs(d.x) > Math.abs(d.y) ? "H" : "V");
    const offs: [number, number][] = [[300, 150], [150, 300], [300, -150]];
    // node → point: the curve arrives along the side's axis.
    for (const [side, want] of [["bottom", "VVV"], ["right", "HHH"], ["top", "VVV"]] as const) {
      const got = offs.map(([dx, dy]) => axis(route({ lineType: "curved", fromSide: side, toSide: "center" }, node, at(dx, dy)).endDir)).join("");
      expect(got, `node→point ${side}`).toBe(want);
    }
    // point → node: it leaves along the side's axis, or sideways when the point is beside it.
    for (const [side, want] of [["bottom", "HHV"], ["right", "HVH"], ["top", "VVH"]] as const) {
      const got = offs.map(([dx, dy]) => axis(route({ lineType: "curved", fromSide: "center", toSide: side }, at(dx, dy), node).startDir)).join("");
      expect(got, `point→node ${side}`).toBe(want);
    }
  });

  it("face a curve's AUTO node end towards a point either way round (measured)", () => {
    const node = { x: -120, y: -120, w: 240, h: 240 };
    const pt = (dx: number, dy: number) => ({ x: dx, y: dy, w: 0, h: 0 });
    const side = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }) =>
      p.y === b.y ? "top" : p.y === b.y + b.h ? "bottom" : p.x === b.x ? "left" : "right";
    const cases: [number, number, string][] = [[500, 60, "right"], [500, 400, "right"], [100, 500, "bottom"], [-450, 300, "left"], [300, -500, "top"]];
    for (const [dx, dy, want] of cases) {
      const out = route({ lineType: "curved" }, node, pt(dx, dy));
      const back = route({ lineType: "curved" }, pt(dx, dy), node);
      expect([side(out.points[0], node), side(back.points[1], node)], `(${dx},${dy})`).toEqual([want, want]);
    }
  });

  it("route a connector without waypoints as one leg", () => {
    expect(legs({ from: "a", to: "b" }, a, b)).toEqual([route({ from: "a", to: "b" }, a, b)]);
  });

  it("reach the bounds of the page", () => {
    const { bounds } = layoutPage(
      [{ type: "sticky", id: "a" }, { type: "sticky", id: "b", x: 400 }, { type: "connector", from: "a", to: "b", waypoints: [{ x: 0, y: 900 }] }],
      m,
    );
    expect(bounds.y + bounds.h).toBe(900);
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
