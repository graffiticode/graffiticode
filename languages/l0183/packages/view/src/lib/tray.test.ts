// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { available, shuffle } from "./tray";

const items = ["Receptor", "Mitochondria", "Ribosome", "Golgi", "Lysosome"].map((text, i) => ({
  id: `c${i + 1}`,
  text,
}));

describe("shuffle", () => {
  test("is stable for the same tray", () => {
    expect(shuffle(items)).toEqual(shuffle(items));
  });
  test("keeps every item", () => {
    expect(shuffle(items).map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
  });
  test("does not hand back the authored order, which puts the answers first", () => {
    expect(shuffle(items).map((i) => i.id)).not.toEqual(items.map((i) => i.id));
  });
});

describe("available", () => {
  test("removes what is placed", () => {
    expect(available(items, ["Golgi", undefined]).map((i) => i.text)).not.toContain("Golgi");
  });
  test("counts a repeated answer as a multiset", () => {
    const whales = [
      { id: "c1", text: "whale" },
      { id: "c2", text: "whale" },
    ];
    expect(available(whales, ["whale"])).toEqual([{ id: "c2", text: "whale" }]);
    expect(available(whales, ["whale", "whale"])).toEqual([]);
  });
});
