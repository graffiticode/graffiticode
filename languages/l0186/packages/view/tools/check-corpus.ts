// SPDX-License-Identifier: MIT
/**
 * The L0186 corpus gate: compile every program in a generated batch and lint its boards.
 *
 * Runs between `create-items-from-prompts` and `generate-embeddings-from-examples` (console):
 * whatever is embedded is retrieved by every later generation, so a program that draws a line
 * through a node, puts a waypoint inside one or attaches to the wrong side teaches that mistake to
 * every board after it. The rules are `src/lib/lint.ts`, checked on the routes the preview draws.
 *
 * Input is either file the console scripts write:
 *   - the audit log of `create-items-from-prompts --output <file>`: `[{exampleNumber, normalizedCode, error?}]`
 *   - the embeddings log `training/l0186-embeddings.json`: `{stored: [{id, code, …}]}`
 *   - or `[{n, code}]`.
 *
 * Exit 0 = safe to embed; exit 1 = findings, a program that does not compile, or an empty input
 * (never a vacuous pass); exit 2 = usage.
 *
 * Usage (from languages/l0186, after `npm run build`): npm run check-corpus -- <file> [--quiet]
 */
import { readFileSync } from "fs";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "@graffiticode/l0186";
import { lintPage } from "../src/lib/lint";
import { estimate } from "../src/lib/text";

const file = process.argv[2];
const quiet = process.argv.includes("--quiet");
if (!file || file.startsWith("--")) {
  console.error("usage: npm run check-corpus -- <audit-log.json | l0186-embeddings.json> [--quiet]");
  process.exit(2);
}

interface Entry {
  label: string;
  code: string;
}

function entries(raw: any): Entry[] {
  const rows: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.stored) ? raw.stored : [];
  return rows
    .filter((r) => !r?.error)
    .map((r, i) => ({
      label: String(r.exampleNumber ?? r.n ?? r.exampleId ?? r.id ?? i + 1),
      code: r.normalizedCode ?? r.code ?? r.src ?? "",
    }));
}

async function compile(src: string): Promise<any> {
  const code: any = await parser.parse(186, src.trim().endsWith("..") ? src : `${src}..`, lexicon);
  const err: any = Object.values(code).find((n: any) => n && n.tag === "ERROR");
  if (err) throw new Error("parse error");
  return await new Promise((resolve, reject) =>
    compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) reject(new Error(String(errs[0]?.message ?? errs[0])));
      else resolve(v);
    }),
  );
}

const raw = JSON.parse(readFileSync(file, "utf-8"));
const all = entries(raw);
const skipped = (Array.isArray(raw) ? raw : []).filter((r: any) => r?.error).length;
if (!all.length) {
  console.error(`[l0186 gate] ${file}: no programs — refusing to pass a vacuous check`);
  process.exit(1);
}

const failing: string[] = [];
let findings = 0;
for (const e of all) {
  const problems: string[] = [];
  if (!e.code.trim()) problems.push("no program");
  else {
    try {
      const board = await compile(e.code);
      for (const page of board.pages ?? []) {
        for (const f of lintPage(page.nodes ?? [], estimate)) problems.push(`[${f.rule}] ${f.message}`);
      }
    } catch (x: any) {
      problems.push(`does not compile: ${x?.message ?? x}`);
    }
  }
  if (problems.length) {
    failing.push(e.label);
    findings += problems.length;
    console.log(`✗ ${e.label}`);
    for (const p of problems) console.log(`    ${p}`);
  } else if (!quiet) {
    console.log(`✓ ${e.label}`);
  }
}

console.log(`\n[l0186 gate] ${all.length} programs: ${all.length - failing.length} pass, ${failing.length} fail (${findings} findings)${skipped ? `; ${skipped} entries had generation errors and were not checked` : ""}.`);
if (failing.length) {
  console.log(`Do not embed this batch. Fix what the findings name, then re-run: --only ${failing.join(",")}`);
}
process.exit(failing.length ? 1 : 0);
