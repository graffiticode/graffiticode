// SPDX-License-Identifier: MIT
/**
 * Docs must compile.
 *
 * This is not a documentation nit. The code generator writes from instructions.md and
 * retrieves from examples.md, so a wrong example is reproduced verbatim into generated
 * programs — and unlike a wrong sentence, it is learned.
 *
 * Read paths are relative (spec/ and data/), so these run with packages/core as the cwd (`npm run -w
 * packages/core test`), which is what the workspace script does.
 */
import { test, describe, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import Ajv from "ajv/dist/2020.js";
import { parser } from "@graffiticode/parser";
import { lexicon as base } from "@graffiticode/l0000";
import { itemTypes } from "./attributes.js";
import { compiler, lexicon, loadSurvey, validAttributes } from "./index.js";

// Documented programs run against the REAL surveys in data/, with no stub anywhere. A program
// here is exactly what the generator will write, and what it names has to exist — an example
// naming a survey nobody installed, or an option no version of it holds, is a program that fails
// for every user who copies it.
//
// That is why documented ANSWERS use a survey with a single version: a survey with several
// draws one at random, so a selection written here would match only sometimes.

/** Files whose fenced blocks are programs. examples.md holds prompts and is checked separately. */
const SPEC_FILES = ["spec/spec.md", "spec/instructions.md", "spec/usage-guide.md"];

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
 * A fenced block that is a program, rather than a table row or a JSON sample.
 *
 * Recognized by the terminator, not by a list of opening words: a list of openers goes stale
 * the moment the vocabulary changes, and a gate that quietly stops covering things is worse
 * than no gate. Every L0182 program ends in `..`.
 */
const isProgram = (src: string): boolean => !!src && src.trim().endsWith("..");

async function compileSrc(src: string, itemId = "docs") {
  // Public values are folded in at parse time, exactly as the console does it, so a documented
  // `session-id get-val-public "itemId"` reaches the compiler as a value.
  const code: any = await parser.parse(182, src, lexicon, {
    GET_VAL_PUBLIC: (name: string) => (name === "itemId" ? itemId : ""),
  });
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
    // Every block is either a program, a JSON sample, or a table/plain fragment. This asserts
    // the classifier still recognizes the programs, so a formatting change cannot quietly
    // empty the suite below.
    for (const f of SPEC_FILES) {
      const all = blocks(f);
      expect(all.length, `${f} has no fenced blocks`).toBeGreaterThan(0);
      const programs = all.filter(isProgram);
      expect(programs.length, `${f} has no programs`).toBeGreaterThan(0);
    }
  });

  test("every program fragment in spec/ compiles, not merely parses", async () => {
    for (const f of SPEC_FILES) {
      for (const src of blocks(f).filter(isProgram)) {
        await expect(compileSrc(src), `${f}:\n${src}`).resolves.toBeTruthy();
      }
    }
  });

  test("the starter template carries the session, which is what holds an answer to its survey", () => {
    // A program that omits it draws again on the turn that answers, and the answer is then
    // checked against options its taker never saw.
    expect(readFileSync("spec/template.gc", "utf-8")).toContain(
      'session-id get-val-public "itemId"',
    );
  });

  test("the starter template shows the WHOLE shape, survey and response", async () => {
    // It is what the generator starts from, so a template that stops at the survey teaches half
    // the language — and the half it leaves out is the one a client always has to produce.
    const out: any = await compileSrc(readFileSync("spec/template.gc", "utf-8"));
    expect(out.survey.options.length).toBeGreaterThan(1);
    expect(out.response.choices.length).toBeGreaterThan(0);
    expect(out.response.writeIn).toBeTruthy();
  });

  test("the starter template leaves the choice bounds to their defaults", () => {
    // Pinning them taught the generator to always write them, and the numbers it copied were
    // not even the defaults.
    const src = readFileSync("spec/template.gc", "utf-8");
    expect(src).not.toMatch(/min-choices|max-choices/);
  });

  test("the starter template names its options by text, not by id or position", async () => {
    // The options live in the survey, so whoever writes the response has not seen an id or a
    // position. Copying a positional selection out of here is exactly the mistake that shipped.
    const src = readFileSync("spec/template.gc", "utf-8");
    const selection = src.match(/choices \[([^\]]*)\]/)?.[1] ?? "";
    expect(selection.trim()).toBeTruthy();
    expect(selection).not.toMatch(/\d/);
  });
});

