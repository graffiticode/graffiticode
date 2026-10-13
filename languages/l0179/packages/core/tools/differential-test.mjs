// SPDX-License-Identifier: MIT
/**
 * L0166 → L0179 equivalence test.
 *
 * L0179 changes the source surface and nothing else: for a single sheet its compiled output must
 * equal L0166's field for field. That makes equivalence testable rather than asserted, and the
 * existing corpus is the test set — every program real users' requests produced, replayed through
 * both compilers.
 *
 * For each example: parse the L0166 source, translate the AST to L0179 source, compile both, and
 * deep-compare. A mismatch is a bug in L0179 or in the translator, never an acceptable difference.
 *
 * Assert on COMPILED OUTPUT, never on source shape — a source-shape check would pass on programs
 * that compile to the wrong thing, which is how two false PASSes have happened on this stack.
 *
 * Usage:
 *   node packages/core/tools/differential-test.mjs [--l0166 ../l0166] [--corpus <path>] [--limit N]
 */
import { readFileSync } from "fs";
import path from "path";
import { parser } from "@graffiticode/parser";

// ── args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const HOME = process.env.HOME;
const L0166 = arg("--l0166", `${HOME}/work/graffiticode/l0166`);
const CORPUS = arg("--corpus", `${HOME}/work/graffiticode/console/training/l0166-training-examples.md`);
const LIMIT = parseInt(arg("--limit", "0"), 10) || 0;

const { compiler: c166 } = await import(`${L0166}/packages/api/src/compiler.js`);
const { lexicon: lex166 } = await import(`${L0166}/packages/api/src/lexicon.js`);
const { compiler: c179, lexicon: lex179 } = await import("../dist/index.js");

// ── the translator ─────────────────────────────────────────────────────────
// L0166 chains attributes; L0179 groups them in a bracket list. The AST is a flat node pool
// ({id: {tag, elts}} plus `root`), and a chain nests through elts[1], so walking elts[1] from the
// root yields source order.

const ATTRS = new Set([
  "TEXT", "WIDTH", "ALIGN", "BACKGROUND_COLOR", "FONT_WEIGHT", "FONT_SIZE", "FONT_FAMILY",
  "FONT_STYLE", "COLOR", "TEXT_DECORATION", "BORDER", "VERTICAL_ALIGN", "FORMAT", "PROTECTED",
]);
const word = (tag) => tag.toLowerCase().replace(/_/g, "-");

function makeTranslator(pool) {
  const N = (id) => pool[String(id)];

  /** Render a literal node back to source. */
  function lit(id) {
    const n = N(id);
    if (!n) throw new Error(`unresolved node ${id}`);
    switch (n.tag) {
      case "STR": return JSON.stringify(String(n.elts[0]));
      case "NUM": return String(n.elts[0]);
      case "BOOL": return String(n.elts[0]);
      case "NULL": return "null";
      case "TAG": return String(n.elts[0]);
      case "IDENT": return String(n.elts[0]);
      case "LIST": return `[${n.elts.map(lit).join(" ")}]`;
      case "RECORD": return `{${n.elts.map(lit).join(" ")}}`;
      case "BINDING": return `${lit(n.elts[0])}: ${lit(n.elts[1])}`;
      default:
        // A value position holding an expression (e.g. get-val-public "x"): re-emit by tag.
        if (Array.isArray(n.elts) && n.elts.length) {
          return `${word(n.tag)} ${n.elts.map(lit).join(" ")}`;
        }
        throw new Error(`cannot render ${n.tag} as a value`);
    }
  }

  /** Walk a chain of arity-2 attributes into L0179 attribute-list entries. */
  function chainToAttrs(id, out = []) {
    const n = N(id);
    if (!n) return out;
    if (n.tag === "RECORD") {
      // `{}` closes an L0166 chain. A NON-empty terminator injects arbitrary fields straight into
      // the cell record — L0166 accepts it silently; L0179 has no attribute for them and its
      // per-container allowed set would reject them. That is the new language working as intended,
      // so report it as inexpressible rather than dropping data on the floor.
      if (n.elts.length) throw new Error(`chain ends in a non-empty record ${lit(id)} — no attribute expresses those fields`);
      return out;
    }
    if (ATTRS.has(n.tag)) {
      out.push(`${word(n.tag)} ${lit(n.elts[0])}`);
      return chainToAttrs(n.elts[1], out);
    }
    if (n.tag === "ASSESS") {
      const members = N(n.elts[0]).elts
        .map((mid) => {
          const m = N(mid);
          return `${word(m.tag)} ${lit(m.elts[0])}`;
        })
        .join(" ");
      out.push(`assess [${members}]`);
      return chainToAttrs(n.elts[1], out);
    }
    throw new Error(`unexpected ${n.tag} in an attribute chain`);
  }

  /** `cell A1 text "x" {}` → `cell A1 [text "x"]` */
  function entry(id) {
    const n = N(id);
    const key = lit(n.elts[0]);
    const attrs = chainToAttrs(n.elts[1]);
    return `${word(n.tag)} ${key} [${attrs.join(" ")}]`;
  }

  function entries(listId) {
    return N(listId).elts
      // A bare `{}` sometimes appears as a list element in older programs. L0166 merges it, which
      // contributes nothing, so dropping it is behaviour-preserving.
      .filter((id) => !(N(id).tag === "RECORD" && N(id).elts.length === 0))
      .map(entry);
  }

  /** Walk the top-level chain, collecting the pieces of the sheet. */
  function walkTop(id, acc) {
    const n = N(id);
    if (!n) return acc;
    switch (n.tag) {
      // L0166 chains title/instructions at the TOP level, and so does L0179 — they describe the
      // program, not a sheet. They go in the tail, before `params`, which discards whatever
      // follows it. (L0179 briefly put them inside the sheet; that was the scope error this
      // corrects, and moving them changes the source shape only, never the compiled output.)
      case "TITLE": acc.head += `title ${lit(n.elts[0])} `; return walkTop(n.elts[1], acc);
      case "INSTRUCTIONS": acc.head += `instructions ${lit(n.elts[0])} `; return walkTop(n.elts[1], acc);
      case "HIDE_FORMULABAR": acc.attrs.push(`hide-formulabar ${lit(n.elts[0])}`); return walkTop(n.elts[1], acc);
      case "COLUMNS": acc.blocks.push(`columns [\n    ${entries(n.elts[0]).join("\n    ")}\n  ] {}`); return walkTop(n.elts[1], acc);
      case "ROWS": acc.blocks.push(`rows [\n    ${entries(n.elts[0]).join("\n    ")}\n  ] {}`); return walkTop(n.elts[1], acc);
      case "CELLS": acc.blocks.push(`cells [\n    ${entries(n.elts[0]).join("\n    ")}\n  ] {}`); return walkTop(n.elts[1], acc);
      case "PARAMS": acc.tail = `params ${lit(n.elts[0])} `; return walkTop(n.elts[1], acc);
      case "RECORD": acc.tail += lit(id); return acc;
      default: throw new Error(`unexpected ${n.tag} at the top level`);
    }
  }

  return function translate(id) {
    const acc = { attrs: [], blocks: [], head: "", tail: "" };
    walkTop(id, acc);
    const body = [...acc.attrs.map((a) => `  ${a}`), ...acc.blocks.map((b) => `  ${b}`)].join("\n");
    return `sheets [\n  sheet "s1" [\n${body.split("\n").map((l) => `  ${l}`).join("\n")}\n  ]\n] ${acc.head}${acc.tail || "{}"}..`;
  };
}

