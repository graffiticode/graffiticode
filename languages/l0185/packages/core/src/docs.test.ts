// SPDX-License-Identifier: MIT
/**
 * The docs must be true. The code generator writes from instructions.md and retrieves from
 * examples.md, so a wrong example is reproduced verbatim into generated programs. Every program
 * in the docs compiles (against the served sample data, read from `data/`), the word tables are
 * the lexicon, every tag is documented, and the corpus prompts are well formed.
 *
 * Paths are relative (spec/): run with packages/core as the cwd, as the workspace script does.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { lexicon as base } from "@graffiticode/l0000";
import { compile } from "./harness.js";
import { TAGS, lexicon, stepFields, wordOf } from "./index.js";

const SPEC_FILES = ["spec/spec.md", "spec/instructions.md"];

/** Every fenced block in a markdown file. */
function blocks(path: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const l of readFileSync(path, "utf-8").split("\n")) {
    if (l.trim().startsWith("```")) {
      if (cur) {
        out.push(cur.join("\n"));
        cur = null;
      } else cur = [];
      continue;
    }
    if (cur) cur.push(l);
  }
  return out;
}

const isProgram = (src: string): boolean => !!src && src.trim().endsWith("..");

/** The word table, generated from the lexicon. */
export function wordTable(): string {
  const rows = Object.entries(stepFields).map(([name, meta]) => {
    const role = meta.role === "option" ? `option of \`${meta.of}\`` : meta.role;
    return `| \`${wordOf(name)}\` | ${role} | \`${lexicon[wordOf(name)].type}\` | ${meta.description.replace(/\|/g, "\\|")} |`;
  });
  return ["| Word | Kind | Signature | Meaning |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

describe("spec programs", () => {
  test("spec.md and instructions.md carry programs", () => {
    for (const f of SPEC_FILES) expect(blocks(f).filter(isProgram).length, `${f} has no programs`).toBeGreaterThan(0);
  });

  test("every program in spec/ compiles", async () => {
    for (const f of SPEC_FILES) {
      for (const src of blocks(f).filter(isProgram)) {
        await expect(compile(src), `${f}:\n${src}`).resolves.toBeDefined();
      }
    }
  });

  test("the template compiles to data", async () => {
    const out = await compile(readFileSync("spec/template.gc", "utf-8"));
    expect(Array.isArray(out) && out.length).toBeTruthy();
  });
});

describe("spec and lexicon agree", () => {
  test("the word tables are generated from the lexicon", () => {
    for (const f of SPEC_FILES) {
      const text = readFileSync(f, "utf-8");
      const table = text.split("<!-- words:start -->")[1]?.split("<!-- words:end -->")[0]?.trim();
      expect(table, `${f}: regenerate the table between the words markers`).toBe(wordTable());
    }
  });

  test("every L0185 word is in the table, and only those", () => {
    const own = Object.keys(lexicon).filter((w) => !(w in base) && lexicon[w].cls === "function");
    expect(own.sort()).toEqual(Object.keys(stepFields).map(wordOf).sort());
  });

  test("every tag is documented in spec.md", () => {
    const text = readFileSync("spec/spec.md", "utf-8");
    expect(Object.keys(TAGS).filter((t) => !new RegExp(`(^|[^A-Z-])${t}([^A-Z-]|$)`).test(text))).toEqual([]);
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
  test("prompts ask for data, not for code", () => {
    expect(prompts.filter((l) => /\{\}|\.\.$|\bgroup-by \[|\bsort-by \[|\bwhere \[/.test(l))).toEqual([]);
  });
  test("prompts point only at the served sample data", () => {
    const urls = prompts.flatMap((l) => l.match(/https:\/\/[^\s"]+/g) ?? []);
    expect(urls.filter((u) => !u.startsWith("https://l0185.graffiticode.org/data/"))).toEqual([]);
  });
});

describe("scope.json carries the words the MCP router keeps", () => {
  const KEEP = /\b(ONLY when|do NOT|does NOT|are not built|not built yet|EARLY|never)\b/i;
  const scope = JSON.parse(readFileSync("spec/scope.json", "utf-8"));
  test("every out_of_scope sentence survives the router's filter", () => {
    expect(scope.out_of_scope.filter((s: string) => !KEEP.test(s))).toEqual([]);
  });
  test("the siblings a request might belong to are named", () => {
    const all = scope.out_of_scope.join(" ");
    for (const lang of ["L0184", "L0179", "L0180", "L0170"]) expect(all).toContain(lang);
  });
});
