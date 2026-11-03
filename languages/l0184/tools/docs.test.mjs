// SPDX-License-Identifier: MIT
/**
 * Docs must compile, and must agree with the language (interpreter plan A6: ported from the
 * TypeScript core's docs.test.ts, with no compiler).
 *
 * The code generator writes from instructions.md and retrieves from examples.md, so a wrong
 * example is reproduced verbatim into generated programs. The lexicon is L0000's (the Rust
 * kernel's src/lexicon.json) merged with L0184's additions; the legality tables are
 * crates/core/src/vocab.json; a program's compiled output is the trusted conformance fixture's,
 * which crates/core/tests/conformance.rs proves the Rust produces exactly. A spec program that
 * isn't in the fixture fails here: parse it with @graffiticode/parser, add it to cases.json with
 * the Rust's output, and review that as a change to the language.
 *
 *   node --test tools/docs.test.mjs
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf-8");
const json = (f) => JSON.parse(read(f));
const base = JSON.parse(readFileSync(join(root, "../l0000/crates/core/src/lexicon.json"), "utf-8"));
const additions = json("crates/core/src/lexicon-additions.json");
const lexicon = { ...base, ...additions };
const vocab = json("crates/core/src/vocab.json");
const cases = json("crates/core/tests/conformance/cases.json");

const SPEC_FILES = ["spec/spec.md", "spec/instructions.md", "spec/usage-guide.md"];

/** Every fenced block in a markdown file, dedented by its fence's indentation. */
function blocks(path) {
  const out = [];
  let cur = null;
  let fence = "";
  for (const l of read(path).split("\n")) {
    if (l.trim().startsWith("```")) {
      if (cur) {
        out.push(cur.join("\n"));
        cur = null;
      } else {
        cur = [];
        fence = l.match(/^\s*/)[0];
      }
      continue;
    }
    if (cur) cur.push(l.startsWith(fence) ? l.slice(fence.length) : l);
  }
  return out;
}
const isProgram = (src) => !!src && src.trim().endsWith("..");

/** A program's compiled output, from the trusted fixture (compiled with no upstream data). */
const outputs = new Map();
for (const c of cases) {
  if (c.data !== undefined && c.data !== null) continue;
  outputs.set(c.src, c.expect);
  outputs.set(c.src.trim(), c.expect);
}
function compile(src) {
  const expect = outputs.get(src) ?? outputs.get(src.trim()) ?? outputs.get(`${src.trim()}..`);
  assert.ok(expect, `not in the trusted fixture (crates/core/tests/conformance/cases.json):\n${src}`);
  assert.ok(!expect.errors, `compiles with errors: ${JSON.stringify(expect.errors)}\n${src}`);
  return JSON.parse(expect.text);
}

describe("spec programs", () => {
  test("spec.md and instructions.md carry programs", () => {
    for (const f of ["spec/spec.md", "spec/instructions.md"]) assert.ok(blocks(f).filter(isProgram).length > 0, `${f} has no programs`);
  });
  test("every program in spec/ compiles, not merely parses", () => {
    for (const f of SPEC_FILES) for (const src of blocks(f).filter(isProgram)) assert.ok(compile(src), `${f}:\n${src}`);
  });
  test("the starter template compiles to a chart with data", () => {
    const out = compile(read("spec/template.gc"));
    assert.equal(out.charts[0].view.empty, false);
    assert.ok(out.charts[0].option.series.length > 1);
  });
});

describe("spec and lexicon agree", () => {
  const ROW = /^\|\s*`([a-z-]+)`\s*\|\s*`(<[^`]*>)`\s*\|/;
  const documented = (path) => {
    const out = new Map();
    for (const line of read(path).split("\n")) {
      const m = line.replace(/\\\|/g, "|").match(ROW);
      if (m) out.set(m[1], m[2]);
    }
    return out;
  };
  // Derived rather than listed, so adding a word cannot silently escape the documentation gate.
  const dialect = Object.keys(lexicon).filter((w) => !(w in base) && lexicon[w].cls === "function");
  test("every documented word exists, with the signature the lexicon gives it", () => {
    for (const f of ["spec/spec.md", "spec/instructions.md"]) {
      for (const [w, sig] of documented(f)) {
        assert.ok(lexicon[w], `${f} documents \`${w}\`, which is not in the lexicon`);
        assert.equal(lexicon[w].type, sig, `${f}: \`${w}\` signature drift`);
      }
    }
  });
  test("every L0184 word is documented in instructions.md and spec.md", () => {
    for (const f of ["spec/spec.md", "spec/instructions.md"]) {
      const words = documented(f);
      assert.deepEqual(dialect.filter((w) => !words.has(w)), [], `${f} is missing words`);
    }
  });
  test("every tag is documented in spec.md", () => {
    const text = read("spec/spec.md");
    const tags = Object.keys(lexicon).filter((w) => !(w in base) && lexicon[w].name === "TAG");
    assert.deepEqual(tags.filter((t) => !new RegExp(`\\b${t}\\b`).test(text)), []);
  });
});

