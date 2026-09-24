// SPDX-License-Identifier: MIT
/** What a program compiles to. Assert on compiled output, never on source shape. */
import { describe, expect, test } from "vitest";
import { compile } from "./harness.js";

const CELL = `concept-web [
  hub [text "The Cell"]
  nodes [
    [id "r" assess [expected "Receptor"]]
    [text "Nucleus"]
    [assess [expected "Mitochondria"]]
    [assess [expected "Ribosome" points 2]]
  ] distractors ["Golgi"] tray "left" {}
  edges [
    [from "hub" to "r"]
    [from "hub" to "n3"]
    [from "hub" to "n4"]
    [from "r" to "Nucleus" style "dashed-arrow" assess [expected "signals"]]
  ] distractors ["inhibits"] {}
] title "Cell signaling" instructions "Drag each term." theme DARK {}..`;

describe("the program", () => {
  test("is the compiled model itself, with no wrapper", async () => {
    const out = await compile(`concept-web [ hub [text "A"] nodes [[text "B"]] {} ] {}..`);
    expect(Object.keys(out)).toEqual(["interaction", "validation"]);
    expect(out.interaction.type).toBe("concept-web");
  });

  test("carries its settings from the configuration record", async () => {
    const out = await compile(CELL);
    expect(out.title).toBe("Cell signaling");
    expect(out.instructions).toBe("Drag each term.");
    expect(out.theme).toBe("dark");
  });

  test("accepts the settings as a record literal too", async () => {
    const out = await compile(
      `concept-web [ hub [text "A"] nodes [[text "B"]] {} ] {title: "T"}..`,
    );
    expect(out.title).toBe("T");
  });

  test("omits settings it was not given", async () => {
    const out = await compile(`concept-web [ hub [text "A"] nodes [[text "B"]] {} ] {}..`);
    expect(out).not.toHaveProperty("title");
    expect(out).not.toHaveProperty("theme");
  });
});

describe("nodes", () => {
  test("keep the author's ids and number the rest by position", async () => {
    const out = await compile(CELL);
    expect(out.interaction.hub).toEqual({ id: "hub", text: "The Cell" });
    expect(out.interaction.nodes.map((n: any) => n.id)).toEqual(["r", "n2", "n3", "n4"]);
  });

  test("with assess are blanks: no text, and a cell each", async () => {
    const out = await compile(CELL);
    expect(out.interaction.nodes[0]).toEqual({ id: "r", blank: true });
    expect(Object.keys(out.interaction.cells)).toEqual(["r", "n3", "n4", "e4"]);
  });

  test("carry their style words", async () => {
    const out = await compile(
      `concept-web [ hub [text "A" color "blue" size "large"] nodes [[text "B" shape "pill"]] {} ] {}..`,
    );
    expect(out.interaction.hub).toEqual({ id: "hub", text: "A", color: "blue", size: "large" });
    expect(out.interaction.nodes[0]).toEqual({ id: "n1", text: "B", shape: "pill" });
  });

  test("accept a number as text", async () => {
    const out = await compile(`concept-web [ hub [text 12] nodes [[text 3] [text 4]] {} ] {}..`);
    expect(out.interaction.hub.text).toBe("12");
  });

  test("the hub can be a blank", async () => {
    const out = await compile(
      `concept-web [ hub [assess [expected "Photosynthesis"]] nodes [[text "Light"]] {} ] {}..`,
    );
    expect(out.interaction.hub).toEqual({ id: "hub", blank: true });
    expect(out.validation.cells.hub.assess.expected).toBe("Photosynthesis");
  });
});

describe("edges", () => {
  test("default to a spoke from the hub to every node", async () => {
    const out = await compile(`concept-web [ hub [text "A"] nodes [[text "B"] [text "C"]] {} ] {}..`);
    expect(out.interaction.edges).toEqual([
      { id: "e1", from: "hub", to: "n1", style: "solid" },
      { id: "e2", from: "hub", to: "n2", style: "solid" },
    ]);
  });

  test("resolve endpoints by id or by exact text", async () => {
    const out = await compile(CELL);
    expect(out.interaction.edges[3]).toEqual({
      id: "e4",
      from: "r",
      to: "n2",
      style: "dashed-arrow",
      blank: true,
    });
  });

  test("refer to the hub by its id or its text", async () => {
    const out = await compile(
      `concept-web [ hub [text "A"] nodes [[text "B"] [text "C"]] {}
         edges [[from "A" to "B" label "has"] [from "hub" to "C"]] {} ] {}..`,
    );
    expect(out.interaction.edges.map((e: any) => e.from)).toEqual(["hub", "hub"]);
    expect(out.interaction.edges[0].label).toBe("has");
  });

  test("an empty edge list draws no lines", async () => {
    const out = await compile(`concept-web [ hub [text "A"] nodes [[text "B"]] {} edges [] {} ] {}..`);
    expect(out.interaction.edges).toEqual([]);
  });
});

