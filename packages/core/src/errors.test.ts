// SPDX-License-Identifier: MIT
/**
 * Error messages are a product surface: the generator reads them and tries again, so each must
 * name the fix. These assert on the wording, not merely that compilation failed.
 */
import { describe, expect, test } from "vitest";
import { errorOf } from "./harness.js";

const web = (inside: string, after = "{}") => `concept-web [ ${inside} ] ${after}..`;
const HUB = `hub [text "A"]`;
const NODES = `nodes [[text "B"]] {}`;

describe("misplaced words say where they belong", () => {
  test("a setting written inside the brackets", async () => {
    expect(await errorOf(web(`title "T" ${HUB} ${NODES}`))).toBe(
      'concept-web: `title` is not an attribute of concept-web. It takes: hub, nodes, edges. `title` is a setting and goes after the `]` of concept-web, e.g. concept-web [ … ] title "…" {}.',
    );
  });

  test("a setting after the wrong bracket", async () => {
    expect(await errorOf(web(`${HUB} ${NODES}`, `tray "left" {}`))).toContain(
      "`tray` goes after the `]` of nodes",
    );
    expect(await errorOf(web(`${HUB} nodes [[text "B"]] title "T" {}`))).toContain(
      "`title` goes after the `]` of concept-web",
    );
  });

  test("an assess word on the node itself", async () => {
    expect(await errorOf(web(`${HUB} nodes [[text "B" expected "x"]] {}`))).toBe(
      "node 1: `expected` is not an attribute of node. It takes: id, text, shape, color, size, assess. `expected` belongs inside `assess`.",
    );
  });

  test("an edge word on a node", async () => {
    expect(await errorOf(web(`${HUB} nodes [[text "B" label "x"]] {}`))).toContain(
      "`label` belongs inside `edge`",
    );
  });

  test("an attribute in a settings record", async () => {
    expect(await errorOf(web(`${HUB} ${NODES}`, `{text: "x"}`))).toContain(
      "`text` is an attribute and belongs inside the brackets of `hub` or `node`",
    );
  });
});

describe("values", () => {
  test("a closed set names its members", async () => {
    expect(await errorOf(web(`${HUB} nodes [[text "B" shape "hex"]] {}`))).toBe(
      'shape: "hex" is not one of "rounded", "rect", "pill", "circle".',
    );
  });

  test("a quoted theme is told to drop the quotes", async () => {
    expect(await errorOf(web(`${HUB} ${NODES}`, `theme "dark" {}`))).toBe(
      'theme: expected the tag DARK or LIGHT, got "dark". Write it bare, without quotes: theme DARK.',
    );
  });

  test("points must be above zero", async () => {
    expect(await errorOf(web(`${HUB} nodes [[assess [expected "x" points 0]]] {}`))).toBe(
      "node 1: assess `points` must be above 0, got 0.",
    );
  });

  test("distractors must be strings", async () => {
    expect(await errorOf(web(`${HUB} nodes [[assess [expected "x"]]] distractors [1 {}] {}`))).toContain(
      'distractors: entry 2 is a record; every entry must be a string in "quotes"',
    );
  });
});

describe("structure", () => {
  test("a web needs a hub", async () => {
    expect(await errorOf(web(NODES))).toContain("concept-web: needs a `hub`");
  });

  test("a web needs nodes", async () => {
    expect(await errorOf(web(HUB))).toContain("concept-web: needs `nodes`");
  });

  test("a node needs text or assess", async () => {
    expect(await errorOf(web(`${HUB} nodes [[color "red"]] {}`))).toContain(
      "node 1: needs `text`, or `assess` to make it a blank",
    );
  });

  test("a blank may not carry its own text", async () => {
    expect(await errorOf(web(`${HUB} nodes [[text "B" assess [expected "B"]]] {}`))).toContain(
      "node 1: has both `text` and `assess`. A blank shows nothing until the learner fills it",
    );
  });

  test("assess needs expected", async () => {
    expect(await errorOf(web(`${HUB} nodes [[assess [points 2]]] {}`))).toContain(
      "node 1: assess needs `expected`",
    );
  });

  test("an edge reference that names nothing lists the nodes", async () => {
    expect(await errorOf(web(`${HUB} ${NODES} edges [[from "A" to "C"]] {}`))).toBe(
      'edge 1: `to "C"` names no node. Refer to a node by its id or its exact text. The nodes are: hub ("A"), n1 ("B").',
    );
  });

  test("an edge reference that names two nodes asks for an id", async () => {
    expect(
      await errorOf(web(`${HUB} nodes [[text "B"] [text "B"]] {} edges [[from "A" to "B"]] {}`)),
    ).toContain('`to "B"` matches 2 nodes with that text. Give the one you mean an `id`');
  });

  test("an edge needs both ends", async () => {
    expect(await errorOf(web(`${HUB} ${NODES} edges [[from "A"]] {}`))).toContain(
      "edge 1: needs both `from` and `to`",
    );
  });

  test("a blank edge may not carry its own label", async () => {
    expect(
      await errorOf(web(`${HUB} ${NODES} edges [[from "A" to "B" label "x" assess [expected "x"]]] {}`)),
    ).toContain("edge 1: has both `label` and `assess`");
  });

  test("ids are unique, and hub is taken", async () => {
    expect(await errorOf(web(`${HUB} nodes [[id "x" text "B"] [id "x" text "C"]] {}`))).toBe(
      'nodes: two nodes have the id "x". Every id must be different.',
    );
    expect(await errorOf(web(`${HUB} nodes [[id "hub" text "B"]] {}`))).toContain(
      'the id "hub" is taken by the hub',
    );
  });

  test("a distractor that is also an answer", async () => {
    expect(
      await errorOf(web(`${HUB} nodes [[assess [expected "x"]]] distractors ["x"] {}`)),
    ).toContain('nodes: distractor "x" is also a correct answer');
  });

  test("distractors without blanks", async () => {
    expect(await errorOf(web(`${HUB} nodes [[text "B"]] distractors ["x"] {}`))).toContain(
      "nodes: has `distractors` but no blanks",
    );
  });

  test("an attribute given twice", async () => {
    expect(await errorOf(web(`${HUB} nodes [[text "B" text "C"]] {}`))).toBe(
      "node 1: `text` is given twice. Each attribute may appear once.",
    );
  });

  test("a node written without brackets", async () => {
    expect(await errorOf(web(`${HUB} nodes [text "B"] {}`))).toContain(
      "node 1: expected an attribute list in [brackets]",
    );
  });

  test("a program that is not a concept web", async () => {
    expect(await errorOf(`42..`)).toContain("A program is one concept web");
  });
});
