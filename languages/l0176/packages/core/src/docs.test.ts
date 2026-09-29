import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";
function blocks(path: string) {
  const out: string[] = []; let cur: string[] | null = null;
  for (const l of readFileSync(path, "utf-8").split("\n")) {
    if (l.trim().startsWith("```")) { if (cur) { out.push(cur.join("\n")); cur = null; } else cur = []; continue; }
    if (cur) cur.push(l);
  }
  return out;
}
test("every program fragment in spec/ parses against the current lexicon", async () => {
  let ok = 0; const bad: string[] = [];
  for (const f of ["spec/spec.md", "spec/instructions.md"]) {
    for (const b of blocks(f)) {
      const src = b.trim();
      if (!src || src.includes("...") || src.startsWith("{") || src.startsWith("|")) continue;
      const prog = src.endsWith("..") ? src : `${src}..`;
      try { await parser.parse(176, prog, lexicon); ok++; }
      catch (e: any) { bad.push(`${f}\n${src.split("\n").slice(0,4).join("\n")}\n  -> ${String(e).slice(0,150)}`); }
    }
  }
  // The vocabulary and the documentation drift apart silently otherwise: a
  // renamed keyword or a changed arity leaves spec/ describing a syntax that no
  // longer parses, and the code generator writes from instructions.md.
  expect(bad, `${bad.length} of ${ok + bad.length} fragments failed to parse:\n${bad.join("\n\n")}`).toEqual([]);
});

test("the starter template parses", async () => {
  // spec/template.gc is what a new task opens with, and build-static copies it
  // verbatim into the served bundle. A syntax change silently invalidates it.
  await expect(
    parser.parse(176, readFileSync("spec/template.gc", "utf-8"), lexicon),
  ).resolves.toBeTruthy();
});

// Keywords that have been retired. They are easy to leave behind in prose, where
// nothing parses them — `partial-credit` survived in four spec files and in
// language-info.json's generator notes after it was removed from the lexicon.
const RETIRED = [
  "partial-credit", "alternative-response", "max-word-count",
  "categories", "distractors", "hot-text",
  "learnosity", "features", "layout",
  // Removed 2026-08-25: a redundant alias for `set-var "lrn-id"`. It appeared in one
  // spec fragment (skipped by the compile guard for its `...`) and in zero of the 169
  // training examples, so nothing ever emitted it — but a doc example is what the
  // generator copies, so keep it from returning.
  "id",
];

