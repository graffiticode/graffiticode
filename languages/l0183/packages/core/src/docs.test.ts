// SPDX-License-Identifier: MIT
/**
 * Docs must compile.
 *
 * This is not a documentation nit. The code generator writes from instructions.md and
 * retrieves from examples.md, so a wrong example is reproduced verbatim into generated
 * programs — and unlike a wrong sentence, it is learned.
 *
 * Read paths are relative (spec/), so these run with packages/core as the cwd
 * (`npm run -w packages/core test`), which is what the workspace script does.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import Ajv from "ajv/dist/2020.js";
import { lexicon as base } from "@graffiticode/l0000";
import { compile } from "./harness.js";
import { lexicon, validAttributes, validSettings } from "./index.js";

/** Files whose fenced blocks are programs. examples.md holds prompts and is checked separately. */
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

/**
 * A fenced block that is a program, rather than a table or a JSON sample. Recognized by the
 * terminator, not by a list of opening words, which would go stale as the vocabulary changes.
 */
const isProgram = (src: string): boolean => !!src && src.trim().endsWith("..");

describe("spec programs", () => {
  test("no spec file has silently stopped carrying programs", () => {
    for (const f of SPEC_FILES.filter((f) => f !== "spec/usage-guide.md")) {
      expect(blocks(f).filter(isProgram).length, `${f} has no programs`).toBeGreaterThan(0);
    }
  });

  test("every program fragment in spec/ compiles, not merely parses", async () => {
    for (const f of SPEC_FILES) {
      for (const src of blocks(f).filter(isProgram)) {
        await expect(compile(src), `${f}:\n${src}`).resolves.toBeTruthy();
      }
    }
  });

  test("the starter template compiles and shows a blank and a tray", async () => {
    const out = await compile(readFileSync("spec/template.gc", "utf-8"));
    expect(Object.keys(out.validation.cells).length).toBeGreaterThan(0);
    expect(out.interaction.trays.nodes.items.length).toBeGreaterThan(0);
  });

  test("spec.md's claim about the starter web's pools holds", async () => {
    // spec.md says the two blank spokes of "Parts of a cell" accept each other's answers.
    const src = blocks("spec/spec.md").filter(isProgram)[0];
    const out = await compile(src);
    const pools = Object.values(out.validation.cells).map((c: any) => c.pool);
    expect(new Set(pools).size).toBe(1);
  });
});

describe("spec and lexicon agree", () => {
  const ROW = /^\|\s*`([a-z-]+)`\s*\|\s*`(<[^`]*>)`\s*\|/;

  function documented(path: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const m = line.match(ROW);
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

  test("every L0183 word is documented in instructions.md and spec.md", () => {
    for (const f of ["spec/spec.md", "spec/instructions.md"]) {
      const words = documented(f);
      expect(dialect.filter((w) => !words.has(w)), `${f} is missing words`).toEqual([]);
    }
  });
});

describe("the container tables match the compiler", () => {
  // The generator reads these tables to decide where a word goes; the compiler rejects on
  // validAttributes and validSettings. If they disagree, the docs teach a refused program.
  function table(heading: string): Map<string, string[]> {
    const text = readFileSync("spec/instructions.md", "utf-8");
    const section = text.split(new RegExp(`^## ${heading}$`, "m"))[1]?.split(/^## /m)[0];
    expect(section, `instructions.md is missing "## ${heading}"`).toBeTruthy();
    const out = new Map<string, string[]>();
    for (const line of section!.split("\n")) {
      const m = line.match(/^\|\s*`([a-z-]+)`\s*\|\s*(.+?)\s*\|\s*$/);
      if (m) out.set(m[1], m[2].split(",").map((s) => s.trim()).sort());
    }
    return out;
  }

  test("which words each container takes", () => {
    const rows = table("Which words each container takes");
    expect([...rows.keys()].sort()).toEqual(Object.keys(validAttributes).sort());
    for (const [c, allowed] of Object.entries(validAttributes)) {
      expect(rows.get(c), c).toEqual([...allowed].sort());
    }
  });

  test("which settings each container takes", () => {
    const rows = table("Which settings each container takes");
    expect([...rows.keys()].sort()).toEqual(Object.keys(validSettings).sort());
    for (const [c, allowed] of Object.entries(validSettings)) {
      expect(rows.get(c), c).toEqual([...allowed].sort());
    }
  });
});

