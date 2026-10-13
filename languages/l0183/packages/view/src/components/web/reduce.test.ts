// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { reduce } from "./reduce";

const data = { title: "T", interaction: { type: "concept-web", cells: { n1: {}, n2: { value: "a" } } } };

describe("reduce", () => {
  test("folds a placement into interaction.cells, not onto the top level", () => {
    const next = reduce(data, { type: "response", args: { cells: { n1: { value: "b" } } } });
    expect(next.interaction.cells).toEqual({ n1: { value: "b" }, n2: { value: "a" } });
    expect(next).not.toHaveProperty("cells");
  });
  test("a cleared placement empties the cell", () => {
    const next = reduce(data, { type: "response", args: { cells: { n2: { value: null } } } });
    expect(next.interaction.cells.n2).toEqual({});
  });
  test("leaves every other action to the shared View", () => {
    expect(reduce(data, { type: "update", args: { theme: "dark" } })).toBeUndefined();
    expect(reduce(data, { type: "compiled", args: {} })).toBeUndefined();
  });
});
