// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { assignRings, capacity, chordRadius, SINGLE_RING } from "./rings";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i + 1}`);
const spokes = (n: number) => ids(n).map((id) => ({ from: "hub", to: id }));
const HUB_HD = 92;
const HD = 70;
const GAP = 16;

describe("rings", () => {
  test(`up to ${SINGLE_RING} nodes: one ring in author order, the first at the top`, () => {
    const plan = assignRings("hub", ids(SINGLE_RING), spokes(SINGLE_RING), HUB_HD, HD, GAP);
    expect(plan.counts).toEqual([SINGLE_RING]);
    expect(plan.slots[0].angle).toBeCloseTo(-Math.PI / 2);
    const angles = plan.slots.map((s) => s.angle);
    expect([...angles].sort((a, b) => a - b)).toEqual(angles);
  });

  test("past that: hub neighbours first, unreachable nodes last", () => {
    // n1..n10 hang off the hub, n11..n20 off n1, and n21, n22 are linked to nothing.
    const edges = [
      ...ids(10).map((id) => ({ from: "hub", to: id })),
      ...ids(20).slice(10).map((id) => ({ from: "n1", to: id })),
    ];
    const plan = assignRings("hub", ids(22), edges, HUB_HD, HD, GAP);
    const ring = Object.fromEntries(plan.slots.map((s) => [s.id, s.ring]));
    const last = Math.max(...Object.values(ring));
    const near = Math.max(...ids(10).map((id) => ring[id]));
    const far = Math.min(...ids(20).slice(10).map((id) => ring[id]));
    expect(ring.n1).toBe(1);
    expect(near).toBeLessThanOrEqual(far);
    expect(ring.n21).toBe(last);
    expect(ring.n22).toBe(last);
  });

  test("ring 1 holds every hub neighbour, so no spoke crosses a ring", () => {
    const plan = assignRings("hub", ids(40), spokes(40), HUB_HD, HD, GAP);
    expect(plan.counts).toEqual([40]);
    expect(plan.radii[0]).toBeGreaterThanOrEqual(chordRadius(40, HD, GAP));
  });

  test("past ring 1: capacities hold, radii clear the ring inside, and no ring is wasted", () => {
    for (const n of [13, 20, 40, 100]) {
      // One hub neighbour, then a tree: most nodes are past ring 1.
      const edges = ids(n).map((id, i) => ({ from: i === 0 ? "hub" : `n${Math.ceil(i / 2)}`, to: id }));
      const plan = assignRings("hub", ids(n), edges, HUB_HD, HD, GAP);
      plan.counts.forEach((c, i) => {
        if (i > 0) {
          expect(c).toBeLessThanOrEqual(capacity(plan.radii[i - 1] + 2 * HD + GAP, HD, GAP));
          expect(plan.radii[i] - plan.radii[i - 1]).toBeGreaterThanOrEqual(2 * HD + GAP);
        }
        expect(plan.radii[i]).toBeGreaterThanOrEqual(chordRadius(c, HD, GAP) - 1e-9);
      });
      // Every ring but the last is full.
      plan.counts.slice(1, -1).forEach((c, j) => {
        const i = j + 1;
        expect(c).toBe(capacity(plan.radii[i - 1] + 2 * HD + GAP, HD, GAP));
      });
    }
  });

  test("a 20-node chain wraps across at most 3 rings and keeps its links adjacent", () => {
    const chain = ids(20).map((id, i) => ({ from: i === 0 ? "hub" : `n${i}`, to: id }));
    const plan = assignRings("hub", ids(20), chain, HUB_HD, HD, GAP);
    expect(plan.counts.length).toBeLessThanOrEqual(3);
    // Along one ring, consecutive links of the chain sit in neighbouring slots.
    const byId = Object.fromEntries(plan.slots.map((s) => [s.id, s]));
    for (const ring of [1, 2]) {
      const members = plan.slots.filter((s) => s.ring === ring);
      const pitch = (2 * Math.PI) / members.length;
      for (const { from, to } of chain) {
        const a = byId[from];
        const b = byId[to];
        if (!a || !b || a.ring !== ring || b.ring !== ring) continue;
        const d = Math.abs(a.angle - b.angle) % (2 * Math.PI);
        expect(Math.min(d, 2 * Math.PI - d)).toBeCloseTo(pitch, 5);
      }
    }
  });

  test("is deterministic", () => {
    const edges = ids(40).map((id, i) => ({ from: i % 3 ? `n${(i * 7) % 40 || 1}` : "hub", to: id }));
    const a = assignRings("hub", ids(40), edges, HUB_HD, HD, GAP);
    const b = assignRings("hub", ids(40), edges, HUB_HD, HD, GAP);
    expect(a).toEqual(b);
  });
});