describe("schema.json describes what the compiler actually emits", () => {
  const schema = JSON.parse(readFileSync("spec/schema.json", "utf-8"));
  const ajv = new (Ajv as any)({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const check = (out: any, where: string) =>
    expect(validate(out), `${where}: ${ajv.errorsText(validate.errors)}`).toBe(true);

  test("every spec program's compiled output validates", async () => {
    for (const f of SPEC_FILES) {
      for (const src of blocks(f).filter(isProgram)) check(await compile(src), `${f}:\n${src}`);
    }
    check(await compile(readFileSync("spec/template.gc", "utf-8")), "template.gc");
  });

  test("a web carrying learner answers validates", async () => {
    const out = await compile(readFileSync("spec/template.gc", "utf-8"), {
      interaction: { cells: { n2: { value: "Idea C" }, n3: { value: "Idea B" } } },
    });
    check(out, "answered");
  });

  test("rejects output the compiler could not have produced", async () => {
    const out = await compile(readFileSync("spec/template.gc", "utf-8"));
    out.interaction.hub.nonsense = true;
    expect(validate(out), "additionalProperties:false is not doing its job").toBe(false);
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
    // A prompt that writes the program teaches the generator to echo syntax instead of reading
    // intent — and this is the retrieval corpus, so it is learned.
    const codey = prompts.filter((l) =>
      /\b(concept-web|nodes|edges|assess) \[|\b(node|edge|hub) text "|\{\}|\.\.$|\btheme (DARK|LIGHT)\b|\binstant-feedback (true|false)\b|\bassess \[(expected|distractor)/.test(
        l,
      ),
    );
    expect(codey).toEqual([]);
  });

  test("nothing asks for a layout L0183 does not have", () => {
    const offside = prompts.filter((l) => /\b(flowchart|timeline|venn|org chart)\b/i.test(l));
    expect(offside).toEqual([]);
  });
});

describe("image URLs in the docs are real", () => {
  const FILES = ["spec/spec.md", "spec/instructions.md", "spec/usage-guide.md", "spec/examples.md"];
  const PLACEHOLDER =
    /^https?:\/\/([^/]*\.)?(example\.(com|org|net)|placeholder\S*|localhost|127\.0\.0\.1|your-\S*|my-\S*)(\/|:|$)/i;
  for (const f of FILES) {
    test(`${f} names no placeholder host`, () => {
      const urls = (readFileSync(f, "utf-8").match(/https?:\/\/[^\s"'`)\]<]+/g) ?? []).map((u) =>
        u.replace(/[.,;:]+$/, ""),
      );
      expect(urls.filter((u) => PLACEHOLDER.test(u))).toEqual([]);
    });
  }
});

describe("scope.json carries the words the MCP router keeps", () => {
  // graffiticode-mcp-server's limitSentences() inlines only sentences matching this into its
  // instructions. A negative clause without one of these words never reaches the router.
  const KEEP = /\b(ONLY when|do NOT|does NOT|are not built|not built yet|EARLY|never)\b/i;
  const scope = JSON.parse(readFileSync("spec/scope.json", "utf-8"));

  test("every out_of_scope sentence survives the router's filter", () => {
    expect(scope.out_of_scope.filter((s: string) => !KEEP.test(s))).toEqual([]);
  });

  test("the siblings a request might belong to are named", () => {
    const all = scope.out_of_scope.join(" ");
    for (const lang of ["L0171", "L0180", "L0176", "L0169"]) expect(all).toContain(lang);
  });
});
