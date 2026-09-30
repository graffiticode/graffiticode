// SPDX-License-Identifier: MIT
/**
 * Docs must compile.
 *
 * The code generator writes from instructions.md and retrieves from examples.md, so a wrong
 * example is reproduced verbatim into generated programs — and unlike a wrong sentence, it is
 * learned. Paths are relative (spec/): run with packages/core as the cwd, as the workspace
 * script does.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import Ajv from "ajv/dist/2020.js";
import { lexicon as base } from "@graffiticode/l0000";
import { compile } from "./harness.js";
import { containerParts, lexicon, plotKindAttributes, validAttributes, validSettings } from "./index.js";

const SPEC_FILES = ["spec/spec.md", "spec/instructions.md", "spec/usage-guide.md"];

/** Every fenced block in a markdown file, dedented by its fence's indentation. */
function blocks(path: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  let fence = "";
  for (const l of readFileSync(path, "utf-8").split("\n")) {
    if (l.trim().startsWith("```")) {
      if (cur) {
        out.push(cur.join("\n"));
        cur = null;
      } else {
        cur = [];
        fence = l.match(/^\s*/)![0];
      }
      continue;
    }
    if (cur) cur.push(l.startsWith(fence) ? l.slice(fence.length) : l);
  }
  return out;
}

/** A fenced block that is a program, recognized by its terminator. */
const isProgram = (src: string): boolean => !!src && src.trim().endsWith("..");

describe("spec programs", () => {
  test("spec.md and instructions.md carry programs", () => {
    for (const f of ["spec/spec.md", "spec/instructions.md"]) {
      expect(blocks(f).filter(isProgram).length, `${f} has no programs`).toBeGreaterThan(0);
    }
  });

  test("every program in spec/ compiles, not merely parses", async () => {
    for (const f of SPEC_FILES) {
      for (const src of blocks(f).filter(isProgram)) {
        await expect(compile(src), `${f}:\n${src}`).resolves.toBeTruthy();
      }
    }
  });

  test("the starter template compiles to a chart with data", async () => {
    const out = await compile(readFileSync("spec/template.gc", "utf-8"));
    expect(out.charts[0].view.empty).toBe(false);
    expect(out.charts[0].option.series.length).toBeGreaterThan(1);
  });
});

describe("spec and lexicon agree", () => {
  const ROW = /^\|\s*`([a-z-]+)`\s*\|\s*`(<[^`]*>)`\s*\|/;
  function documented(path: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const m = line.replace(/\\\|/g, "|").match(ROW);
      if (m) out.set(m[1], m[2]);
    }
    return out;
  }
  // Derived rather than listed, so adding a word cannot silently escape the documentation gate.
  const dialect = Object.keys(lexicon).filter((w) => !(w in base) && lexicon[w].cls === "function");

  test("every documented word exists, with the signature the lexicon gives it", () => {
    for (const f of ["spec/spec.md", "spec/instructions.md"]) {
      for (const [w, sig] of documented(f)) {
        expect(lexicon[w], `${f} documents \`${w}\`, which is not in the lexicon`).toBeDefined();
        expect(lexicon[w].type, `${f}: \`${w}\` signature drift`).toBe(sig);
      }
    }
  });

  test("every L0184 word is documented in instructions.md and spec.md", () => {
    for (const f of ["spec/spec.md", "spec/instructions.md"]) {
      const words = documented(f);
      expect(dialect.filter((w) => !words.has(w)), `${f} is missing words`).toEqual([]);
    }
  });

  test("every tag is documented in spec.md", () => {
    const text = readFileSync("spec/spec.md", "utf-8");
    const tags = Object.keys(lexicon).filter((w) => !(w in base) && lexicon[w].name === "TAG");
    expect(tags.filter((t) => !new RegExp(`\\b${t}\\b`).test(text))).toEqual([]);
  });
});

