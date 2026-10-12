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
    expect(rules([...stack, ...fan({})])).toEqual(["crosses-node", "crosses-node"]);
    expect(rules([...stack, ...fan({ fromSide: "right", toSide: "left" })])).toEqual([]);
  });

  it("ignores a line into a node inside a section", () => {
    expect(rules([{ type: "section", name: "S", x: 0, y: 0, nodes: [sticky("a", 0, 0)] }, sticky("b", 600, 0), { type: "connector", from: "b", to: "a" }])).toEqual([]);
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

  it("flags a missing side, naming the one that faces the waypoint (109)", () => {
    const f = lintPage([...ab, { type: "connector", from: "a", to: "b", waypoints: [{ x: null, y: 400 }] }], estimate);
    expect(f.map((x) => x.message)).toEqual([
      "a → b: give from-side with waypoints; the first waypoint [120 400] is below it, so from-side BOTTOM.",
      "a → b: give to-side with waypoints; the last waypoint [120 400] is below it, so to-side BOTTOM.",
    ]);
  });

  it("flags a side that does not face its waypoint", () => {
    expect(rules([...ab, { type: "connector", from: "a", to: "b", fromSide: "bottom", toSide: "left", waypoints: [{ x: null, y: 400 }] }])).toEqual(["side-mismatch"]);
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
