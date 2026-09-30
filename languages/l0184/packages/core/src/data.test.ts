// SPDX-License-Identifier: MIT
// The normalizer takes the shapes an upstream language will one day hand over through
// `data use …`. Composition is not enabled yet; these pin the contract so enabling it is not a
// redesign. `use` itself is never called here — it fetches a schema over HTTP.
import { describe, expect, it } from "vitest";
import { fromIndexed, normalizeRows } from "./data.js";

describe("normalizeRows", () => {
  it("takes list rows with columns", () => {
    expect(normalizeRows([["a", 1], ["b", 2]], ["k", "v"], "t")).toEqual({ columns: ["k", "v"], rows: [["a", 1], ["b", 2]] });
  });

  it("takes record rows, inferring columns in first-seen order", () => {
    expect(normalizeRows([{ k: "a", v: 1 }, { v: 2, k: "b" }], undefined, "t")).toEqual({
      columns: ["k", "v"],
      rows: [["a", 1], ["b", 2]],
    });
  });

  it("orders record rows by the given columns", () => {
    expect(normalizeRows([{ k: "a", v: 1 }], ["v", "k"], "t").rows).toEqual([[1, "a"]]);
  });

  it("takes {rows, columns}", () => {
    expect(normalizeRows({ columns: ["v"], rows: [[1], [2]] }, undefined, "t")).toEqual({ columns: ["v"], rows: [[1], [2]] });
  });

  it("takes an integer-keyed record, as L0000's DATA makes from an upstream array", () => {
    expect(normalizeRows({ 1: { v: 2 }, 0: { v: 1 } }, undefined, "t").rows).toEqual([[1], [2]]);
  });

  it("keeps null as a value, and accepts no rows", () => {
    expect(normalizeRows([[null]], ["v"], "t").rows).toEqual([[null]]);
    expect(normalizeRows([], ["v"], "t")).toEqual({ columns: ["v"], rows: [] });
  });

  it("refuses ragged, mixed, nested and unnamed rows", () => {
    expect(() => normalizeRows([["a"], ["b", 2]], ["k", "v"], "t")).toThrow("t: row 1 has 1 value, but there are 2 columns (k, v).");
    expect(() => normalizeRows([["a"], { k: "b" }], ["k"], "t")).toThrow("t: rows must all be lists (in column order) or all be records.");
    expect(() => normalizeRows([[[1]]], ["k"], "t")).toThrow('t row 1, column "k": a value must be a number, a string, true/false or null — got a list or a record.');
    expect(() => normalizeRows([{ k: 1 }, { j: 2 }], undefined, "t")).toThrow('t: row 1 has no "j". Every row needs every column; write null for a missing value.');
    expect(() => normalizeRows([["a"]], ["k", "k"], "t")).toThrow('t: the column "k" is named twice. Column names must differ.');
  });
});

describe("fromIndexed", () => {
  it("orders keys numerically, not as strings", () => {
    const rec = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i), i]));
    expect(fromIndexed(rec, "t")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("refuses gaps and non-integer keys", () => {
    expect(() => fromIndexed({ 0: "a", 2: "b" }, "t")).toThrow("t: rows are numbered 0 to 1 with a gap at 1.");
    expect(() => fromIndexed({ 0: "a", x: "b" }, "t")).toThrow('t: expected a list of rows; got a record with keys "0", "x".');
    expect(() => fromIndexed({ "01": "a" }, "t")).toThrow('t: expected a list of rows; got a record with keys "01".');
  });
});
