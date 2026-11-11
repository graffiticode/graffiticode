// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { candidateKey, edgeCandidates, estimate, LABEL, reserve } from "./metrics";

describe("label room", () => {
  test("a blank reserves for every tray item and its placeholder", () => {
    const c = edgeCandidates({ blank: true }, ["signals", "inhibits"]);
    expect(c.map((x) => x.text)).toEqual([null, "signals", "inhibits"]);
    expect(edgeCandidates({ label: "has" }, ["x"])).toEqual([{ kind: "label", text: "has" }]);
    expect(edgeCandidates({}, ["x"])).toEqual([]);
  });

  test("width and height are reserved separately, from different candidates", () => {
    const wide = { kind: "blank" as const, text: "wide" };
    const tall = { kind: "blank" as const, text: "tall" };
    const measured = { [candidateKey(wide)]: { w: 170, h: 20 }, [candidateKey(tall)]: { w: 60, h: 70 } };
    expect(reserve([wide, tall], measured)).toEqual({ w: 170, h: 70 });
  });

  test("the estimate stays inside the label's limits, however long the text", () => {
    const s = estimate({ kind: "label", text: "x".repeat(2000) });
    expect(s.w).toBeLessThanOrEqual(LABEL.maxW);
    expect(s.h).toBeLessThanOrEqual(LABEL.maxH);
    expect(estimate({ kind: "blank", text: null }).w).toBe(LABEL.blankMinW);
    expect(estimate({ kind: "label", text: "https://example.com/a.png" }).w).toBe(LABEL.imgW + 2 * (LABEL.padX + LABEL.border));
  });
});
