// SPDX-License-Identifier: MIT
// The corpus gate's rules, each pinned by a program the corpus actually produced.
import { describe, expect, it } from "vitest";
import { lintPage } from "./lint";
import { estimate } from "./text";

const sticky = (id: string, x: number, y: number) => ({ type: "sticky", id, text: id, x, y });
const shape = (id: string, x: number, y: number, w = 200, h = 100) => ({ type: "shape", shapeType: "SQUARE", id, text: id, x, y, width: w, height: h });
const rules = (nodes: any[]) => lintPage(nodes, estimate).map((f) => f.rule);

describe("crossing nodes", () => {
  it("flags a line through the node between two in a row (122)", () => {
    const f = lintPage([shape("api", 0, 0), shape("db", 300, 0), shape("queue", 600, 0), { type: "connector", from: "api", to: "queue" }], estimate);
    expect(f).toHaveLength(1);
    expect(f[0].message).toBe("api → queue runs through db, which it does not join. Move the nodes so the path is clear, set the sides facing each other, or route around with waypoints.");
  });

  it("flags a fan-in from a stack left to AUTO, and passes it with the sides facing (87)", () => {
    const stack = [sticky("in1", 0, 0), sticky("in2", 0, 300), sticky("in3", 0, 600), shape("process", 400, 240, 200, 180)];
    const fan = (sides: object) => ["in1", "in2", "in3"].map((s) => ({ type: "connector", from: s, to: "process", ...sides }));
    expect(rules([...stack, ...fan({})])).toEqual(["crosses-node", "jog", "crosses-node"]);
    // With the sides facing, only the middle line's step is left (the box is not on its centre line).
    expect(rules([...stack, ...fan({ fromSide: "right", toSide: "left" })])).toEqual(["jog"]);
  });

  it("ignores a line into a node inside a section", () => {
    // The section pads its sticky 24px in, so b sits level with it at y 24.
    expect(rules([{ type: "section", name: "S", x: 0, y: 0, nodes: [sticky("a", 0, 0)] }, sticky("b", 600, 24), { type: "connector", from: "b", to: "a" }])).toEqual([]);
  });
});

describe("jogs", () => {
  it("flags a box above a fitted section, left edges aligned instead of centres (130)", () => {
    const nodes = [shape("review", 0, -220), { type: "section", name: "Done", x: 0, y: 0, nodes: [sticky("s1", 0, 0), sticky("s2", 0, 280)] }, { type: "connector", from: "review", to: "Done" }];
    expect(lintPage(nodes, estimate).map((f) => f.message)).toEqual([
      "review → Done: the line steps 44px sideways because the centres are not in line (x 100 and 144). Line up their centres: centre = x + width / 2.",
    ]);
    nodes[0] = shape("review", 44, -220);
    expect(rules(nodes)).toEqual([]);
  });

  it("flags the middle of a fan-in off its target's centre line, and leaves diagonal lines alone (87)", () => {
    const stack = [sticky("in1", 0, 0), sticky("in2", 0, 300), sticky("in3", 0, 600)];
    const fan = (y: number) => [...stack, shape("process", 400, y, 200, 180), ...["in1", "in2", "in3"].map((s) => ({ type: "connector", from: s, to: "process", fromSide: "right", toSide: "left" }))];
    expect(lintPage(fan(240), estimate).map((f) => f.connector)).toEqual(["in2 → process"]);
    expect(rules(fan(330))).toEqual([]);
  });

  it("leaves straight and curved lines alone", () => {
    expect(rules([sticky("a", 0, 0), sticky("b", 30, 400), { type: "connector", from: "a", to: "b", lineType: "straight" }])).toEqual([]);
  });
});

describe("waypoints", () => {
  const ab = [sticky("a", 0, 0), sticky("b", 300, 0)];

  it("passes a route with sides facing its waypoints (110)", () => {
    const nodes = [sticky("start", 0, 0), sticky("blocked", 300, 0), sticky("end", 600, 0), { type: "connector", from: "start", to: "end", fromSide: "top", toSide: "top", waypoints: [{ x: null, y: -100 }] }];
    expect(rules(nodes)).toEqual([]);
  });

  it("flags a waypoint inside a node (125)", () => {
    const nodes = [sticky("start", 0, 0), sticky("finish", 600, 480), { type: "connector", from: "start", to: "finish", fromSide: "bottom", toSide: "left", waypoints: [{ x: null, y: 600 }, { x: 720, y: null }] }];
    expect(rules(nodes)).toContain("waypoint-inside-node");
  });

  it("flags a line that doubles back at a waypoint (109, left to AUTO)", () => {
    const f = lintPage([...ab, { type: "connector", from: "a", to: "b", waypoints: [{ x: null, y: 400 }] }], estimate);
    // Back up the way it came — and on up through "a" itself, to reach b's left side.
    expect(f.map((x) => x.rule)).toEqual(["doubles-back", "enters-from-inside"]);
    expect(f[0].message).toBe(
      "a → b: the line doubles back on itself at waypoint [120 400]. Set the end's side so the last run enters it without retracing the route (e.g. to-side BOTTOM for a line that comes in from below).",
    );
    expect(rules([...ab, { type: "connector", from: "a", to: "b", fromSide: "bottom", toSide: "bottom", waypoints: [{ x: null, y: 400 }] }])).toEqual([]);
  });

  it("passes a side the line climbs past and turns into (108)", () => {
    const steps = [0, 300, 600, 900].map((y, i) => shape(`step${i + 1}`, 0, y));
    const loop = { type: "connector", from: "step4", to: "step1", fromSide: "right", toSide: "right", waypoints: [{ x: 400, y: null }] };
    expect(rules([...steps, loop])).toEqual([]);
  });

  it("flags a line that reaches its end's side from inside the node", () => {
    expect(rules([...ab, { type: "connector", from: "a", to: "b", fromSide: "bottom", toSide: "top", waypoints: [{ x: null, y: 400 }, { x: 420, y: 400 }] }])).toContain("enters-from-inside");
  });

  it("flags a waypoint level with a node but off its centre (107), and the corner it did not need", () => {
    const nodes = [shape("build", 0, 0), shape("test", 400, 300), { type: "connector", from: "test", to: "build", fromSide: "left", toSide: "left", waypoints: [{ x: -100, y: 330 }, { x: -100, y: 50 }] }];
    expect(lintPage(nodes, estimate).map((f) => f.message)).toEqual([
      "test → build: the first waypoint [-100 330] is level with the node but not its centre (y 350), so the line jogs into it.",
      "test → build: the last waypoint [-100 50] is where the line turns into the node anyway; leave it out.",
    ]);
  });

  it("flags a waypoint where the line turns into the node anyway (109, 127)", () => {
    const nodes = [...ab, { type: "connector", from: "a", to: "b", fromSide: "bottom", toSide: "bottom", waypoints: [{ x: null, y: 400 }, { x: 420, y: 400 }] }];
    expect(lintPage(nodes, estimate).map((f) => f.message)).toEqual(["a → b: the last waypoint [420 400] is where the line turns into the node anyway; leave it out."]);
    expect(rules([...ab, { type: "connector", from: "a", to: "b", fromSide: "bottom", toSide: "bottom", waypoints: [{ x: null, y: 400 }] }])).toEqual([]);
  });

  it("leaves straight lines' sides alone", () => {
    expect(rules([...ab, { type: "connector", from: "a", to: "b", lineType: "straight", waypoints: [{ x: 250, y: -100 }] }])).toEqual([]);
  });
});