/** L0166 wraps the program in PROG > EXPRS > chain. */
function chainRoot(pool) {
  const prog = pool[String(pool.root)];
  const exprs = pool[String(prog.elts[0])];
  return exprs.elts[exprs.elts.length - 1];
}

// ── compile helpers ────────────────────────────────────────────────────────
function compileWith(compiler, code, config = {}) {
  return new Promise((res, rej) => {
    compiler.compile(code, {}, config, (e, v) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) rej(errs); else res(v);
    });
  });
}

/** First differing path, or null. Order-insensitive for object keys, strict for arrays. */
function diff(a, b, at = "") {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null) return `${at || "<root>"}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: array vs object`;
  if (typeof a !== "object") return `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = diff(a[k], b[k], at ? `${at}.${k}` : k);
    if (d) return d;
  }
  return null;
}

// ── run ────────────────────────────────────────────────────────────────────
const md = readFileSync(CORPUS, "utf-8");
// Split per example first, then match the code fence within each. A single regex spanning
// Prompt→Code silently skips any example whose prompt runs to more than one line, which once
// quietly shrank the test set from 129 to 121.
let blocks = md
  .split(/\n### Example /)
  .slice(1)
  .map((chunk) => {
    const code = chunk.match(/#### Code\n\n```\n([\s\S]*?)\n```/);
    return code ? { src: code[1] } : null;
  })
  .filter(Boolean);
if (LIMIT) blocks = blocks.slice(0, LIMIT);

console.log(`[diff] ${blocks.length} examples from ${path.basename(CORPUS)}`);

let ok = 0;
const failures = [];

for (const [i, ex] of blocks.entries()) {
  const label = `#${i + 1}`;
  let stage = "parse-166";
  try {
    const pool166 = await parser.parse(166, ex.src, lex166);
    if (Object.values(pool166).some((n) => n && n.tag === "ERROR")) throw new Error("L0166 source does not parse");
    stage = "translate";
    const src179 = makeTranslator(pool166)(chainRoot(pool166));
    stage = "parse-179";
    const pool179 = await parser.parse(179, src179, lex179);
    const errNode = Object.values(pool179).find((n) => n && n.tag === "ERROR");
    if (errNode) throw new Error(`L0179 source does not parse: ${JSON.stringify(errNode.elts)}\n${src179}`);
    stage = "compile-166";
    const out166 = await compileWith(c166, pool166);
    stage = "compile-179";
    const out179 = await compileWith(c179, pool179);
    stage = "diff";
    const d = diff(out166, out179);
    if (d) throw new Error(`output differs at ${d}`);
    ok++;
  } catch (e) {
    const msg = Array.isArray(e) ? (e[0]?.message ?? JSON.stringify(e[0])) : (e?.message ?? String(e));
    failures.push({ label, stage, msg: String(msg).slice(0, 300), src: ex.src });
  }
}

console.log(`\n[diff] ${ok}/${blocks.length} identical`);
if (failures.length) {
  const byStage = failures.reduce((a, f) => ((a[f.stage] = (a[f.stage] || 0) + 1), a), {});
  console.log(`[diff] ${failures.length} failed: ${Object.entries(byStage).map(([s, n]) => `${s}=${n}`).join(" ")}`);
  for (const f of failures.slice(0, 12)) console.log(`  ${f.label} [${f.stage}] ${f.msg.split("\n")[0]}`);
  if (failures.length > 12) console.log(`  … and ${failures.length - 12} more`);
}
process.exit(failures.length ? 1 : 0);
