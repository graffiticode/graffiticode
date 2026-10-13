// SPDX-License-Identifier: MIT
/**
 * Docs must compile.
 *
 * This is not a documentation nit. The code generator writes from instructions.md and
 * retrieves from examples.md, so a wrong example is reproduced verbatim into generated
 * programs — and unlike a wrong sentence, it is learned. L0166 had four `params` examples in
 * its spec.md that never parsed, unquoted keys and comma separators, and they sat there until
 * L0179 was ported from them.
 *
 * Read paths are relative, so these run with packages/core as the cwd (`npm run -w
 * packages/core test`), which is what the workspace script does.
 */
import { test, describe, expect } from "vitest";
import { readFileSync } from "fs";
import { parser } from "@graffiticode/parser";
import { lexicon as base } from "@graffiticode/l0000";
import { attributeFields, compiler, lexicon, validAttributes, wordOf } from "./index.js";

/** Files whose fenced blocks are programs. examples.md holds prompts and is checked separately. */
const SPEC_FILES = ["spec/spec.md", "spec/instructions.md"];

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

/**
 * A fenced block that is a program, rather than a table row or a fragment.
 *
 * Recognized by the terminator, not by a list of opening words. The list version read
 * `/^(choice|item)\[/` and was never widened, so from the day hottext landed until this was
 * found, every hottext, text-entry and extended-text example in the spec was silently skipped —
 * fourteen of thirty-one blocks, never compiled and never validated against the schema. A gate
 * that quietly stops covering things is worse than no gate. Every L0180 program ends in `..`, and
 * that cannot go stale when an interaction is added.
 */
const isProgram = (src: string): boolean => !!src && src.trim().endsWith("..");

async function compileSrc(src: string) {
  const code: any = await parser.parse(180, src, lexicon);
  const err: any = Object.values(code).find((n: any) => n && n.tag === "ERROR");
  if (err) throw new Error(`parse error: ${JSON.stringify(err.elts)}`);
  return await new Promise((res, rej) =>
    compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) rej(errs);
      else res(v);
    }),
  );
}

describe("spec programs", () => {
  test("no fenced block is silently skipped", () => {
    // The companion to isProgram: if a block is added that is NOT a program — compiled output,
    // say — this fails and asks for a deliberate decision, rather than letting the block drop
    // out of coverage the way three interactions' worth once did.
    const skipped: string[] = [];
    for (const f of SPEC_FILES) {
      for (const b of blocks(f)) {
        const src = b.trim();
        if (src && !isProgram(src)) skipped.push(`${f}: ${src.split("\n")[0]}`);
      }
    }
    expect(skipped, "fenced blocks not checked as programs").toEqual([]);
  });

  test("every program fragment in spec/ compiles, not merely parses", async () => {
    // Parsing is not enough: a program can parse perfectly and fail in the builder, which is
    // exactly how a stale example survives behind a parse-only guard.
    const bad: string[] = [];
    let ok = 0;
    for (const f of SPEC_FILES) {
      for (const b of blocks(f)) {
        const src = b.trim();
        if (!isProgram(src)) continue;
        try {
          await compileSrc(src.endsWith("..") ? src : `${src}..`);
          ok++;
        } catch (e: any) {
          const first = Array.isArray(e) ? e[0] : e;
          const msg = String(first?.message ?? first);
          bad.push(`\n--- ${f}\n${src.split("\n").slice(0, 4).join("\n")}\n  -> ${msg.slice(0, 200)}`);
        }
      }
    }
    expect(bad.join("")).toBe("");
    expect(ok).toBeGreaterThan(25);
  });

  test("the starter template compiles and produces a scoreable item", async () => {
    const val: any = await compileSrc(readFileSync("spec/template.gc", "utf-8"));
    expect(val.interaction.type).toBe("choice");
    expect(val.validation.points).toBeGreaterThan(0);
  });
});

