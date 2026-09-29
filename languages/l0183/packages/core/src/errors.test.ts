// SPDX-License-Identifier: MIT
/**
 * Error messages are a product surface: the generator reads them and tries again, so each must
 * name the fix. These assert on the wording, not merely that compilation failed.
 */
import { describe, expect, test } from "vitest";
import { errorOf } from "./harness.js";

const web = (inside: string, after = "{}") => `concept-web [ ${inside} ] ${after}..`;
const HUB = `hub text "A" {}`;
const NODES = `nodes [ node text "B" {} ] {}`;
const BLANK = `node text "x" assess [expected] {}`;

describe("misplaced words say where they belong", () => {
  test("a setting written inside the brackets", async () => {
    expect(await errorOf(web(`title "T" ${HUB} ${NODES}`))).toContain(
      "`title` is a setting and goes after the `]` of concept-web, e.g. concept-web [ … ] title \"…\" {}.",
    );
  });

  test("a setting in a node's chain", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node text "B" title "T" {} ] {}`))).toBe(
      'node 1: `title` is not part of node. It takes: id, text, shape, color, size, assess. `title` is a setting and goes after the `]` of concept-web, e.g. concept-web [ … ] title "…" {}.',
    );
  });

  test("a setting after the wrong bracket", async () => {
    expect(await errorOf(web(`${HUB} ${NODES}`, `tray-align left {}`))).toContain(
      "`tray-align` is a setting and goes after the `]` of nodes, e.g. nodes [ … ] tray-align left {}.",
    );
    expect(await errorOf(web(`${HUB} nodes [ node text "B" {} ] title "T" {}`))).toContain(
      "`title` is a setting and goes after the `]` of concept-web",
    );
  });

  test("an assess word on the node itself", async () => {
    // `points` is arity 1, so it ends the chain and strands the `{}` — reported where written.
    expect(await errorOf(web(`${HUB} nodes [ node text "B" points 2 {} ] {}`))).toBe(
      "node 1: `points` is not part of node. It takes: id, text, shape, color, size, assess. `points` belongs inside `assess [ … ]`, e.g. assess [expected points 2].",
    );
  });

  test("an edge word on a node", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node text "B" label "x" {} ] {}`))).toContain(
      "`label` belongs in `edge`",
    );
  });

  test("an attribute in a settings record", async () => {
    expect(await errorOf(web(`${HUB} ${NODES}`, `{text: "x"}`))).toContain(
      "`text` belongs in `hub` or `node`",
    );
  });

  test("a node written straight into concept-web", async () => {
    expect(await errorOf(web(`${HUB} node text "B" {}`))).toContain(
      "`node` is a member of `nodes`, e.g. nodes [ node text \"Nucleus\" {} ] {}.",
    );
  });
});

