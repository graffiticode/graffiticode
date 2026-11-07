// SPDX-License-Identifier: MIT
/**
 * Merged cells, links, freezing and read-only, at the level of ProseMirror state: the document a
 * model builds, the cells the engine sees, navigation, and which transactions get through. No DOM
 * is needed for any of it, so these run in bare Node.
 */
import { describe, expect, test } from "vitest";
import { EditorState, AllSelection, TextSelection } from "prosemirror-state";
import { TableMap } from "prosemirror-tables";

import {
  schema,
  makeEditorState,
  getCells,
  cellRectAt,
  findNextDataCell,
  getCellNodeByName,
  getAdjacentCellNodeByName,
  makeProtectedCellsPlugin,
  buildCellPlugin,
  stickyStyle,
  isWebAddress,
} from "./TableEditor";
import { spansOf, gridExtent } from "../../sheet/index.js";

const stateOf = (interaction: any, plugins: any[] = []) =>
  EditorState.fromJSON({ schema, plugins }, makeEditorState({ type: "table", ...interaction }));

/** The data cells' names in document order, as the rows hold them. */
const rowNames = (state: any) => {
  const out: string[][] = [];
  state.doc.firstChild.forEach((row: any) => {
    const names: string[] = [];
    row.forEach((cell: any) => names.push(cell.attrs.name));
    out.push(names);
  });
  return out;
};

/** Put the caret in the named cell. */
const at = (state: any, name: string) => {
  const { pos } = getCellNodeByName({ state, name });
  return state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1))));
};

const nameAtSelection = (state: any) => cellRectAt(state) && state.doc.nodeAt(
  cellRectAt(state).table.pos + 1 + cellRectAt(state).offset).attrs.name;

const step = (state: any, dir: number) => {
  const pos = findNextDataCell(state, dir);
  return state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos))));
};

const title = {
  cells: {
    A1: { text: "Title", colspan: 6 },
    A2: { text: "h1" }, B2: { text: "h2" }, F2: { text: "h6" },
  },
};

describe("spans in the model", () => {
  test("covered addresses are every position but the anchor", () => {
    const { anchors, covered } = spansOf({ A1: { colspan: 3, rowspan: 2 } });
    expect(anchors.A1).toEqual({ c1: 1, r1: 1, c2: 3, r2: 2 });
    expect([...covered.keys()].sort()).toEqual(["A2", "B1", "B2", "C1", "C2"]);
  });

  test("the grid reaches the far corner of a merge", () => {
    expect(gridExtent({ A1: { colspan: 6 } })).toEqual({ x: 6, y: 1 });
    expect(gridExtent({ B2: { rowspan: 4 } })).toEqual({ x: 2, y: 5 });
  });
});

describe("the document a merge builds", () => {
  test("the anchor carries the spans and covered cells have no node", () => {
    const state = stateOf(title);
    const { pos, node } = getCellNodeByName({ state, name: "A1" });
    expect(pos).toBeGreaterThan(0);
    expect(node.attrs.colspan).toBe(6);
    expect(rowNames(state)[1]).toEqual(["_1", "A1"]);
    expect(rowNames(state)[2]).toEqual(["_2", "A2", "B2", "C2", "D2", "E2", "F2"]);
    // A well-formed table: no position is unfilled or doubly filled.
    expect(TableMap.get(state.doc.firstChild).problems).toBeNull();
  });

  test("a rowspan builds the same way", () => {
    const state = stateOf({ cells: { A1: { text: "x", rowspan: 3 }, B3: { text: "y" } } });
    expect(getCellNodeByName({ state, name: "A1" }).node.attrs.rowspan).toBe(3);
    expect(rowNames(state).slice(1)).toEqual([["_1", "A1", "B1"], ["_2", "B2"], ["_3", "B3"]]);
    expect(TableMap.get(state.doc.firstChild).problems).toBeNull();
  });

  test("column widths are carried per spanned column", () => {
    const state = stateOf({
      cells: { A1: { text: "T", colspan: 3 }, A2: { text: "a" } },
      columns: { A: { width: 100 }, C: { width: 50 } },
    });
    expect(getCellNodeByName({ state, name: "A1" }).node.attrs.colwidth).toEqual([100, 0, 50]);
  });

  test("getCells reads row and column from the table map, not by counting nodes", () => {
    const state = stateOf({ cells: { A1: { text: "T", colspan: 2 }, C1: { text: "c" } } });
    const c1 = getCells(null, state).find((c: any) => c.name === "C1");
    // The heading column is column 1, so C is column 4 — not 3, which counting nodes would give.
    expect([c1.row, c1.col]).toEqual([2, 4]);
    expect(getCells(null, state).some((c: any) => c.name === "B1")).toBe(false);
  });

  test("a covered address resolves to its anchor for navigation (heading clicks rely on it)", () => {
    const state = stateOf(title);
    const anchor = getCellNodeByName({ state, name: "A1" });
    // Clicking heading B resolves B1, which lies under A1:F1.
    const adjacent = getAdjacentCellNodeByName({ state, name: "B0" });
    expect(adjacent.node).toBeTruthy();
    expect(adjacent.pos).toBe(anchor.pos);
  });
});