describe("spec and lexicon agree", () => {
  /** Words in a `| \`word\` | \`<sig>\` | description |` table row. */
  function documentedWords(path: string): string[] {
    const out = new Set<string>();
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const m = line.match(/^\|\s*`([a-z-]+)`\s*\|\s*`(<[^`]*>)`\s*\|/);
      if (m) out.add(m[1]);
    }
    return [...out];
  }

  // The base language documents its own vocabulary; ours is whatever L0180 added on top of it.
  // Derived rather than listed, so adding a word cannot silently escape the documentation gate.
  const dialect = Object.keys(lexicon).filter((w) => !(w in base));

  test("every word documented in spec/ exists in the lexicon", () => {
    for (const f of SPEC_FILES) {
      for (const w of documentedWords(f)) {
        expect(lexicon[w], `${f} documents \`${w}\`, which is not in the lexicon`).toBeDefined();
      }
    }
  });

  test("every L0180 word is documented in instructions.md", () => {
    const documented = documentedWords("spec/instructions.md");
    const undocumented = dialect.filter((w) => !documented.includes(w));
    expect(undocumented, `in the lexicon but undocumented: ${undocumented.join(", ")}`).toEqual([]);
  });

  test("the signature in the docs matches the one in the lexicon", () => {
    for (const f of SPEC_FILES) {
      for (const line of readFileSync(f, "utf-8").split("\n")) {
        const m = line.match(/^\|\s*`([a-z-]+)`\s*\|\s*`(<[^`]*>)`\s*\|/);
        if (!m || !lexicon[m[1]]) continue;
        expect(lexicon[m[1]].type, `${f}: \`${m[1]}\` signature drift`).toBe(m[2]);
      }
    }
  });
});

describe("schema.json describes what the compiler actually emits", () => {
  // schema.json is served to agents and to the console as the contract for compiled output.
  // Nothing checked it against reality until an item shipped whose `parts` carried an `id`
  // the schema's own choice definition forbade — the prose was right and the schema was not.
  // Ajv 2020 is required: the schema is draft 2020-12, and the hoisted ajv 6 cannot read it.
  const schema = JSON.parse(readFileSync("spec/schema.json", "utf-8"));

  async function validator() {
    const { default: Ajv } = await import("ajv/dist/2020.js");
    return new Ajv({ strict: false, allErrors: true }).compile(schema);
  }

  test("every fenced spec program's compiled output validates", async () => {
    const validate = await validator();
    const bad: string[] = [];
    let checked = 0;
    for (const f of SPEC_FILES) {
      for (const b of blocks(f)) {
        const src = b.trim();
        if (!isProgram(src)) continue;
        const val = await compileSrc(src.endsWith("..") ? src : `${src}..`);
        checked++;
        if (!validate(val)) {
          bad.push(`\n--- ${f}\n${src.split("\n")[0]}\n  -> ${JSON.stringify(validate.errors?.slice(0, 3))}`);
        }
      }
    }
    expect(bad.join("")).toBe("");
    expect(checked).toBeGreaterThan(25);
  });

  test("both interaction shapes and a response validate", async () => {
    const validate = await validator();
    const cases: Record<string, string> = {
      "unscored poll": `choice [ options [ [ text "a" ] [ text "b" ] ] {} ]`,
      "penalty": `choice [ options [ [ text "a" assess [ correct ] ] [ text "b" assess [ points -1 ] ] ] {} ]`,
      "additive item": `item [ parts [ choice [ options [ [ text "a" assess [ correct ] ] ] {} ] ] {} ]`,
      "conjunctive item with a stimulus": `item [ stimulus [ title "T" paragraphs [ "One." ] ] scoring "conjunctive" parts [ choice [ options [ [ text "a" assess [ correct ] ] ] {} ] choice [ options [ [ text "b" assess [ correct ] ] ] {} ] ] {} ]`,
    };
    for (const [label, src] of Object.entries(cases)) {
      const val: any = await compileSrc(`${src}..`);
      expect(validate(val), `${label}: ${JSON.stringify(validate.errors?.slice(0, 2))}`).toBe(true);
    }
    // A response rides alongside, in both of its shapes.
    const bare: any = await compileSrc(`choice [ options [ [ text "a" assess [ correct ] ] ] {} ]..`);
    expect(validate({ ...bare, response: ["A"] })).toBe(true);
    const item: any = await compileSrc(
      `item [ parts [ choice [ options [ [ text "a" assess [ correct ] ] ] {} ] ] {} ]..`,
    );
    expect(validate({ ...item, response: { "1": ["A"] } })).toBe(true);
  });
});