describe("trays", () => {
  test("are the answers plus the distractors, in authored order", async () => {
    const out = await compile(CELL);
    expect(out.interaction.trays.nodes).toEqual({
      items: [
        { id: "c1", text: "Receptor" },
        { id: "c2", text: "Mitochondria" },
        { id: "c3", text: "Ribosome" },
        { id: "c4", text: "Golgi" },
      ],
      align: "left",
    });
    expect(out.interaction.trays.edges).toEqual({
      items: [
        { id: "r1", text: "signals" },
        { id: "r2", text: "inhibits" },
      ],
      align: "bottom",
    });
  });

  test("are absent where there are no blanks", async () => {
    const out = await compile(`concept-web [ hub [text "A"] nodes [[text "B"]] {} ] {}..`);
    expect(out.interaction.trays).toEqual({});
  });

  test("hold a repeated answer once per blank", async () => {
    const out = await compile(
      `concept-web [ hub [text "Mammals"] nodes [[assess [expected "whale"]] [assess [expected "whale"]]] {} ] {}..`,
    );
    expect(out.interaction.trays.nodes.items.map((i: any) => i.text)).toEqual(["whale", "whale"]);
  });
});

describe("the answer key", () => {
  test("lives in validation, never in interaction", async () => {
    const out = await compile(CELL);
    expect(JSON.stringify(out.interaction.nodes)).not.toContain("Receptor");
    expect(JSON.stringify(out.interaction.cells)).not.toContain("Receptor");
    expect(out.validation.cells.r).toEqual({
      assess: { expected: "Receptor", points: 1 },
      pool: "p1",
    });
  });

  test("totals the points", async () => {
    const out = await compile(CELL);
    expect(out.validation.points).toBe(5);
  });

  test("pools blanks whose places in the web cannot be told apart", async () => {
    const out = await compile(CELL);
    const pool = (id: string) => out.validation.cells[id].pool;
    // n3 and n4 are both plain spokes from the hub; r has an extra edge, so it stands alone.
    expect(pool("n3")).toBe(pool("n4"));
    expect(pool("r")).not.toBe(pool("n3"));
    expect(pool("e4")).not.toBe(pool("r"));
  });

  test("does not pool spokes the hub labels differently", async () => {
    const out = await compile(
      `concept-web [ hub [text "Water"] nodes [[id "a" assess [expected "ice"]] [id "b" assess [expected "steam"]]] {}
         edges [[from "hub" to "a" label "freezes into"] [from "hub" to "b" label "boils into"]] {} ] {}..`,
    );
    expect(out.validation.cells.a.pool).not.toBe(out.validation.cells.b.pool);
  });
});

describe("the learner's answers", () => {
  test("ride across a recompile in each blank's cell", async () => {
    const data = { interaction: { cells: { r: { value: "Golgi" }, n3: { value: "Ribosome" } } } };
    const out = await compile(CELL, data);
    expect(out.interaction.cells).toEqual({
      r: { value: "Golgi" },
      n3: { value: "Ribosome" },
      n4: {},
      e4: {},
    });
  });

  // Through api.graffiticode.org, the /form's model is compiled by L0000 first and reaches L0183
  // as that compile's `{data, errors}` response — the bug where every drop snapped back.
  test("ride across a recompile through the platform's {data, errors} envelope, nested or not", async () => {
    const model = { interaction: { cells: { r: { value: "Golgi" } } } };
    const once = await compile(CELL, { data: model, errors: [] });
    expect(once.interaction.cells.r).toEqual({ value: "Golgi" });
    const twice = await compile(CELL, { data: { data: model, errors: [] }, errors: [] });
    expect(twice.interaction.cells.r).toEqual({ value: "Golgi" });
  });

  test("are the only thing taken from data — a stale model cannot shadow a fresh compile", async () => {
    const data = {
      title: "STALE",
      interaction: { type: "concept-web", nodes: [], cells: { gone: { value: "x" } } },
      validation: { points: 99 },
    };
    const out = await compile(CELL, data);
    expect(out.title).toBe("Cell signaling");
    expect(out.interaction.nodes).toHaveLength(4);
    expect(out.interaction.cells).not.toHaveProperty("gone");
    expect(out.validation.points).toBe(5);
  });

  test("a cleared placement is no answer", async () => {
    const out = await compile(CELL, { interaction: { cells: { r: { value: null } } } });
    expect(out.interaction.cells.r).toEqual({});
  });
});