describe("navigation across merges", () => {
  const merged = { cells: { A1: { text: "a", colspan: 2 }, C1: { text: "c" }, A2: { text: "d" }, B2: { text: "e" }, C2: { text: "f" } } };

  test("Tab and Shift-Tab step over a colspan, once each way", () => {
    let state = at(stateOf(merged), "A1");
    state = step(state, 1);
    expect(nameAtSelection(state)).toBe("C1");
    state = step(state, -1);
    expect(nameAtSelection(state)).toBe("A1");
    // Shift-Tab from the merge goes back past it, wrapping to the last cell — not to itself.
    state = step(state, -1);
    expect(nameAtSelection(state)).toBe("C2");
    state = step(state, 1);
    expect(nameAtSelection(state)).toBe("A1");
  });

  test("a rowspan is visited once, at its top row", () => {
    let state = at(stateOf({ cells: { A1: { text: "a", rowspan: 2 }, B1: { text: "b" }, B2: { text: "c" } } }), "A1");
    const seen = [];
    for (let i = 0; i < 3; i++) {
      seen.push(nameAtSelection(state));
      state = step(state, 1);
    }
    expect(seen).toEqual(["A1", "B1", "B2"]);
    expect(nameAtSelection(state)).toBe("A1");
    state = step(at(state, "B2"), -1);
    expect(nameAtSelection(state)).toBe("B1");
    state = step(state, -1);
    expect(nameAtSelection(state)).toBe("A1");
  });

  test("a merge's rectangle is its full extent", () => {
    const state = at(stateOf(title), "A1");
    expect(cellRectAt(state).rect).toEqual({ left: 1, top: 1, right: 7, bottom: 2 });
  });
});

describe("the engine under a merge", () => {
  const engineOf = (cells: any) => {
    const formState = { data: { interaction: { type: "table", cells } }, apply: () => {} };
    const plugin = buildCellPlugin(formState);
    const state = EditorState.fromJSON({ schema, plugins: [plugin] }, makeEditorState({ type: "table", cells }));
    return { state, value: plugin.getState(state) as any };
  };

  test("a formula reading a covered address reads an empty cell, as without the merge", () => {
    const plain = engineOf({ A2: { text: "5" }, C2: { text: "=A2*B2" } }).value.cells.C2.val;
    const merged = engineOf({ A2: { text: "5", colspan: 2 }, C2: { text: "=A2*B2" } }).value.cells.C2.val;
    expect(merged).toEqual(plain);
    const sum = engineOf({ A1: { text: "x", colspan: 3 }, A2: { text: "=SUM(A1:C1)" } }).value.cells.A2;
    expect(sum.type).not.toBe("error");
  });

  test("covered addresses are blanks in the engine but get no node and no decoration", () => {
    const { state, value } = engineOf({ A2: { text: "5", colspan: 2, rowspan: 2 }, C2: { text: "=B3" } });
    expect(value.cells.B2).toMatchObject({ text: "", covered: true });
    expect(value.cells.B3).toMatchObject({ text: "", covered: true });
    // Every decoration sits on a real node; a logical blank would have none to sit on.
    const decorations = value.decorations.find();
    const names = decorations.map((d: any) => state.doc.nodeAt(d.from)?.attrs?.name).filter(Boolean);
    expect(names).not.toContain("B2");
    expect(names).not.toContain("B3");
  });
});

describe("links", () => {
  test("only http(s) addresses count", () => {
    expect(isWebAddress("https://t.me/stroyka_chat")).toBe(true);
    expect(isWebAddress("javascript:alert(1)")).toBe(false);
    expect(isWebAddress("https://a b")).toBe(false);
  });

  test("a link cell is protected, shows its address when it has no label, and the engine keeps it text", () => {
    const cells = {
      E3: { link: "https://example.com/page/2" },
      E4: { text: "chat", link: "https://t.me/x" },
    };
    const formState = { data: { interaction: { type: "table", cells } }, apply: () => {} };
    const plugin: any = buildCellPlugin(formState);
    const state = EditorState.fromJSON({ schema, plugins: [plugin] }, makeEditorState({ type: "table", cells }));
    const e3 = getCellNodeByName({ state, name: "E3" }).node;
    expect(e3.attrs.link).toBe("https://example.com/page/2");
    expect(e3.attrs.protected).toBe(true);
    expect(e3.textContent).toBe("https://example.com/page/2");
    // The model to the engine: the link arrives, and a URL ending in digits is not read as a date.
    const seen = getCells(null, state).find((c: any) => c.name === "E3");
    expect(seen.link).toBe("https://example.com/page/2");
    expect(plugin.getState(state).cells.E3.type).toBe("text");
    // The label is wrapped in an anchor.
    const anchors = plugin.getState(state).decorations.find()
      .filter((d: any) => d.type?.attrs?.nodeName === "a");
    expect(anchors.map((d: any) => d.type.attrs.href).sort())
      .toEqual(["https://example.com/page/2", "https://t.me/x"]);
  });

  test("a link that is not http(s) never reaches the node", () => {
    const state = stateOf({ cells: { A1: { text: "x", link: "javascript:alert(1)" } } });
    expect(getCellNodeByName({ state, name: "A1" }).node.attrs.link).toBeNull();
  });
});