test("no retired keyword is still documented", () => {
  // Only code — fenced blocks and backticked spans. `categories` and
  // `distractors` are ordinary English, and examples.md is natural-language
  // prompts throughout, so scanning prose would be all false positives.
  // Quoted strings go too: a stimulus reading "sort into the correct
  // categories" is English that happens to sit inside a code fence.
  const code = (text: string) =>
    [...text.matchAll(/```[\s\S]*?```/g), ...text.matchAll(/`[^`\n]+`/g)]
      .map((m) => m[0].replace(/"[^"]*"/g, '""'))
      .join("\n");

  const offences: string[] = [];
  for (const f of readdirSync("spec")) {
    if (!/\.(md|json|gc)$/.test(f)) continue;
    const text = readFileSync(`spec/${f}`, "utf-8");
    const haystack = f.endsWith(".gc") ? text.replace(/"[^"]*"/g, '""') : code(text);
    for (const word of RETIRED) {
      // Not preceded or followed by a word char, hyphen or slash: `learnosity`
      // is retired but `learnosity-key` and `docs/learnosity-audit.md` are not.
      const re = new RegExp(`(?<![\\w/-])${word}(?![\\w/-])`, "g");
      const n = (haystack.match(re) || []).length;
      if (n > 0) offences.push(`spec/${f}: ${word} (${n})`);
    }
  }
  expect(offences, `retired keywords still documented:\n${offences.join("\n")}`).toEqual([]);
});

const QUESTION_TYPES = [
  "mcq", "shorttext", "longtext", "plaintext", "clozetext", "clozeassociation",
  "clozedropdown", "clozeformula", "choicematrix", "orderlist", "classification",
  "bowtie", "custom", "token-highlight",
];

// Signing needs credentials but does not care whether they are real, so the
// whole pipeline runs and every builder gets exercised.
const CONFIG = { learnosity: { key: "test_key", secret: "test_secret_0123456789" } };

async function compileFragment(src: string) {
  const code = await parser.parse(176, src, lexicon);
  return await new Promise<void>((res, rej) =>
    compiler.compile(code, {}, CONFIG, (e: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) rej(errs); else res();
    }));
}

test("every program fragment in spec/ compiles, not merely parses", async () => {
  // Parsing is not enough: `valid-response [0]` on an mcq parses perfectly well
  // and fails in the builder. Twenty stale examples survived the conversion
  // behind a parse-only guard, and the code generator wrote from them.
  const bad: string[] = [];
  let ok = 0;
  for (const f of ["spec/spec.md", "spec/instructions.md"]) {
    for (const b of blocks(f)) {
      const src = b.trim();
      if (!src || src.includes("...")) continue;
      const head = src.split(/[\s[]/)[0];
      let prog = src.endsWith("..")
        ? src
        : QUESTION_TYPES.includes(head)
          ? `set-var "lrn-id" "t" questions [${src}] {}..`
          : ["items", "questions", "author"].includes(head)
            ? `${src}..`
            : head === "item"
              ? `items [${src}] {}..`
              : null;
      if (prog === null) continue;
      // `get-val-public` reads task data the harness has no way to supply, and
      // an `author` fragment may omit the lrn-id its own section establishes.
      // Neither is staleness; substitute so the rest of the program is exercised.
      prog = prog.replace(/get-val-(public|private)\s+"[^"]*"/g, '"test-item-id"');
      if (!/set-var\s+"lrn-id"/.test(prog)) prog = `set-var "lrn-id" "t" ${prog}`;
      // save-to-itembank writes to the Learnosity Data API for real. The guard
      // is about shape, so drop it rather than making a network call from a test.
      prog = prog.replace(/save-to-itembank\s+true/g, "save-to-itembank false");
      prog = prog.replace(/save-to-itembank\s+(?=items\b|questions\b)/g, "");
      try { await compileFragment(prog); ok++; }
      catch (e: any) {
        bad.push(`\n--- ${f}\n${src}\n  -> ${(e?.[0]?.message ?? JSON.stringify(e)).slice(0, 120)}`);
      }
    }
  }
  expect(bad, `${bad.length} of ${ok + bad.length} fragments failed to compile:\n${bad.join("\n")}`)
    .toEqual([]);
});

// A cloze blank is placed by the *template*. The stimulus is the prompt above
// it and is not scanned for `{{response}}`, so a question written with the
// formula in the stimulus and a bare `template "{{response}}"` compiles, signs
// and renders — it just renders wrong: the whole question becomes a prompt with
// an unlabelled box stranded underneath. The code generator writes from these
// files, so a stale example here is not a documentation nit; it is reproduced
// verbatim into generated items.
const CLOZE = /\b(clozeformula|clozetext|clozedropdown|clozeassociation)\s*\[/;

test("no spec example puts a cloze blank in the stimulus", () => {
  const offences: string[] = [];
  for (const f of ["spec/spec.md", "spec/instructions.md"]) {
    for (const b of blocks(f)) {
      if (!CLOZE.test(b)) continue;
      for (const m of b.matchAll(/stimulus\s+"((?:[^"\\]|\\.)*)"/g)) {
        // The counter-example in instructions.md is prose showing the mistake,
        // not a program: it is annotated with an arrow.
        if (/←/.test(b)) continue;
        if (m[1].includes("{{response}}")) {
          offences.push(`${f}: stimulus contains {{response}} — ${m[1].slice(0, 60)}`);
        }
      }
    }
  }
  expect(offences, offences.join("\n")).toEqual([]);
});

test("no clozeformula example leaves the formula in the stimulus", () => {
  const offences: string[] = [];
  for (const f of ["spec/spec.md", "spec/instructions.md"]) {
    for (const b of blocks(f)) {
      if (!/\bclozeformula\s*\[/.test(b) || /←/.test(b)) continue;
      const template = b.match(/template\s+"((?:[^"\\]|\\.)*)"/);
      const stimulus = b.match(/stimulus\s+"((?:[^"\\]|\\.)*)"/);
      if (!template || !stimulus) continue;
      // A template that is nothing but the blank, next to a stimulus carrying
      // LaTeX, is the anti-pattern: the equation was left in the prompt.
      if (template[1].trim() === "{{response}}" && /\\\\?\(/.test(stimulus[1])) {
        offences.push(`${f}: formula is in the stimulus — ${stimulus[1].slice(0, 60)}`);
      }
    }
  }
  expect(offences, offences.join("\n")).toEqual([]);
});

// The compiler catches a single-backslash LaTeX command only when the command
// starts with t, n or r — those leave a control character behind as evidence.
// `\frac` and `\sqrt` survive a single backslash intact, so post-parse they are
// indistinguishable from the correct form and no compiler check can see them.
// Only the source can, which is this guard's job: the generator writes from
// these files, and an example using single backslashes teaches a habit that
// breaks the first time an expression needs `\times`.
test("every LaTeX backslash in a spec program is doubled", () => {
  const offences: string[] = [];
  for (const f of ["spec/spec.md", "spec/instructions.md"]) {
    for (const b of blocks(f)) {
      // Annotated counter-examples are prose showing a mistake, not programs.
      if (/←/.test(b)) continue;
      for (const m of b.matchAll(/\\+/g)) {
        const next = b[m.index! + m[0].length] ?? "";
        // An odd run before a letter or a delimiter is a single escape.
        if (m[0].length % 2 === 1 && /[A-Za-z()[\]{}]/.test(next)) {
          const at = b.slice(Math.max(0, m.index! - 30), m.index! + 20).replace(/\n/g, " ");
          offences.push(`${f}: single backslash before "${next}" — …${at}…`);
        }
      }
    }
  }
  expect(offences, offences.join("\n")).toEqual([]);
});

// examples.md is the RAG prompt corpus. Its numbering had drifted: two numbers
// were used twice, the category ranges in the headings no longer matched their
// contents, a cross-reference pointed at the wrong examples, and the header
// still claimed 100 prompts when there were 170. None of that breaks a build,
// which is exactly why it rotted.
describe("the RAG example corpus is coherently numbered", () => {
  const text = () => readFileSync("spec/examples.md", "utf-8");

  const parse = () => {
    const examples: { n: number; category: number | null }[] = [];
    const categories: { c: number; lo: number; hi: number }[] = [];
    let current: number | null = null;
    for (const line of text().split("\n")) {
      const h = /^## Category (\d+): .*\((\d+)–(\d+)\)$/.exec(line);
      if (h) {
        current = Number(h[1]);
        categories.push({ c: current, lo: Number(h[2]), hi: Number(h[3]) });
        continue;
      }
      const m = /^(\d+)\. /.exec(line);
      if (m) examples.push({ n: Number(m[1]), category: current });
    }
    return { examples, categories };
  };

  test("examples run 1..N with no duplicate or missing number", () => {
    const { examples } = parse();
    expect(examples.map((e) => e.n))
      .toEqual(Array.from({ length: examples.length }, (_, i) => i + 1));
  });

  test("each category heading's range matches what it contains", () => {
    const { examples, categories } = parse();
    for (const { c, lo, hi } of categories) {
      const mine = examples.filter((e) => e.category === c).map((e) => e.n);
      expect(mine.length, `Category ${c} has no examples`).toBeGreaterThan(0);
      expect([mine[0], mine[mine.length - 1]], `Category ${c} heading range`)
        .toEqual([lo, hi]);
    }
  });

  // A bounds check is not enough: the range that broke last time was still
  // within 1..N, just pointing at the wrong prompts. What the preamble asserts
  // is a claim about content — "Examples A–B highlight whole sentences" — so
  // check the claim, not the arithmetic.
  test("a range that claims what its examples do is telling the truth", () => {
    const body = new Map<number, string>();
    for (const line of text().split("\n")) {
      const m = /^(\d+)\. (.*)$/.exec(line);
      if (m) body.set(Number(m[1]), m[2].toLowerCase());
    }
    // The prose wraps, so a claim can straddle a line break. Flatten first —
    // without this the guard silently checked only the claims that happened to
    // fit on one line.
    const flat = text().replace(/\s+/g, " ");
    const claims = [...flat.matchAll(/Examples (\d+)–(\d+) highlight whole (\w+?)s\b/g)];
    expect(claims.length, "no 'Examples A–B highlight whole X' claims found")
      .toBeGreaterThan(0);
    for (const [, lo, hi, noun] of claims) {
      for (let n = Number(lo); n <= Number(hi); n++) {
        expect(body.get(n), `example ${n} should be about a whole ${noun}`)
          .toContain(noun);
      }
    }
  });

  test("the stated prompt count matches the number of prompts", () => {
    const { examples } = parse();
    const stated = /^(\d+) example prompts/m.exec(text());
    expect(stated, "no '<N> example prompts' line in the header").toBeTruthy();
    expect(Number(stated![1])).toBe(examples.length);
  });

  // Every en-dash range outside a category heading, not just the ones written
  // with an "Examples" prefix. A renumbering once remapped the prefixed half of
  // "Examples 149–151 ...; 152–154 ..." and left the bare half pointing at the
  // wrong prompts, because nothing was looking for it.
  test("cross-references point at examples that exist", () => {
    const { examples } = parse();
    const max = examples.length;
    for (const line of text().split("\n")) {
      if (/^## Category /.test(line)) continue;
      for (const m of line.matchAll(/(\d+)–(\d+)/g)) {
        const [lo, hi] = [Number(m[1]), Number(m[2])];
        expect(lo, `${m[0]} in: ${line.trim().slice(0, 60)}`).toBeLessThanOrEqual(max);
        expect(hi, `${m[0]} in: ${line.trim().slice(0, 60)}`).toBeLessThanOrEqual(max);
        expect(lo, m[0]).toBeLessThan(hi);
      }
    }
  });
});

// 65 of the language's 153 words — 42% of the vocabulary — were accepted by the
// compiler and documented nowhere. The generator writes from spec/, so a word it
// has never seen is a word it will never emit: the attribute existed, worked,
// and was unreachable in practice. spec.md now carries a reference table
// generated from the registries by tools/gen-attribute-reference.mjs.
test("every attribute the compiler accepts appears in the spec's reference", async () => {
  const { memberFields } = await import("./question-types.js");
  const spec = readFileSync("spec/spec.md", "utf-8");
  const names = new Set(Object.keys(memberFields));
  const missing: string[] = [];
  for (const [word, entry] of Object.entries(lexicon as Record<string, any>)) {
    if (!names.has(entry?.name)) continue;
    // Its own heading, so it has a contents entry and an anchor. A row in a
    // table left 150 words with no link from the contents and no description.
    if (!new RegExp(`^#### ${word.replace(/[-]/g, "\\-")}$`, "m").test(spec)) missing.push(word);
  }
  expect(missing,
    `${missing.length} words are in the lexicon but not in spec.md — regenerate with ` +
    `\`node tools/gen-attribute-reference.mjs\`:\n  ${missing.join(", ")}`,
  ).toEqual([]);
});

