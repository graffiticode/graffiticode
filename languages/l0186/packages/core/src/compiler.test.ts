// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { CAPS, FONT_SIZES, LINE_STYLES, LINE_TYPES, SHAPE_KINDS, SIDES, STAMP_KINDS, STROKE_WIDTHS } from "./attributes.js";
import { compile, errorOf } from "./harness.js";
import { lexicon } from "./lexicon.js";

/** One page holding `body`; the compiled page's nodes. */
const nodesOf = async (body: string) => (await compile(`board [ page [ ${body} ] {} ] {}`)).pages[0].nodes;
const two = `sticky id "A" text "A" {} sticky id "B" text "B" {}`;

describe("the board", () => {
  it("compiles the minimal board", async () => {
    expect(await compile(`board [ page [ ] {} ] {}`)).toEqual({
      type: "board",
      showPageTabs: false,
      showPageMenu: false,
      pages: [{ name: "Page 1", nodes: [] }],
    });
  });

  it("emits every node in the plugin's shape, fields in source order", async () => {
    const nodes = await nodesOf(`
      sticky id "kick" text "Kickoff" x 40 y 80 fill "#ffcc00" opacity 50 font-size MEDIUM {}
      shape kind DIAMOND id "valid" text "Valid?" x 800 y 80 width 200 height 120 stroke "blue" stroke-width THIN {}
      textbox id "title" text "Roadmap" font-size LARGE color "#111111" x 0 y -120 {}
      stamp kind LIKE x 200 y 300 {}
      connector from "kick" to "valid" label "next" line-type ELBOWED line-style DASHED from-cap NONE
        to-cap ARROW_LINES from-side RIGHT to-side LEFT stroke-width THICK {}
    `);
    expect(nodes).toEqual([
      { type: "sticky", id: "kick", text: "Kickoff", x: 40, y: 80, fill: "#ffcc00", opacity: 50, fontSize: 24 },
      { type: "shape", shapeType: "DIAMOND", id: "valid", text: "Valid?", x: 800, y: 80, width: 200, height: 120, stroke: "blue", strokeWidth: 4 },
      { type: "text", id: "title", text: "Roadmap", fontSize: 40, color: "#111111", x: 0, y: -120 },
      { type: "stamp", stamp: "like", x: 200, y: 300 },
      {
        type: "connector",
        from: "kick",
        to: "valid",
        label: "next",
        lineType: "elbowed",
        lineStyle: "dashed",
        fromCap: "none",
        toCap: "arrow-lines",
        fromSide: "right",
        toSide: "left",
        strokeWidth: 8,
      },
    ]);
  });

  it("matches L0172's output for the same board, node for node", async () => {
    // L0172: section "Phase 1" … sticky "kick" label "Kickoff" …, diamond "Valid?", stamp like,
    // connector "next" … line-type elbowed to-cap arrow-lines stroke-width thick, text "T" ….
    const nodes = await nodesOf(`
      section [ sticky id "kick" text "Kickoff" x 40 y 80 fill "#ffcc00" {} ] name "Phase 1" x 0 y 0 width 700 height 400 {}
      shape kind DIAMOND id "Valid?" text "Valid?" x 800 y 80 {}
      stamp kind LIKE x 200 y 300 {}
      connector from "kick" to "Valid?" label "next" line-type ELBOWED to-cap ARROW_LINES stroke-width THICK {}
      textbox id "T" text "T" font-size LARGE color "#111111" {}
    `);
    const l0172 = [
      { type: "section", name: "Phase 1", x: 0, y: 0, width: 700, height: 400, nodes: [{ type: "sticky", id: "kick", text: "Kickoff", x: 40, y: 80, fill: "#ffcc00" }] },
      { type: "shape", shapeType: "DIAMOND", id: "Valid?", text: "Valid?", x: 800, y: 80 },
      { type: "stamp", stamp: "like", x: 200, y: 300 },
      { type: "connector", label: "next", from: "kick", to: "Valid?", lineType: "elbowed", toCap: "arrow-lines", strokeWidth: 8 },
      { type: "text", id: "T", text: "T", fontSize: 40, color: "#111111" },
    ];
    expect(nodes).toEqual(l0172);
  });

  it("defaults a shape to SQUARE", async () => {
    expect((await nodesOf(`shape text "Box" {}`))[0].shapeType).toBe("SQUARE");
  });

  it("names a lone page Page 1 and turns tabs on for two pages", async () => {
    const b = await compile(`board [ page [ ] name "A" {} page [ ] name "B" background "#f5f5f5" {} ] title "Q4" {}`);
    expect(b.pages.map((p: any) => p.name)).toEqual(["A", "B"]);
    expect(b.pages[1].background).toBe("#f5f5f5");
    expect(b).toMatchObject({ title: "Q4", showPageTabs: true, showPageMenu: false });
  });

  it("keeps explicit tab and menu settings", async () => {
    const b = await compile(`board [ page [ ] name "A" {} page [ ] name "B" {} ] show-page-tabs false show-page-menu true {}`);
    expect(b).toMatchObject({ showPageTabs: false, showPageMenu: true });
  });

  it("never carries upstream data into the output", async () => {
    const b = await compile(`board [ page [ ] {} ] {}`, { secret: 1 });
    expect(b.secret).toBeUndefined();
  });
});