describe("typed members", () => {
  test("a member of the wrong type", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node text "B" {} edge from "A" to "B" {} ] {}`))).toBe(
      'nodes: member 2 is an `edge`, not a `node`. Every member is written node text "Nucleus" {}.',
    );
  });

  test("an untyped member", async () => {
    expect(await errorOf(web(`${HUB} nodes [ text "B" {} ] {}`))).toContain(
      "nodes: member 1 is a `text`, not a `node`",
    );
  });

  test("a node given a list", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node [] ] {}`))).toContain(
      'node: expected a description ending in `{}`, e.g. node text "Nucleus" {}, got a list.',
    );
  });

  test("a chain that does not end in a record", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node text "B" "C" ] {}`))).toContain(
      "text: a chain must end in a record — write `{}` after the last word",
    );
  });
});

describe("values", () => {
  test("a closed set names its members", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node text "B" shape "hex" {} ] {}`))).toBe(
      'shape: "hex" is not one of "rounded", "rect", "pill", "circle".',
    );
  });

  test("instant-feedback takes a bare boolean, and a quoted one is told to drop the quotes", async () => {
    expect(await errorOf(web(`${HUB} ${NODES}`, `instant-feedback "true" {}`))).toBe(
      'instant-feedback: expected true or false, written bare, got "true". Write it without quotes: instant-feedback true.',
    );
    expect(await errorOf(web(`${HUB} ${NODES}`, `instant-feedback 1 {}`))).toBe(
      "instant-feedback: expected true or false, written bare, got 1.",
    );
  });

  test("instant-feedback on a member list is told it belongs to concept-web", async () => {
    expect(await errorOf(web(`${HUB} nodes [ ${BLANK} ] instant-feedback true {}`))).toContain(
      "`instant-feedback` is a setting and goes after the `]` of concept-web, e.g. concept-web [ … ] instant-feedback true {}.",
    );
  });

  test("a quoted tag is told to drop the quotes", async () => {
    expect(await errorOf(web(`${HUB} ${NODES}`, `theme "dark" {}`))).toBe(
      'theme: expected the tag DARK or LIGHT, got "dark". Write it bare, without quotes: theme DARK.',
    );
    expect(await errorOf(web(`${HUB} nodes [ ${BLANK} ] tray-align "left" {}`))).toBe(
      'tray-align: expected the tag right or left or top or bottom, got "left". Write it bare, without quotes: tray-align left.',
    );
  });

  test("points on a blank must be above zero", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node text "x" assess [expected points 0] {} ] {}`))).toBe(
      "node 1: `points` on a blank must be above 0, got 0. A negative `points` belongs on a distractor.",
    );
  });

  test("points on a distractor must be zero or below", async () => {
    expect(
      await errorOf(web(`${HUB} nodes [ ${BLANK} node text "y" assess [distractor points 1] {} ] {}`)),
    ).toBe(
      "node 2: `points` on a distractor must be 0 or below — it is what dropping it on a blank costs. Got 1.",
    );
  });

  test("assess takes a bracket list", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node text "x" assess expected {} ] {}`))).toContain(
      "assess: expected a list in [brackets], e.g. assess [expected]",
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

  test("a node needs text, blank or not", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node color "red" {} ] {}`))).toContain(
      "node 1: needs `text`",
    );
    expect(await errorOf(web(`${HUB} nodes [ node assess [expected] {} ] {}`))).toContain(
      "node 1: needs `text`",
    );
  });

  test("assess needs expected or distractor, not both", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node text "x" assess [points 2] {} ] {}`))).toContain(
      "node 1: assess needs `expected` (a blank, answered by its own text) or `distractor`",
    );
    expect(
      await errorOf(web(`${HUB} nodes [ node text "x" assess [expected distractor] {} ] {}`)),
    ).toContain("node 1: assess has both `expected` and `distractor`");
  });

  test("a distractor takes only its text and assess", async () => {
    expect(
      await errorOf(web(`${HUB} nodes [ ${BLANK} node text "y" color "red" assess [distractor] {} ] {}`)),
    ).toBe(
      "node 2: a distractor sits only in the tray and is not drawn, so it takes just `text` and `assess` — drop `color`.",
    );
  });

  test("the hub cannot be a distractor", async () => {
    expect(await errorOf(web(`hub text "A" assess [distractor] {} ${NODES}`))).toContain(
      "hub: cannot be a distractor",
    );
  });

  test("a web needs a drawn node", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node text "y" assess [distractor] {} ] {}`))).toContain(
      "nodes: needs at least one drawn node",
    );
  });

  test("an edge reference that names nothing lists the nodes", async () => {
    expect(await errorOf(web(`${HUB} ${NODES} edges [ edge from "A" to "C" {} ] {}`))).toBe(
      'edge 1: `to "C"` names no node. Refer to a node by its id or its exact text. The nodes are: hub ("A"), n1 ("B"). A distractor is not drawn and cannot be joined.',
    );
  });

  test("an edge reference that names two nodes asks for an id", async () => {
    expect(
      await errorOf(
        web(`${HUB} nodes [ node text "B" {} node text "B" {} ] {} edges [ edge from "A" to "B" {} ] {}`),
      ),
    ).toContain('`to "B"` matches 2 nodes with that text. Give the one you mean an `id`');
  });

  test("an edge needs both ends", async () => {
    expect(await errorOf(web(`${HUB} ${NODES} edges [ edge from "A" {} ] {}`))).toContain(
      "edge 1: needs both `from` and `to`",
    );
  });

  test("an assessed edge needs its label", async () => {
    expect(
      await errorOf(web(`${HUB} ${NODES} edges [ edge from "A" to "B" assess [expected] {} ] {}`)),
    ).toContain("edge 1: an assessed edge needs `label` — its answer");
  });

  test("ids are unique, and hub is taken", async () => {
    expect(
      await errorOf(web(`${HUB} nodes [ node id "x" text "B" {} node id "x" text "C" {} ] {}`)),
    ).toBe('nodes: two nodes have the id "x". Every id must be different.');
    expect(await errorOf(web(`${HUB} nodes [ node id "hub" text "B" {} ] {}`))).toContain(
      'the id "hub" is taken by the hub',
    );
  });

  test("a distractor that is also an answer", async () => {
    expect(
      await errorOf(web(`${HUB} nodes [ ${BLANK} node text "x" assess [distractor] {} ] {}`)),
    ).toContain('nodes: distractor "x" is also a correct answer');
  });

  test("distractors without blanks", async () => {
    expect(
      await errorOf(web(`${HUB} nodes [ node text "B" {} node text "x" assess [distractor] {} ] {}`)),
    ).toBe(
      "nodes: has a distractor but no blanks. Distractors join a tray of answers — give at least one node `assess [expected]`.",
    );
  });

  test("a word given twice in a chain", async () => {
    expect(await errorOf(web(`${HUB} nodes [ node text "B" text "C" {} ] {}`))).toBe(
      "text: is given twice. Each word may appear once in a chain.",
    );
  });

  test("a program that is not a concept web", async () => {
    expect(await errorOf(`42..`)).toContain("A program is one concept web");
  });
});