describe("wrap", () => {
  test("inherits row, then column, then cell", () => {
    const state = stateOf({
      cells: { A1: { text: "a" }, B1: { text: "b", wrap: true }, A2: { text: "c" } },
      columns: { A: { wrap: false }, B: { wrap: false } },
    });
    expect(getCellNodeByName({ state, name: "A1" }).node.attrs.wrap).toBe(false);
    expect(getCellNodeByName({ state, name: "B1" }).node.attrs.wrap).toBe(true);
  });
});

describe("freezing", () => {
  test("frozen rows and columns stick, with headings, and nothing else does", () => {
    expect(stickyStyle({ left: 1, top: 1, right: 2, bottom: 2 }, 2, 0)).toContain("top: var(--gc-top-1");
    expect(stickyStyle({ left: 0, top: 0, right: 1, bottom: 1 }, 2, 0)).toContain("top: var(--gc-top-0");
    expect(stickyStyle({ left: 1, top: 3, right: 2, bottom: 4 }, 2, 0)).toBe("");
    const corner = stickyStyle({ left: 1, top: 1, right: 2, bottom: 2 }, 1, 1);
    expect(corner).toContain("left: var(--gc-left-1");
    expect(corner).toContain("z-index: 4");
    // A merge inside the frozen rows (A1:F1 under freeze-rows 2) is frozen whole.
    expect(stickyStyle({ left: 1, top: 1, right: 7, bottom: 2 }, 2, 0)).toContain("top:");
    expect(stickyStyle({ left: 1, top: 1, right: 2, bottom: 2 }, 0, 0)).toBe("");
  });
});

describe("a protected sheet", () => {
  const sheet = { cells: { A1: { text: "a" }, B1: { text: "b" }, A2: { text: "=A1" } } };
  const guarded = (cells: any = sheet.cells) =>
    EditorState.fromJSON({ schema, plugins: [makeProtectedCellsPlugin(null)] },
      makeEditorState({ type: "table", cells, sheetProtected: true }));

  test("protects every cell", () => {
    const state = guarded();
    for (const name of ["A1", "B1", "A2"]) {
      expect(getCellNodeByName({ state, name }).node.attrs.protected).toBe(true);
    }
  });

  test("a cell's own protected false still opens it", () => {
    const state = guarded({ A1: { text: "a" }, B1: { text: "", protected: false } });
    expect(getCellNodeByName({ state, name: "B1" }).node.attrs.protected).toBe(false);
    const inB1 = at(state, "B1");
    expect(inB1.apply(inB1.tr.insertText("x")).doc.eq(inB1.doc)).toBe(false);
  });

  test("Select All, then typing, changes nothing", () => {
    let state = guarded();
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    expect(state.apply(state.tr.insertText("x")).doc.eq(state.doc)).toBe(true);
  });

  test("Select All, then Delete, changes nothing", () => {
    let state = guarded();
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    expect(state.apply(state.tr.deleteSelection()).doc.eq(state.doc)).toBe(true);
  });

  test("a paste over the whole document, or into one cell, changes nothing", () => {
    let state = guarded();
    const slice = state.doc.slice(0, state.doc.content.size);
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    expect(state.apply(state.tr.replaceSelection(slice)).doc.eq(state.doc)).toBe(true);
    const inCell = at(guarded(), "B1");
    expect(inCell.apply(inCell.tr.insertText("pasted")).doc.eq(inCell.doc)).toBe(true);
  });

  test("the grid's own writes still land, so formulas display their values", () => {
    const state = at(guarded(), "A2");
    const { pos, node } = getCellNodeByName({ state, name: "A2" });
    const tr = state.tr.replaceWith(pos + 1, pos + node.nodeSize - 1,
      schema.node("paragraph", null, schema.text("a"))).setMeta("systemFormatting", true);
    expect(state.apply(tr).doc.eq(state.doc)).toBe(false);
  });
});

describe("protected cells", () => {
  test("Select All, then typing, cannot replace a protected cell", () => {
    let state = stateOf({ cells: { A1: { text: "keep", protected: true }, B1: { text: "b" } } },
      [makeProtectedCellsPlugin(null)]);
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
    expect(state.apply(state.tr.insertText("x")).doc.eq(state.doc)).toBe(true);
  });

  test("an unprotected neighbour still takes edits", () => {
    const state = at(stateOf({ cells: { A1: { text: "keep", protected: true }, B1: { text: "b" } } },
      [makeProtectedCellsPlugin(null)]), "B1");
    expect(state.apply(state.tr.insertText("x")).doc.eq(state.doc)).toBe(false);
  });
});
