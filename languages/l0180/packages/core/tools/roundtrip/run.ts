// SPDX-License-Identifier: MIT
/**
 * The L0175 → L0180 round trip, end to end.
 *
 *   npx tsx packages/core/tools/roundtrip/run.ts fixtures   # recompile the L0175 side
 *   npx tsx packages/core/tools/roundtrip/run.ts prompts    # what to hand the generator
 *   npx tsx packages/core/tools/roundtrip/run.ts report     # score both sides and compare
 *
 * The three steps are separate because only the middle one needs the platform. `fixtures` runs
 * against the sibling repo, `report` runs against files, and the generation between them is
 * whatever produced `generated/<example>.gc` — `create_item("0180", …)` over MCP, the console,
 * or a person. Committing the generated programs is what makes a regression legible: the diff
 * shows what the generator did differently, next to what it now scores.
 *
 * The prompt is composed from L0175's COMPILED item rather than from `get_spec`. That is
 * deliberate and it is the one place this departs from the design note. L0175 has no
 * `spec-directive.md`, so `get_spec` describes its unparsed claims-and-evidence source — the
 * superset, with the distractor pool and no answer key — and a round trip through it measures
 * that gap rather than this repo's fidelity. Composing from the compiled item isolates the
 * question L0180 can actually answer: given a faithful description of a delivered item, does
 * the generated program score it the way L0175 says. The other path is worth measuring too,
 * and it is measured on the L0175 side, where the fix lives.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import {
  EXAMPLES,
  FIXTURES,
  compileL0180,
  fixturePath,
  generatedPath,
  loadFixture,
  manifestPath,
  loadSource,
} from "./examples.js";
import { readSourceItem, type SourceItem } from "./source.js";
import { compare, type Report } from "./compare.js";
import { compileExample } from "./l0175.js";

/* ------------------------------------------------------------------------- the prompt */

/**
 * The delivered item in English, with nothing L0175-specific left in it.
 *
 * It states the answer key, because a description that leaves the generator to infer which
 * option is right is not a faithful hand-off — it is a second authoring task, and a wrong guess
 * would read here as a scoring failure. Everything else about the shape (how many parts, what
 * is clicked, how it scores) is stated too, for the same reason.
 */
export function promptFor(src: SourceItem, compiled: any): string {
  const lines: string[] = [];
  const passage = compiled?.passage;
  if (passage?.lines?.length) {
    lines.push(
      `Use this passage, titled "${passage.heading}", with one paragraph per line:`,
      ...passage.lines.map((l: any) => `  ${l.id}. ${l.text}`),
      "",
    );
  }
  src.stems.forEach((s, i) => lines.push(src.stems.length > 1 ? `Part ${"AB"[i]}: ${s}` : s));
  lines.push("");

  src.parts.forEach((p) => {
    const label = src.parts.length > 1 ? `Part ${p.label} options` : "Options";
    lines.push(`${label}:`);
    for (const o of p.options) lines.push(`  - ${o.text}${o.correct ? "   [correct]" : ""}`);
    lines.push("");
  });

  if (src.handScored) {
    lines.push(
      "This is a written response. Nobody scores it in the browser: hold it for a person to mark",
      "against this rubric.",
      ...(compiled?.rubric ?? []).map((b: any) => `  ${b.score}: ${b.descriptor}`),
    );
  } else {
    lines.push(
      `Scoring: ${src.scoring} The item is worth ${src.points} point in total, all or nothing —`,
      "a partly correct response earns zero.",
    );
    if (src.type === "hot-text") {
      lines.push("The candidate clicks sentences in the passage itself rather than picking from a list.");
    }
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- reporting */

function render(name: string, r: Report): boolean {
  const head = `${r.ok ? "PASS" : "FAIL"}  ${name}  (${r.type})`;
  console.log(head);
  console.log(`      aligned ${r.aligned.matched}/${r.aligned.total} options · ${r.scoring}`);
  for (const p of r.problems) console.log(`      ! ${p}`);
  for (const c of r.cases) {
    if (c.ok) continue;
    const e = c.expected;
    console.log(
      `      ✗ ${c.name}: expected ${e.points}${e.pending ? " (pending)" : ""}` +
        `${e.correct ? " correct" : ""}, got ${c.actual.points}/${c.actual.maxPoints}` +
        `${c.actual.pending ? " (pending)" : ""}${c.actual.correct ? " correct" : ""}`,
    );
  }
  return r.ok;
}

async function main() {
  const cmd = process.argv[2] || "report";

  if (cmd === "fixtures") {
    mkdirSync(FIXTURES, { recursive: true });
    for (const name of EXAMPLES) {
      const compiled = await compileExample(name);
      writeFileSync(fixturePath(name), `${JSON.stringify(compiled, null, 2)}\n`);
      console.log(`wrote ${name}.l0175.json  (${compiled.type})`);
    }
    return;
  }

  if (cmd === "prompts") {
    for (const name of EXAMPLES) {
      const compiled = loadFixture(name);
      console.log(`\n===== ${name} =====\n`);
      console.log(promptFor(readSourceItem(compiled), compiled));
    }
    return;
  }

  if (cmd !== "report") {
    console.error(`unknown command ${cmd} — expected fixtures, prompts or report`);
    process.exit(2);
  }

  const manifest = existsSync(manifestPath())
    ? JSON.parse(readFileSync(manifestPath(), "utf-8"))?.items ?? {}
    : {};

  let failures = 0;
  let missing = 0;
  for (const name of EXAMPLES) {
    // A request the platform routed elsewhere never reached L0180, so nothing here can score
    // it. It is still a failure of the hand-off, and naming it as one is the point — a report
    // that said "does not compile" would send someone looking in the compiler.
    const lang = manifest[name]?.language;
    if (lang && lang !== "L0180") {
      console.log(
        `ROUTED  ${name}  — the platform sent this request to ${lang}, so no L0180 program exists`,
      );
      failures++;
      continue;
    }
    if (!existsSync(generatedPath(name))) {
      console.log(`SKIP  ${name}  — no generated program; run \`prompts\` and generate one`);
      missing++;
      continue;
    }
    const source = loadSource(name);
    let compiled: any;
    try {
      compiled = await compileL0180(readFileSync(generatedPath(name), "utf-8"));
    } catch (e: any) {
      console.log(`FAIL  ${name}  (${source.type})\n      ! the generated program does not compile: ${e?.message ?? e}`);
      failures++;
      continue;
    }
    if (!render(name, compare(source, compiled))) failures++;
  }

  const scored = EXAMPLES.length - missing;
  console.log(
    `\n${scored - failures}/${scored} round trips score identically` +
      (missing ? `, ${missing} not generated` : ""),
  );
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`roundtrip: ${e?.message ?? e}`);
  process.exit(1);
});