describe("spec and lexicon agree", () => {
  /** Words in a `| \`word\` | \`<sig>\` | … |` table row. */
  function documentedWords(path: string): string[] {
    const out = new Set<string>();
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const m = line.match(/^\|\s*`([a-z-]+)`\s*\|\s*`(<[^`]*>)`\s*\|/);
      if (m) out.add(m[1]);
    }
    return [...out];
  }

  // The base language documents its own vocabulary; ours is whatever L0182 added on top of it.
  // Derived rather than listed, so adding a word cannot silently escape the documentation gate.
  const dialect = Object.keys(lexicon).filter((w) => !(w in base));

  test("every word documented in spec/ exists in the lexicon", () => {
    for (const f of SPEC_FILES) {
      for (const w of documentedWords(f)) {
        expect(lexicon[w], `${f} documents \`${w}\`, which is not in the lexicon`).toBeDefined();
      }
    }
  });

  test("every L0182 word is documented in instructions.md", () => {
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
  // Validated against REAL compiled output, so `additionalProperties: false` catches a field
  // the compiler emits and the schema never learned about.
  const schema = JSON.parse(readFileSync("spec/schema.json", "utf-8"));
  const ajv = new (Ajv as any)({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);

  const check = (out: any, where: string) => {
    const ok = validate(out);
    expect(ok, `${where}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  };

  test("every fenced spec program's compiled output validates", async () => {
    for (const f of SPEC_FILES) {
      for (const src of blocks(f).filter(isProgram)) {
        check(await compileSrc(src), `${f}:\n${src}`);
      }
    }
  });

  test("a survey with a full response validates", async () => {
    const out: any = await compileSrc(
      `survey [ id "team-retro-1" session-id get-val-public "itemId"
         response [ choices ["t3" "cut the build time in half"] write-in "a new one" ] ]..`,
    );
    expect(out.response).toEqual({ choices: ["t3", "t2"], writeIn: "a new one" });
    expect(out.survey.sessionId).toBe("docs");
    check(out, "a full response");
  });

  test("a survey awaiting a response validates", async () => {
    const out: any = await compileSrc(`survey [ id "team-retro-1" ]..`);
    expect(out.response).toBeUndefined();
    check(out, "no response");
  });

  test("a rating survey with a full response validates", async () => {
    const out: any = await compileSrc(
      `survey [ id "course-feedback" session-id get-val-public "itemId"
         response [
           ratings [
             [item "The course met its stated goals" rating "Agree"]
             [item "The pace of the course was right for me" rating "Not applicable"]
             [item "The course materials were clear" rating 5]
             [item "Feedback on my work was timely and useful" rating "Disagree"]
             [item "The lab sessions helped me apply what I learned" rating "Strongly agree"]
             [item "Using the course portal was" rating "very easy"]
             [item "How likely are you to recommend this course to a colleague?" rating 9]
           ]
           comment "More worked examples, please."
         ] ]..`,
    );
    expect(out.response.ratings[1]).toEqual({ item: "pace", optOut: true });
    expect(out.response.ratings[5]).toEqual({ item: "portal", value: 7 });
    check(out, "a full rating response");
  });

  test("every installed survey validates awaiting a response", async () => {
    for (const f of readdirSync("data")) {
      const instance = f.replace(/\.json$/, "");
      check(await compileSrc(`survey [ id "${instance}" ]..`), instance);
    }
  });

  test("rejects output the compiler could not have produced", async () => {
    const out: any = await compileSrc(`survey [ id "team-retro-1" ]..`);
    out.survey.nonsense = true;
    expect(validate(out), "additionalProperties:false is not doing its job").toBe(false);
  });
});

describe("the container tables match validAttributes", () => {
  // The generator reads this table to decide where a word goes; the compiler rejects on
  // validAttributes. If they disagree, the docs teach a program the compiler refuses.
  test("instructions.md lists exactly the words each container accepts", () => {
    const text = readFileSync("spec/instructions.md", "utf-8");
    // Scoped to its own section — the tables above have identically shaped rows.
    const section = text.split(/^## Which words each container takes$/m)[1]?.split(/^## /m)[0];
    expect(section, "instructions.md is missing the container-table section").toBeTruthy();
    for (const [container, allowed] of Object.entries(validAttributes)) {
      const row = section!.match(
        new RegExp(`^\\|\\s*\`${container}\`\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, "m"),
      );
      expect(row, `no container row for \`${container}\``).toBeTruthy();
      const documented = row![1]
        .split(",")
        .map((s) => s.trim())
        .sort();
      expect(documented, `\`${container}\` row disagrees with validAttributes`).toEqual(
        [...allowed].sort(),
      );
    }
  });
});

