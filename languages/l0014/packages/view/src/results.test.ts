// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { summarize } from "./results";

describe("summarize", () => {
  test("a matching translation passes and a mismatch fails", () => {
    const s = summarize([
      { score: 1, source: "1+2", actual: "1 + 2", expected: "1 + 2" },
      { score: -1, source: "1+2", actual: "1 + 2", expected: "wrong" },
    ]);
    expect(s.cases.map((c) => c.status)).toEqual(["pass", "fail"]);
    expect([s.pass, s.fail, s.captured]).toEqual([1, 1, 0]);
  });

  // The compiler scores these -1, but an empty expectation asserts nothing — it records what
  // the rule set does today. Reporting them as failures would paint a whole capture corpus red.
  test("an empty expectation is captured, not failed", () => {
    const s = summarize([{ score: -1, source: "x+y", actual: "x + y", expected: "" }]);
    expect(s.cases[0].status).toBe("captured");
    expect(s.fail).toBe(0);
  });

  test("an empty expectation with an empty translation is captured, not passed", () => {
    const s = summarize([{ score: 1, source: "\\bad", actual: "", expected: "" }]);
    expect(s.cases[0].status).toBe("captured");
    expect(s.pass).toBe(0);
  });

  test("order is preserved and malformed entries are skipped", () => {
    const s = summarize([
      null,
      { score: 1, source: "b", actual: "b", expected: "b" },
      "junk",
      { score: -1, source: "a", actual: "a", expected: "z" },
    ]);
    expect(s.cases.map((c) => c.source)).toEqual(["b", "a"]);
  });

  test("a missing corpus is an empty summary", () => {
    expect(summarize(undefined)).toEqual({ cases: [], pass: 0, fail: 0, captured: 0 });
  });
});