// The coverage test above runs compiler -> spec: every word the compiler accepts
// must be documented. Nothing ran the other way, so spec.md could document a word
// the language does not have — and did: a `passage` row survived in the
// hand-written attribute table long after token-highlight moved to `template` +
// `tokenization`, and the Functions table still called `items` arity 1. Neither is
// reachable by the fragment guards, because a table row is not a program.
//
// Scope is deliberately the keyword *tables*. Prose mentions and Learnosity field
// names are also written in backticks, so scanning every code span here would be
// all false positives; a keyword used in a fenced program is already covered by
// the parse guard, which rejects an undefined reference outright.
describe("spec.md's keyword tables agree with the lexicon", () => {
  const cells = (line: string) => line.split("|").slice(1, -1).map((c) => c.trim());
  const isRule = (line: string) => /^\|[\s:|-]*\|$/.test(line);
  // A table is a run of consecutive `|` lines: header, separator, then rows.
  const tables = () => {
    const out: { header: string[]; rows: string[][] }[] = [];
    let cur: string[] | null = null;
    const flush = () => {
      if (cur && cur.length > 2) {
        out.push({ header: cells(cur[0]), rows: cur.slice(2).map(cells) });
      }
      cur = null;
    };
    for (const l of readFileSync("spec/spec.md", "utf-8").split("\n")) {
      if (l.startsWith("|")) (cur ??= []).push(l);
      else flush();
    }
    flush();
    return out.filter((t) => !t.rows.some(isRule as any));
  };
  // Only tables whose first column holds a language keyword. The scoring table's
  // first column is a Learnosity `scoring-type` *value* ("exactMatch"), not a word.
  const keywordTables = () =>
    tables().filter((t) => ["function", "keyword"].includes(t.header[0]?.toLowerCase()));
  // gen-attribute-reference.mjs writes `—` when a registry field has no word.
  const keywordOf = (cell: string) => {
    const m = /^`([^`]+)`$/.exec(cell);
    return m && m[1] !== "—" ? m[1] : null;
  };

  // Without this the whole describe goes quietly vacuous the first time someone
  // restructures the markdown: no tables matched, nothing checked, still green.
  test("the table scan finds the keyword tables it is meant to check", () => {
    expect(keywordTables().map((t) => t.rows.length)).toHaveLength(3);
  });

  test("every keyword a table documents is in the lexicon", () => {
    const unknown: string[] = [];
    for (const t of keywordTables()) {
      for (const row of t.rows) {
        const word = keywordOf(row[0] ?? "");
        if (word && !(word in (lexicon as Record<string, unknown>))) {
          unknown.push(`${word} (in the "${t.header.join(" | ")}" table)`);
        }
      }
    }
    expect(unknown,
      `${unknown.length} keywords are documented in spec.md but absent from the lexicon. ` +
      `The generator writes from spec/, so it will emit them and the compile will fail:\n  ` +
      unknown.join("\n  "),
    ).toEqual([]);
  });

  test("every arity a table states matches the lexicon", () => {
    const wrong: string[] = [];
    for (const t of keywordTables()) {
      if (t.header[1]?.toLowerCase() !== "arity") continue;
      for (const row of t.rows) {
        const word = keywordOf(row[0] ?? "");
        const entry = word ? (lexicon as Record<string, any>)[word] : undefined;
        if (!entry) continue;
        if (String(entry.arity) !== row[1]) {
          wrong.push(`${word}: spec.md says ${row[1]}, lexicon says ${entry.arity}`);
        }
      }
    }
    expect(wrong, wrong.join("\n  ")).toEqual([]);
  });
});