describe("save-to-figjam", () => {
  it("adds the file key from a board link, before or after the board", async () => {
    for (const src of [
      `save-to-figjam "https://www.figma.com/board/ABC123/Demo?node-id=0-1"\nboard [ page [ ] {} ] {}`,
      `board [ page [ ] {} ] {}\nsave-to-figjam "https://www.figma.com/board/ABC123/Demo"`,
    ]) {
      expect((await compile(src)).fileKey).toBe("ABC123");
    }
  });

  it("accepts a design or file link, or a bare key", async () => {
    for (const t of ["https://figma.com/design/XYZ987/x", "https://www.figma.com/file/XYZ987", "XYZ987"]) {
      expect((await compile(`save-to-figjam "${t}" board [ page [ ] {} ] {}`)).fileKey).toBe("XYZ987");
    }
  });

  it("is left out of a preview-only board", async () => {
    expect("fileKey" in (await compile(`board [ page [ ] {} ] {}`))).toBe(false);
  });

  it("is rejected twice, or without a board", async () => {
    expect(await errorOf(`save-to-figjam "ABC123" save-to-figjam "ABC123" board [ page [ ] {} ] {}`)).toMatch(/given twice/);
    expect(await errorOf(`save-to-figjam "ABC123"`)).toMatch(/A program is one board/);
  });
});

describe("tags", () => {
  it("accepts every shape kind, emitted as FigJam's shapeType", async () => {
    const nodes = await nodesOf(SHAPE_KINDS.map((k) => `shape kind ${k} id "${k}" {}`).join(" "));
    expect(nodes.map((n: any) => n.shapeType)).toEqual([...SHAPE_KINDS]);
  });

  it("accepts every stamp, emitted lowercase", async () => {
    const nodes = await nodesOf(STAMP_KINDS.map((k) => `stamp kind ${k} {}`).join(" "));
    expect(nodes.map((n: any) => n.stamp)).toEqual(STAMP_KINDS.map((k) => k.toLowerCase()));
  });

  it("emits line enums in the plugin's lower-kebab spelling", async () => {
    for (const t of LINE_TYPES) expect((await nodesOf(`${two} connector from "A" to "B" line-type ${t} {}`))[2].lineType).toBe(t.toLowerCase());
    for (const t of LINE_STYLES) expect((await nodesOf(`${two} connector from "A" to "B" line-style ${t} {}`))[2].lineStyle).toBe(t.toLowerCase());
    for (const t of CAPS) {
      const c = (await nodesOf(`${two} connector from "A" to "B" from-cap ${t} to-cap ${t} {}`))[2];
      expect([c.fromCap, c.toCap]).toEqual([t.toLowerCase().replace(/_/g, "-"), t.toLowerCase().replace(/_/g, "-")]);
    }
    for (const t of SIDES) {
      const c = (await nodesOf(`${two} connector from "A" to "B" from-side ${t} to-side ${t} {}`))[2];
      expect([c.fromSide, c.toSide]).toEqual([t.toLowerCase(), t.toLowerCase()]);
    }
  });

  it("maps size presets to pixels, and takes numbers", async () => {
    for (const [t, px] of Object.entries(FONT_SIZES)) expect((await nodesOf(`textbox text "x" font-size ${t} {}`))[0].fontSize).toBe(px);
    for (const [t, px] of Object.entries(STROKE_WIDTHS)) expect((await nodesOf(`shape stroke-width ${t} {}`))[0].strokeWidth).toBe(px);
    expect((await nodesOf(`textbox text "x" font-size 30 {}`))[0].fontSize).toBe(30);
    expect((await nodesOf(`shape stroke-width 2 {}`))[0].strokeWidth).toBe(2);
  });

  it("rejects a quoted tag, naming the bare spelling", async () => {
    const conn = (words: string) => `board [ page [ ${two} connector from "A" to "B" ${words} {} ] {} ] {}`;
    expect(await errorOf(conn(`line-type "elbowed"`))).toMatch(/Write it bare and uppercase, without quotes: line-type ELBOWED/);
    expect(await errorOf(conn(`to-cap "arrow-lines"`))).toMatch(/without quotes: to-cap ARROW_LINES/);
  });

  it("rejects a tag from another set", async () => {
    expect(await errorOf(`board [ page [ ${two} connector from "A" to "B" line-type TOP {} ] {} ] {}`)).toMatch(/line-type: expected one of STRAIGHT, ELBOWED, CURVED, got the tag TOP/);
  });

  it("leaves L0000's `or` working beside the OR shape", async () => {
    expect(lexicon.or.name).toBe("OR");
    expect(lexicon.OR.name).toBe("TAG");
    expect((await nodesOf(`shape kind OR text "or" {}`))[0].shapeType).toBe("OR");
  });
});