describe("the container tables match validAttributes", () => {
  // The generator reads these tables to decide where a word goes; the compiler rejects on
  // validAttributes. If they disagree, the docs teach a program the compiler refuses.
  test("instructions.md lists exactly the words each container accepts", () => {
    const text = readFileSync("spec/instructions.md", "utf-8");
    // Scoped to its own section — the Functions table above has identically shaped rows.
    const section = text.split(/^## Which words each container takes$/m)[1]?.split(/^## /m)[0];
    expect(section, "instructions.md is missing the container-table section").toBeTruthy();
    for (const [container, allowed] of Object.entries(validAttributes)) {
      const row = section!.match(
        new RegExp(`^\\|\\s*(?:\`${container}\`|an ${container})\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, "m"),
      );
      expect(row, `no container row for \`${container}\``).toBeTruthy();
      const documented = row![1].split(",").map((s) => s.trim()).sort();
      expect(documented, `\`${container}\` row disagrees with validAttributes`).toEqual(
        [...allowed].sort(),
      );
    }
  });
});

describe("examples.md numbering is coherent", () => {
  const text = readFileSync("spec/examples.md", "utf-8");
  const lines = text.split("\n");
  const numbered = lines
    .map((l) => l.match(/^(\d+)\.\s+\S/))
    .filter(Boolean)
    .map((m) => Number(m![1]));
  const headers = lines
    .map((l) => l.match(/^##\s+Category\s+(\d+):\s+.*\((\d+)[–-](\d+)\)\s*$/))
    .filter(Boolean)
    .map((m) => ({ n: Number(m![1]), from: Number(m![2]), to: Number(m![3]) }));

  test("prompts run 1..N with no gaps or repeats", () => {
    expect(numbered.length).toBeGreaterThan(0);
    expect(numbered).toEqual(Array.from({ length: numbered.length }, (_, i) => i + 1));
  });

  test("categories are numbered in order and their ranges tile the whole list", () => {
    expect(headers.map((h) => h.n)).toEqual(headers.map((_, i) => i + 1));
    expect(headers[0].from).toBe(1);
    expect(headers[headers.length - 1].to).toBe(numbered.length);
    for (let i = 1; i < headers.length; i++) {
      expect(headers[i].from, `category ${headers[i].n} does not follow ${headers[i - 1].n}`).toBe(
        headers[i - 1].to + 1,
      );
    }
  });

  test("the count stated in the preamble is the count actually present", () => {
    const stated = text.match(/^(\d+) example prompts/m);
    expect(stated, "examples.md should open with 'N example prompts'").toBeTruthy();
    expect(Number(stated![1])).toBe(numbered.length);
  });
});

describe("scope.json and language-info.json know which interactions exist", () => {
  // scope.json was for a long time the one spec file nothing tested, and it drifted: its
  // out_of_scope still ruled out multi-part items months after the `item` wrapper shipped.
  // These two files are what an agent reads to decide whether a request routes here at all,
  // so a stale one does not merely misinform — it sends the work somewhere else.
  //
  // The interaction set is derived, never listed: the dialect's own container words are the
  // lexicon minus L0000's minus the generated attribute words, and an interaction is an
  // arity-1 container. `item` is arity 1 too, and is a wrapper rather than an interaction.
  const attributeWords = new Set(Object.keys(attributeFields).map(wordOf));
  const containers = Object.keys(lexicon).filter((w) => !(w in base) && !attributeWords.has(w));
  const interactions = containers.filter((w) => lexicon[w].arity === 1 && w !== "item").sort();

  const scope = JSON.parse(readFileSync("spec/scope.json", "utf-8"));
  const info = JSON.parse(readFileSync("spec/language-info.json", "utf-8"));

  test("the interaction set is what these tests think it is", () => {
    // A canary on the derivation itself. If a future container is arity 2, or `item` gains a
    // sibling wrapper, the rest of this block would quietly check the wrong set.
    expect(interactions.length).toBeGreaterThan(3);
    expect(interactions).toContain("choice");
    expect(containers).toContain("item");
  });

  test("scope.json's out_of_scope names exactly the interactions that do not exist", () => {
    const entry = scope.out_of_scope.find((s: string) => s.includes("not implemented yet"));
    expect(entry, "no out_of_scope entry names the unimplemented interaction types").toBeTruthy();
    const m = entry.match(/^Interaction types other than (.+?) - (.+?) are not implemented yet/);
    expect(m, `cannot read the interaction entry: ${entry}`).toBeTruthy();
    const listed = (s: string) => s.split(/,|\band\b/).map((w) => w.trim()).filter(Boolean).sort();

    expect(listed(m![1]), "scope.json disagrees with the lexicon about what exists").toEqual(
      interactions,
    );
    for (const w of listed(m![2])) {
      expect(lexicon[w], `scope.json calls \`${w}\` unimplemented, but it is in the lexicon`)
        .toBeUndefined();
    }
  });

  test("language-info.json's supported_item_types is the interaction set plus the wrapper", () => {
    expect([...info.supported_item_types].sort()).toEqual([...interactions, "item"].sort());
  });

  test("every example prompt produces something the language supports", () => {
    for (const ex of info.example_prompts) {
      expect(info.supported_item_types, `example produces \`${ex.produces}\``).toContain(
        ex.produces,
      );
    }
  });

  test("both spec files claim the same dialect", () => {
    expect(scope.id).toBe(info.id);
    expect(scope.id).toBe("0180");
  });
});
