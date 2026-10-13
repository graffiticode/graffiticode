// SPDX-License-Identifier: MIT
/**
 * The reducer is the one piece of the state protocol that is not generic, and it fails quietly
 * when it is wrong: the edit lands somewhere nothing renders, the next compile redraws from
 * source, and the learner's typing disappears with no error anywhere. Hence direct tests.
 */
import { test, expect, describe } from "vitest";
import { reduce } from "./reduce.js";

const update = (args: any) => ({ type: "update", args });

describe("single sheet", () => {
  const data = { interaction: { type: "table", cells: { A1: { text: "old", assess: { points: 2 } } } } };

  test("merges the edit into interaction.cells", () => {
    const next: any = reduce(data, update({ cells: { A1: { text: "new", formattedValue: "new" } } }));
    expect(next.interaction.cells.A1.text).toBe("new");
  });

  test("preserves what the report does not carry — assess rules survive an edit", () => {
    // The Form reports only {text, formattedValue}. Replacing the cell would drop its grading.
    const next: any = reduce(data, update({ cells: { A1: { text: "new" } } }));
    expect(next.interaction.cells.A1.assess).toEqual({ points: 2 });
  });

  test("does not claim actions that are not ours", () => {
    expect(reduce(data, { type: "compiled", args: { title: "x" } })).toBeUndefined();
    expect(reduce(data, update({ nope: 1 }))).toBeUndefined();
  });
});

describe("several sheets", () => {
  const data = {
    interaction: {
      type: "table",
      cells: { A1: { text: "one" } },                       // flat mirror of sheet 1
      sheets: [
        { id: "s1", name: "One", cells: { A1: { text: "one", assess: { points: 2 } } } },
        { id: "s2", name: "Two", cells: { A1: { text: "two", assess: { points: 3 } } } },
      ],
    },
  };

  test("an edit goes to the sheet it came from, and only that one", () => {
    const next: any = reduce(data, update({ sheetId: "s2", cells: { A1: { text: "edited" } } }));
    expect(next.interaction.sheets[1].cells.A1.text).toBe("edited");
    expect(next.interaction.sheets[0].cells.A1.text).toBe("one");
  });

  test("per-cell properties survive on the sheet that was edited", () => {
    const next: any = reduce(data, update({ sheetId: "s2", cells: { A1: { text: "edited" } } }));
    expect(next.interaction.sheets[1].cells.A1.assess).toEqual({ points: 3 });
  });

  test("editing sheet 1 also refreshes the flat mirror", () => {
    const next: any = reduce(data, update({ sheetId: "s1", cells: { A1: { text: "edited" } } }));
    expect(next.interaction.cells.A1.text).toBe("edited");
  });

  test("editing a later sheet leaves the flat mirror alone — it mirrors sheet 1, not the active one", () => {
    const next: any = reduce(data, update({ sheetId: "s2", cells: { A1: { text: "edited" } } }));
    expect(next.interaction.cells.A1.text).toBe("one");
  });

  test("an untagged edit falls back to the flat path rather than guessing a sheet", () => {
    const next: any = reduce(data, update({ cells: { A1: { text: "edited" } } }));
    expect(next.interaction.cells.A1.text).toBe("edited");
    expect(next.interaction.sheets[0].cells.A1.text).toBe("one");
  });
});

describe("responses", () => {
  const response = (cells: any) => ({ type: "response", args: { cells } });

  test("accumulate per key, so a second sheet's answers do not erase the first's", () => {
    // The shared View replaced top-level `cells` wholesale; the Check score reads this map.
    let data: any = { interaction: { type: "table", cells: {} } };
    data = reduce(data, response({ "s1!A1": { text: "4", val: "4" } }));
    data = reduce(data, response({ "s2!B2": { text: "9", val: "9" } }));
    expect(Object.keys(data.cells).sort()).toEqual(["s1!A1", "s2!B2"]);
  });

  test("a later answer to the same cell replaces the earlier one", () => {
    let data: any = { cells: { A1: { text: "3", val: "3" } } };
    data = reduce(data, response({ A1: { text: "4", val: "4" } }));
    expect(data.cells.A1.val).toBe("4");
  });
});