describe("the tables in instructions.md match the compiler", () => {
  // The generator reads these to decide where a word goes; the compiler rejects on the same
  // tables. If they disagree, the docs teach a refused program.
  function table(heading: string): Map<string, string[]> {
    const text = readFileSync("spec/instructions.md", "utf-8");
    const section = text.split(new RegExp(`^## ${heading}$`, "m"))[1]?.split(/^## /m)[0];
    expect(section, `instructions.md is missing "## ${heading}"`).toBeTruthy();
    const out = new Map<string, string[]>();
    for (const line of section!.split("\n")) {
      const m = line.match(/^\|\s*`([A-Za-z-]+)`\s*\|\s*(.+?)\s*\|\s*$/);
      if (m) out.set(m[1], m[2] === "—" ? [] : m[2].split(",").map((s) => s.trim()).sort());
    }
    return out;
  }
  const same = (rows: Map<string, string[]>, truth: Record<string, readonly string[]>) => {
    expect([...rows.keys()].sort()).toEqual(Object.keys(truth).sort());
    for (const [k, v] of Object.entries(truth)) expect(rows.get(k), k).toEqual([...v].sort());
  };

  test("which parts each container holds", () => {
    same(table("Which parts each container holds"), Object.fromEntries(Object.entries(containerParts).map(([c, p]) => [c, Object.keys(p)])));
  });
  test("which words each description takes", () => same(table("Which words each description takes"), validAttributes));
  test("which words each plot kind takes", () => same(table("Which words each plot kind takes"), plotKindAttributes));
  test("which settings each container takes", () => same(table("Which settings each container takes"), validSettings));
});

describe("schema.json describes what the compiler emits", () => {
  const schema = JSON.parse(readFileSync("spec/schema.json", "utf-8"));
  const ajv = new (Ajv as any)({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const check = (out: any, where: string) => expect(validate(out), `${where}: ${ajv.errorsText(validate.errors)}`).toBe(true);

  test("every spec program's compiled output validates", async () => {
    for (const f of SPEC_FILES) for (const src of blocks(f).filter(isProgram)) check(await compile(src), `${f}:\n${src}`);
    check(await compile(readFileSync("spec/template.gc", "utf-8")), "template.gc");
  });

  test("rejects output the compiler could not have produced", async () => {
    const out = await compile(readFileSync("spec/template.gc", "utf-8"));
    out.charts[0].view.nonsense = true;
    expect(validate(out), "additionalProperties:false is not doing its job on a chart view").toBe(false);
    const again = await compile(readFileSync("spec/template.gc", "utf-8"));
    again.view.nonsense = true;
    expect(validate(again), "additionalProperties:false is not doing its job on the collection view").toBe(false);
  });
});

describe("examples.md", () => {
  const text = readFileSync("spec/examples.md", "utf-8");
  const lines = text.split("\n");
  const numbered = lines.map((l) => l.match(/^(\d+)\.\s+\S/)).filter(Boolean).map((m) => Number(m![1]));
  const prompts = lines.filter((l) => /^\d+\.\s/.test(l));
  const headers = lines
    .map((l) => l.match(/^##\s+Category\s+(\d+):\s+.*\((\d+)[–-](\d+)\)\s*$/))
    .filter(Boolean)
    .map((m) => ({ n: Number(m![1]), from: Number(m![2]), to: Number(m![3]) }));

  test("prompts run 1..N with no gaps or repeats", () => {
    expect(numbered).toEqual(Array.from({ length: numbered.length }, (_, i) => i + 1));
  });

  test("categories are numbered in order and their ranges tile the list", () => {
    expect(headers.map((h) => h.n)).toEqual(headers.map((_, i) => i + 1));
    expect(headers[0].from).toBe(1);
    expect(headers[headers.length - 1].to).toBe(numbered.length);
    for (let i = 1; i < headers.length; i++) expect(headers[i].from).toBe(headers[i - 1].to + 1);
  });

  test("the count in the preamble is the count present", () => {
    expect(Number(text.match(/^(\d+) example prompts/m)?.[1])).toBe(numbered.length);
  });

  test("prompts ask for content, not for code", () => {
    const codey = prompts.filter((l) => /\b(charts|plots|axes|datasets) \[|\bplot kind\b|\{\}|\.\.$|\bkind (BAR|LINE|PIE|SCATTER|HISTOGRAM|BOXPLOT|CANDLESTICK|HEATMAP|FUNNEL|GAUGE|RADAR)\b|\bdirection (X|Y|RADIAL)\b/.test(l));
    expect(codey).toEqual([]);
  });

  test("nothing asks for a chart L0184 does not build yet", () => {
    const offside = prompts.filter((l) => /\b(sankey|treemap|sunburst|choropleth|trend line|reference line|annotat\w*|from (this|the) url)\b/i.test(l));
    expect(offside).toEqual([]);
  });
});

describe("scope.json carries the words the MCP router keeps", () => {
  // graffiticode-mcp-server's limitSentences() inlines only sentences matching this.
  const KEEP = /\b(ONLY when|do NOT|does NOT|are not built|not built yet|EARLY|never)\b/i;
  const scope = JSON.parse(readFileSync("spec/scope.json", "utf-8"));

  test("every out_of_scope sentence survives the router's filter", () => {
    expect(scope.out_of_scope.filter((s: string) => !KEEP.test(s))).toEqual([]);
  });

  test("the siblings a request might belong to are named", () => {
    const all = scope.out_of_scope.join(" ");
    for (const lang of ["L0179", "L0183", "L0171", "L0170", "L0180", "L0173"]) expect(all).toContain(lang);
  });
});