describe("the tables in instructions.md match the compiler", () => {
  // The generator reads these to decide where a word goes; the compiler rejects on the same
  // tables. If they disagree, the docs teach a refused program.
  const table = (heading) => {
    const section = read("spec/instructions.md").split(new RegExp(`^## ${heading}$`, "m"))[1]?.split(/^## /m)[0];
    assert.ok(section, `instructions.md is missing "## ${heading}"`);
    const out = new Map();
    for (const line of section.split("\n")) {
      const m = line.match(/^\|\s*`([A-Za-z-]+)`\s*\|\s*(.+?)\s*\|\s*$/);
      if (m) out.set(m[1], m[2] === "—" ? [] : m[2].split(",").map((s) => s.trim()).sort());
    }
    return out;
  };
  const same = (rows, truth) => {
    assert.deepEqual([...rows.keys()].sort(), Object.keys(truth).sort());
    for (const [k, v] of Object.entries(truth)) assert.deepEqual(rows.get(k), [...v].sort(), k);
  };
  test("which parts each container holds", () => {
    same(table("Which parts each container holds"), Object.fromEntries(Object.entries(vocab.containerParts).map(([c, p]) => [c, Object.keys(p)])));
  });
  test("which words each description takes", () => same(table("Which words each description takes"), vocab.validAttributes));
  test("which words each plot kind takes", () => same(table("Which words each plot kind takes"), vocab.plotKindAttributes));
  test("which settings each container takes", () => same(table("Which settings each container takes"), vocab.validSettings));
});

describe("schema.json describes what the compiler emits", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(json("spec/schema.json"));
  const check = (out, where) => assert.ok(validate(out), `${where}: ${ajv.errorsText(validate.errors)}`);
  test("every spec program's compiled output validates", () => {
    for (const f of SPEC_FILES) for (const src of blocks(f).filter(isProgram)) check(compile(src), `${f}:\n${src}`);
    check(compile(read("spec/template.gc")), "template.gc");
  });
  test("rejects output the compiler could not have produced", () => {
    const out = compile(read("spec/template.gc"));
    out.charts[0].view.nonsense = true;
    assert.equal(validate(out), false, "additionalProperties:false is not doing its job on a chart view");
    const again = compile(read("spec/template.gc"));
    again.view.nonsense = true;
    assert.equal(validate(again), false, "additionalProperties:false is not doing its job on the collection view");
  });
});

describe("examples.md", () => {
  const text = read("spec/examples.md");
  const lines = text.split("\n");
  const numbered = lines.map((l) => l.match(/^(\d+)\.\s+\S/)).filter(Boolean).map((m) => Number(m[1]));
  const prompts = lines.filter((l) => /^\d+\.\s/.test(l));
  const headers = lines
    .map((l) => l.match(/^##\s+Category\s+(\d+):\s+.*\((\d+)[–-](\d+)\)\s*$/))
    .filter(Boolean)
    .map((m) => ({ n: Number(m[1]), from: Number(m[2]), to: Number(m[3]) }));
  test("prompts run 1..N with no gaps or repeats", () => {
    assert.deepEqual(numbered, Array.from({ length: numbered.length }, (_, i) => i + 1));
  });
  test("categories are numbered in order and their ranges tile the list", () => {
    assert.deepEqual(headers.map((h) => h.n), headers.map((_, i) => i + 1));
    assert.equal(headers[0].from, 1);
    assert.equal(headers[headers.length - 1].to, numbered.length);
    for (let i = 1; i < headers.length; i++) assert.equal(headers[i].from, headers[i - 1].to + 1);
  });
  test("the count in the preamble is the count present", () => {
    assert.equal(Number(text.match(/^(\d+) example prompts/m)?.[1]), numbered.length);
  });
  test("prompts ask for content, not for code", () => {
    const codey = prompts.filter((l) => /\b(charts|plots|axes|datasets) \[|\bplot kind\b|\{\}|\.\.$|\bkind (BAR|LINE|PIE|SCATTER|HISTOGRAM|BOXPLOT|CANDLESTICK|HEATMAP|FUNNEL|GAUGE|RADAR)\b|\bdirection (X|Y|RADIAL)\b/.test(l));
    assert.deepEqual(codey, []);
  });
  test("nothing asks for a chart L0184 does not build yet", () => {
    const offside = prompts.filter((l) => /\b(sankey|treemap|sunburst|choropleth|trend line|reference line|annotat\w*|from (this|the) url)\b/i.test(l));
    assert.deepEqual(offside, []);
  });
});

describe("scope.json carries the words the MCP router keeps", () => {
  // graffiticode-mcp-server's limitSentences() inlines only sentences matching this.
  const KEEP = /\b(ONLY when|do NOT|does NOT|are not built|not built yet|EARLY|never)\b/i;
  const scope = json("spec/scope.json");
  test("every out_of_scope sentence survives the router's filter", () => {
    assert.deepEqual(scope.out_of_scope.filter((s) => !KEEP.test(s)), []);
  });
  test("the siblings a request might belong to are named", () => {
    const all = scope.out_of_scope.join(" ");
    for (const lang of ["L0179", "L0183", "L0171", "L0185", "L0180", "L0173"]) assert.ok(all.includes(lang), lang);
  });
});