describe("the surveys installed in data/", () => {
  // These are what `id "…"` reaches, so each one has to be a survey L0182 actually accepts —
  // compiled here as a program, the same way a taker reaches it. A file that stops being a
  // valid set fails the build rather than somebody's first prompt.
  //
  // They vary on purpose: both styles; options and items as records with ids and as bare strings;
  // every form a scale can take. That spread is the point; a corpus of one shape teaches the
  // generator one shape.
  const files = readdirSync("data").sort();
  const instances = files.map((f) => f.replace(/\.json$/, ""));

  /** The whole file. Every survey is one JSON envelope — see "every survey says what it is". */
  const envelope = (f: string): any => JSON.parse(readFileSync(join("data", f), "utf-8"));
  /** What a response answers: a ranked-choice survey's options, or a rating survey's items. */
  const read = (f: string): any[] => {
    const parsed = envelope(f);
    return parsed.style === "rating" ? parsed.items : parsed.options;
  };
  const ranked = files.filter((f) => envelope(f).style === "ranked-choice");
  const rating = files.filter((f) => envelope(f).style === "rating");

  test("every file is a version of some survey", () => {
    // `<id>-<n>` is the whole naming rule, and a file outside it is invisible to `id "…"` —
    // installed, never reachable, and silent about it.
    expect(files.length).toBeGreaterThan(3);
    for (const f of files)
      expect(f, `${f} is not <survey-id>-<n>.json`).toMatch(/^[a-z0-9][a-z0-9-]*-\d+\.json$/);
  });

  test("at least one survey has several versions, which is what the draw is for", async () => {
    const byId = new Map<string, number>();
    for (const i of instances) {
      const id = i.replace(/-\d+$/, "");
      byId.set(id, (byId.get(id) || 0) + 1);
    }
    expect(
      [...byId.values()].some((n) => n > 1),
      "no survey has more than one version",
    ).toBe(true);
  });

  test("the shapes vary, because a corpus of one shape teaches one shape", () => {
    const sets = ranked.map(read);
    expect(
      sets.some((set) => typeof set[0] === "string"),
      "no bare-string set",
    ).toBe(true);
    expect(
      sets.some((set) => typeof set[0] === "object" && set[0].id),
      "no set carrying the originating service's ids",
    ).toBe(true);
  });

  test("every survey declares its style, and both styles are installed", () => {
    for (const f of files) expect(["ranked-choice", "rating"], f).toContain(envelope(f).style);
    expect(ranked.length, "no ranked-choice survey").toBeGreaterThan(2);
    expect(rating.length, "no rating survey").toBeGreaterThan(2);
  });

  test("the rating surveys cover every form a scale can take", () => {
    // The generator learns the shapes it is shown. A corpus with no numeric range, no anchors or
    // no opt-out teaches a language without them.
    const scales = rating.flatMap((f) => {
      const env = envelope(f);
      const named = Object.values(env.scales || {});
      const inline = env.items.map((x: any) => (typeof x === "object" ? x.scale : undefined));
      return [...named, env.scale, ...inline].filter((x) => x !== undefined);
    });
    const has = (pred: (s: any) => boolean) => scales.some(pred);
    expect(
      has((s) => s === "agreement-5" || s?.preset === "agreement-5"),
      "no agreement scale",
    ).toBe(true);
    expect(
      has((s) => s === "nps"),
      "no NPS item",
    ).toBe(true);
    expect(
      has((s) => s === "stars-5"),
      "no star rating",
    ).toBe(true);
    expect(
      has((s) => s?.min !== undefined),
      "no numeric range",
    ).toBe(true);
    expect(
      has((s) => Array.isArray(s?.points)),
      "no hand-labelled points",
    ).toBe(true);
    expect(
      has((s) => s?.optOut !== undefined),
      "no opt-out",
    ).toBe(true);
    const items = rating.flatMap((f) => envelope(f).items);
    expect(
      items.some((x: any) => x.anchors),
      "no semantic differential",
    ).toBe(true);
    expect(
      items.some((x: any) => typeof x === "string"),
      "no bare-string items",
    ).toBe(true);
    expect(
      items.some((x: any) => x.required === false),
      "no optional item",
    ).toBe(true);
    expect(
      rating.some((f) => envelope(f).comment),
      "no survey asking for a comment",
    ).toBe(true);
  });

  test("a survey that means to bound a response says so in its own data", () => {
    // Bounds are the survey's, not the program's — there is no word for them — so a survey that
    // wants anything but the defaults has to carry them here.
    const bounded = ranked.filter((f) => {
      const env = envelope(f);
      return env.minChoices !== undefined || env.maxChoices !== undefined;
    });
    expect(bounded.length, "no survey sets its own bounds").toBeGreaterThan(2);
  });

  for (const instance of instances) {
    test(`${instance} is a survey L0182 accepts`, async () => {
      const file = files.find((f) => f.startsWith(`${instance}.`))!;
      const set = read(file);
      expect(set.length, `${file} holds nothing to answer`).toBeGreaterThan(1);
      // Named outright, so this reads the file under test rather than drawing a sibling.
      const out: any = await compileSrc(`survey [ id "${instance}" ]..`);
      expect(out.survey.instance).toBe(instance);
      expect(out.survey.options ?? out.survey.items).toHaveLength(set.length);
    });
  }

  test("a survey id reaches one of its versions", async () => {
    const loaded = await loadSurvey("civic-priorities", {});
    expect(instances).toContain(loaded.instance);
  });

  // The words a participant reads are part of the survey, not an afterthought: a program that
  // names a survey and says nothing else must still produce a page with a heading and an
  // explanation. A JSON survey that lost its envelope would silently go back to a bare list.
  test("every survey says what it is, in its own file", () => {
    // A survey is not just a list: whoever takes it arrives cold, and the words they read are
    // the survey's own. A file that lost its envelope would render a page with no heading.
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const env = envelope(f);
      expect(Array.isArray(env), `${f} is a bare list, not an envelope`).toBe(false);
      expect(typeof env.title, `${f} has no title`).toBe("string");
      expect(env.title.trim().length, `${f} has an empty title`).toBeGreaterThan(0);
      expect(typeof env.instructions, `${f} has no instructions`).toBe("string");
      expect(env.instructions.trim().length, `${f} has empty instructions`).toBeGreaterThan(20);
    }
  });

  test("every survey the docs name is installed", () => {
    // A documented id that nobody installed is a program that fails for whoever copies it.
    const docs = [
      readFileSync("spec/instructions.md", "utf-8"),
      readFileSync("spec/spec.md", "utf-8"),
      readFileSync("spec/examples.md", "utf-8"),
      readFileSync("spec/usage-guide.md", "utf-8"),
      readFileSync("spec/template.gc", "utf-8"),
    ].join("\n");
    const ids = new Set<string>();
    for (const m of docs.matchAll(/\bid "([a-z0-9][a-z0-9-]*)"/g)) ids.add(m[1]);
    expect(ids.size, "the docs name no survey at all").toBeGreaterThan(1);
    for (const id of ids) {
      const exists = instances.some((i) => i === id || i.replace(/-\d+$/, "") === id);
      expect(exists, `the docs name \`${id}\`, which is not installed in data/`).toBe(true);
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

describe("scope.json and language-info.json know which items exist", () => {
  const scope = JSON.parse(readFileSync("spec/scope.json", "utf-8"));
  const info = JSON.parse(readFileSync("spec/language-info.json", "utf-8"));

  test("both files claim the same dialect", () => {
    expect(scope.id).toBe("0182");
    expect(info.id).toBe("0182");
  });

  test("language-info.json's supported_item_types is the container set", () => {
    expect([...info.supported_item_types].sort()).toEqual([...itemTypes].sort());
  });

  test("every container, and the member list, is in the lexicon at arity 1", () => {
    for (const container of Object.keys(validAttributes)) {
      expect(lexicon[container], `\`${container}\` is not in the lexicon`).toBeDefined();
      expect(lexicon[container].arity).toBe(1);
    }
  });

  test("out_of_scope carries the keywords the MCP router extracts", () => {
    // graffiticode-mcp-server's limitSentences() inlines ONLY sentences matching this pattern
    // into the server instructions. A negative clause without one of these words never reaches
    // the router, and L0180 absorbs survey requests.
    const KEYWORDS = /\b(ONLY when|do NOT|does NOT|are not built|not built yet|EARLY|never)\b/;
    const carrying = scope.out_of_scope.filter((s: string) => KEYWORDS.test(s));
    expect(carrying.length, "no out_of_scope sentence would reach the MCP router").toBeGreaterThan(
      2,
    );
  });

  test("out_of_scope disclaims assessment, which is the language it would be confused with", () => {
    const text = scope.out_of_scope.join(" ").toLowerCase();
    expect(text).toContain("l0180");
    expect(text).toMatch(/assessment|quiz/);
  });
});
