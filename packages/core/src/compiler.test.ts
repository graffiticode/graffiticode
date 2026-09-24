// SPDX-License-Identifier: MIT
/** What a program compiles to. Assert on compiled output, never on source shape. */
import { describe, expect, test } from "vitest";
import { compile } from "./harness.js";

const CELL = `concept-web [
  hub text "The Cell" {}
  nodes [
    node id "r" text "Receptor" assess [expected] {}
    node text "Nucleus" {}
    node text "Mitochondria" assess [expected] {}
    node text "Ribosome" assess [expected points 2] {}
    node text "Golgi" assess [distractor] {}
  ] tray-align left {}
  edges [
    edge from "hub" to "r" {}
    edge from "hub" to "Mitochondria" {}
    edge from "hub" to "n4" {}
    edge from "r" to "Nucleus" style "dashed-arrow" label "signals" assess [expected] {}
    edge label "inhibits" assess [distractor points -1] {}
  ] {}
] title "Cell signaling" instructions "Drag each term." theme DARK {}..`;

const SMALL = `concept-web [ hub text "A" {} nodes [ node text "B" {} ] {} ] {}..`;

describe("the program", () => {
  test("is the compiled model itself, with no wrapper", async () => {
    const out = await compile(SMALL);
    expect(Object.keys(out)).toEqual(["interaction", "validation"]);
    expect(out.interaction.type).toBe("concept-web");
  });

  test("carries its settings from the settings record", async () => {
    const out = await compile(CELL);
    expect(out.title).toBe("Cell signaling");
    expect(out.instructions).toBe("Drag each term.");
    expect(out.theme).toBe("dark");
  });

  test("accepts the settings as a record literal too", async () => {
    const out = await compile(
      `concept-web [ hub text "A" {} nodes [ node text "B" {} ] {} ] {title: "T"}..`,
    );
    expect(out.title).toBe("T");
  });

  test("instant-feedback compiles to `feedback`, never to cqt's `instantFeedback`", async () => {
    const on = await compile(`concept-web [ hub text "A" {} nodes [ node text "B" {} ] {} ] instant-feedback true {}..`);
    expect(on.feedback).toBe("instant");
    expect(on).not.toHaveProperty("instantFeedback");
    const off = await compile(`concept-web [ hub text "A" {} nodes [ node text "B" {} ] {} ] instant-feedback false {}..`);
    expect(off.feedback).toBe("check");
  });

  test("omits settings it was not given", async () => {
    const out = await compile(SMALL);
    expect(out).not.toHaveProperty("title");
    expect(out).not.toHaveProperty("theme");
    expect(out, "no word means feedback waits for a check").not.toHaveProperty("feedback");
  });
});

describe("nodes", () => {
  test("keep the author's ids and number the rest by position among the drawn nodes", async () => {
    const out = await compile(CELL);
    expect(out.interaction.hub).toEqual({ id: "hub", text: "The Cell" });
    expect(out.interaction.nodes.map((n: any) => n.id)).toEqual(["r", "n2", "n3", "n4"]);
  });

  test("with assess [expected] are blanks: their text is hidden, and they get a cell each", async () => {
    const out = await compile(CELL);
    expect(out.interaction.nodes[0]).toEqual({ id: "r", blank: true });
    expect(out.interaction.nodes[2]).toEqual({ id: "n3", blank: true });
    expect(Object.keys(out.interaction.cells)).toEqual(["r", "n3", "n4", "e4"]);
  });

  test("carry their style words", async () => {
    const out = await compile(
      `concept-web [ hub text "A" color "blue" size "large" {} nodes [ node text "B" shape "pill" {} ] {} ] {}..`,
    );
    expect(out.interaction.hub).toEqual({ id: "hub", text: "A", color: "blue", size: "large" });
    expect(out.interaction.nodes[0]).toEqual({ id: "n1", text: "B", shape: "pill" });
  });

  test("accept a number as text", async () => {
    const out = await compile(`concept-web [ hub text 12 {} nodes [ node text 3 {} node text 4 {} ] {} ] {}..`);
    expect(out.interaction.hub.text).toBe("12");
  });

  test("the hub can be a blank", async () => {
    const out = await compile(
      `concept-web [ hub text "Photosynthesis" assess [expected] {} nodes [ node text "Light" {} ] {} ] {}..`,
    );
    expect(out.interaction.hub).toEqual({ id: "hub", blank: true });
    expect(out.validation.cells.hub.assess.expected).toBe("Photosynthesis");
  });
});

describe("edges", () => {
  test("default to a spoke from the hub to every node", async () => {
    const out = await compile(`concept-web [ hub text "A" {} nodes [ node text "B" {} node text "C" {} ] {} ] {}..`);
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
    expect(out.interaction.edges[1].to).toBe("n3");
  });

  test("with assess [expected] are blanks whose label is hidden", async () => {
    const out = await compile(CELL);
    expect(JSON.stringify(out.interaction.edges)).not.toContain("signals");
    expect(out.validation.cells.e4.assess).toEqual({ expected: "signals", points: 1 });
  });

  test("refer to the hub by its id or its text", async () => {
    const out = await compile(
      `concept-web [ hub text "A" {} nodes [ node text "B" {} node text "C" {} ] {}
         edges [ edge from "A" to "B" label "has" {} edge from "hub" to "C" {} ] {} ] {}..`,
    );
    expect(out.interaction.edges.map((e: any) => e.from)).toEqual(["hub", "hub"]);
    expect(out.interaction.edges[0].label).toBe("has");
  });

  test("an empty edge list draws no lines", async () => {
    const out = await compile(`concept-web [ hub text "A" {} nodes [ node text "B" {} ] {} edges [] {} ] {}..`);
    expect(out.interaction.edges).toEqual([]);
  });
});

describe("distractors", () => {
  test("are not drawn and cannot be joined", async () => {
    const out = await compile(CELL);
    expect(out.interaction.nodes.map((n: any) => n.id)).not.toContain("n5");
    expect(JSON.stringify(out.interaction.nodes)).not.toContain("Golgi");
    expect(out.interaction.edges).toHaveLength(4);
  });
});

describe("trays", () => {
  test("are the answers plus the distractors, in authored order, aligned by tray-align", async () => {
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
    const out = await compile(SMALL);
    expect(out.interaction.trays).toEqual({});
  });

  test("hold a repeated answer once per blank", async () => {
    const out = await compile(
      `concept-web [ hub text "Mammals" {} nodes [ node text "whale" assess [expected] {} node text "whale" assess [expected] {} ] {} ] {}..`,
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
      tray: "nodes",
    });
  });

  test("totals the points", async () => {
    const out = await compile(CELL);
    expect(out.validation.points).toBe(5);
  });

  test("records what each distractor costs, per tray", async () => {
    const out = await compile(CELL);
    expect(out.validation.distractors).toEqual({ nodes: { Golgi: 0 }, edges: { inhibits: -1 } });
    expect(out.validation.cells.e4.tray).toBe("edges");
  });

  test("has no distractors entry when there are none", async () => {
    const out = await compile(
      `concept-web [ hub text "A" {} nodes [ node text "B" assess [expected] {} ] {} ] {}..`,
    );
    expect(out.validation).not.toHaveProperty("distractors");
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
      `concept-web [ hub text "Water" {} nodes [ node id "a" text "ice" assess [expected] {} node id "b" text "steam" assess [expected] {} ] {}
         edges [ edge from "hub" to "a" label "freezes into" {} edge from "hub" to "b" label "boils into" {} ] {} ] {}..`,
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