describe("connectors", () => {
  it("resolve ids, fall back to text, and take lists and *", async () => {
    const nodes = await nodesOf(`
      sticky id "a" text "Alpha" {} sticky text "Beta" {} stamp kind LIKE {}
      connector from "a" to "Beta" {}
      connector from "a" to ["Beta" "like"] {}
      connector from "Beta" to "*" {}
    `);
    expect(nodes.slice(3).map((c: any) => c.to)).toEqual(["Beta", ["Beta", "like"], "*"]);
  });

  it("reach nodes inside a section", async () => {
    await expect(nodesOf(`section [ sticky id "in" {} ] name "S" {} sticky id "out" {} connector from "out" to "in" {}`)).resolves.toHaveLength(3);
  });

  it("reject an unknown endpoint, listing what the page has", async () => {
    expect(await errorOf(`board [ page [ ${two} connector from "A" to "C" {} ] {} ] {}`)).toBe(
      'page "Page 1": connector to "C": no node on this page has that id or text. It has: "A", "B".',
    );
  });

  it("reject an endpoint on another page, naming it", async () => {
    expect(await errorOf(`board [ page [ sticky id "a" {} connector from "a" to "b" {} ] name "One" {} page [ sticky id "b" {} ] name "Two" {} ] {}`)).toBe(
      'page "One": connector to "b": that node is on page "Two". A connector joins nodes on its own page.',
    );
  });

  it("reject a section as an endpoint", async () => {
    expect(await errorOf(`board [ page [ section [ sticky id "a" {} ] name "S" {} sticky id "b" {} connector from "b" to "S" {} ] {} ] {}`)).toMatch(
      /names a section, and a connector cannot attach to a section yet/,
    );
  });

  it("reject text two nodes share, unless an id says which", async () => {
    expect(await errorOf(`board [ page [ sticky text "Same" {} sticky text "Same" {} sticky id "x" {} connector from "x" to "Same" {} ] {} ] {}`)).toMatch(
      /2 nodes say "Same", so it could mean any of them/,
    );
  });

  it("need both ends", async () => {
    expect(await errorOf(`board [ page [ ${two} connector from "A" {} ] {} ] {}`)).toMatch(/needs both from and to/);
  });
});

describe("rules", () => {
  it("rejects a duplicate id on a page, but not across pages", async () => {
    expect(await errorOf(`board [ page [ sticky id "a" {} shape id "a" {} ] {} ] {}`)).toBe('page "Page 1": two nodes have the id "a". Ids must be unique on a page.');
    await expect(compile(`board [ page [ sticky id "a" {} ] name "1" {} page [ sticky id "a" {} ] name "2" {} ] {}`)).resolves.toBeTruthy();
  });

  it("rejects duplicate page names", async () => {
    expect(await errorOf(`board [ page [ ] name "A" {} page [ ] name "A" {} ] {}`)).toMatch(/two pages are named "A"/);
  });

  it("rejects hiding the tabs of a multi-page board without a menu", async () => {
    expect(await errorOf(`board [ page [ ] name "A" {} page [ ] name "B" {} ] show-page-tabs false {}`)).toMatch(/hides every page but the first/);
  });

  it("checks values in the Transformer, for every list element", async () => {
    // Checker.LIST visits only the first element, so this must not pass on the third.
    expect(await errorOf(`board [ page [ sticky {} sticky {} sticky opacity 140 {} ] {} ] {}`)).toMatch(/opacity: expected a number from 0 to 100, got 140/);
    expect(await errorOf(`board [ page [ shape width 0 {} ] {} ] {}`)).toMatch(/width: expected a number of pixels above 0/);
    expect(await errorOf(`board [ page [ sticky fill "chartreuse" {} ] {} ] {}`)).toMatch(/expected a hex colour/);
  });

  it("allows a section only on a page, and connectors only on a page", async () => {
    expect(await errorOf(`board [ page [ section [ section [ ] {} ] {} ] {} ] {}`)).toMatch(/item 1 is a `section`, which is not a member of section/);
    expect(await errorOf(`board [ page [ section [ connector from "a" to "b" {} ] {} ] {} ] {}`)).toMatch(/item 1 is a `connector`, which is not a member of section/);
  });

  it("lets L0000 expressions run inside a program", async () => {
    const nodes = await nodesOf(`sticky text "n" x add 100 20 {}`);
    expect(nodes[0].x).toBe(120);
  });
});
