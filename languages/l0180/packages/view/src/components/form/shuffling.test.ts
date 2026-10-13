// SPDX-License-Identifier: MIT
/**
 * The shuffle, tested as a function rather than as randomness.
 *
 * `shuffled` takes its RNG, so these assert the two properties that matter — every entry
 * survives exactly once, and an anchored entry ends up last — with a seeded generator instead
 * of hoping. Nothing here needs a DOM, which is the point of keeping the logic out of the
 * component.
 */
import { test, describe, expect } from "vitest";
import { shuffled } from "./shuffling";

/** A deterministic stand-in for Math.random: cycles a fixed sequence in [0, 1). */
const seeded = (seq: number[]) => {
  let i = 0;
  return () => seq[i++ % seq.length];
};

const ids = (list: { id: string }[]) => list.map((o) => o.id);
const options = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(65 + i), text: `opt ${i}` }));

describe("shuffled", () => {
  test("every entry survives, exactly once", () => {
    const out = shuffled(options(5), seeded([0.7, 0.1, 0.9, 0.3]));
    expect(ids(out).sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  test("it actually reorders", () => {
    const out = shuffled(options(5), seeded([0.99, 0.01, 0.99, 0.01]));
    expect(ids(out)).not.toEqual(["A", "B", "C", "D", "E"]);
  });

  test("an anchored entry is last however the rest falls", () => {
    const list = [...options(4), { id: "Z", text: "All of the above", anchored: true }];
    for (const seq of [[0.1], [0.9], [0.5, 0.2, 0.8], [0.99, 0.99, 0.99]]) {
      const out = shuffled(list, seeded(seq));
      expect(ids(out)[4], `seq ${seq.join(",")}`).toBe("Z");
      expect(ids(out).sort()).toEqual(["A", "B", "C", "D", "Z"]);
    }
  });

  test("two anchored entries keep their authored order at the tail", () => {
    const list = [
      ...options(3),
      { id: "Y", text: "None of the above", anchored: true },
      { id: "Z", text: "All of the above", anchored: true },
    ];
    const out = shuffled(list, seeded([0.4, 0.8, 0.2]));
    expect(ids(out).slice(3)).toEqual(["Y", "Z"]);
  });

  test("a list of one, or of none, comes back as it went in", () => {
    expect(ids(shuffled(options(1)))).toEqual(["A"]);
    expect(shuffled([])).toEqual([]);
  });

  test("the input array is not mutated", () => {
    const list = options(4);
    shuffled(list, seeded([0.9, 0.1, 0.5]));
    expect(ids(list)).toEqual(["A", "B", "C", "D"]);
  });
});
