// SPDX-License-Identifier: MIT
// Guards the L0178 PROMPTS — spec/spec-directive.md and spec/instructions.md.
//
// For an oracle dialect the prompts are the deliverable, more so than the compiler, and
// a prompt rule is exactly the kind of thing that gets quietly dropped in an edit. Every
// rule asserted here is load-bearing: it either encodes a documented Data API fact the
// recipe gets wrong without it, or it stops L0177's reasoning being imported wholesale
// into a dialect where it does not apply.
//
// WHAT THIS TEST DOES NOT DO: it pins the prompt TEXT, not the generated output. A
// passing run says the rules are still written down. It does not say the generator
// obeyed them.
//
// Match on whitespace-normalized substrings, never exact lines — Prettier reformats
// spec/*.md and would otherwise break these on a reflow. Markdown emphasis (backticks,
// asterisks) is stripped from BOTH sides for the same reason: whether a rule writes
// `meta.records` or meta.records is a formatting choice, and a guard that breaks when
// someone adds emphasis trains people to delete the guard.
import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { ARITY1, BLOCKS, PROPERTIES, PAGING_TAGS } from "./vocab.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const specDir = join(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const norm = (s: string) => s.replace(/[`*]/g, "").replace(/\s+/g, " ");
const directive = norm(readFileSync(join(specDir, "spec-directive.md"), "utf-8"));
const instructions = norm(readFileSync(join(specDir, "instructions.md"), "utf-8"));
const register = norm(readFileSync(join(specDir, "conflict-resolution.md"), "utf-8"));
const has = (hay: string, needle: string) => hay.toLowerCase().includes(norm(needle).toLowerCase());

describe("the directive keeps paging as its own section", () => {
  test("paging is a required top-level section, not folded into the procedure", () => {
    expect(has(directive, "## Paging")).toBe(true);
    expect(has(directive, "Never fold it into the Procedure")).toBe(true);
  });

  test("it states that meta.records counts the page, not the total", () => {
    // The single most important sentence in the recipe. A reader who takes records as a
    // total has a number that looks like an answer and is not one.
    expect(has(directive, "meta.records counts the page, not the total")).toBe(true);
    expect(has(instructions, "counts the CURRENT PAGE, not the total match set")).toBe(true);
  });

  test("termination is PER-ENDPOINT, read from paging_end — never a universal rule", () => {
    // The rule each family needs is a bug in the other: waiting for meta.next to vanish
    // never terminates on sessions/*, and stopping on a short page loses data on
    // itembank/*. A directive that stated either as general would ship a broken loop.
    expect(has(directive, "There is no universal paging loop")).toBe(true);
    expect(has(directive, "Read paging_end from the compiled output")).toBe(true);
    expect(has(directive, "Never carry a paging rule from one endpoint to another")).toBe(true);
    expect(has(directive, "stopping when data.length < limit")).toBe(true);
  });

  test("both end-of-data signals are spelled out with the reason each is needed", () => {
    expect(has(directive, "next-absent")).toBe(true);
    expect(has(directive, "empty-page")).toBe(true);
    expect(has(directive, "never terminates")).toBe(true);
    expect(has(directive, "long-poll resumption cursor")).toBe(true);
    expect(has(instructions, "HOW A LOOP TERMINATES IS NOT THE SAME ACROSS ENDPOINTS")).toBe(true);
  });

  test("it carries the measured clamp, which is what makes a size-based loop fail", () => {
    // limit 100 -> 50 records, HTTP 200, no error. Every page then looks short while
    // meta.next is present throughout, so "stop on a short page" drops the rest.
    expect(has(directive, "silently clamped")).toBe(true);
    expect(has(directive, "quits after one page and discards the rest")).toBe(true);
  });

  test("it requires the original request parameters to be carried between pages", () => {
    expect(has(directive, "the original request parameters plus the new")).toBe(true);
  });

  test("the completeness check asserts on the RIGHT end signal, not on records arriving", () => {
    expect(has(directive, "Records came back")).toBe(true);
    expect(has(directive, "the final response carried no")).toBe(true);
    // Asserting on the cursor would never pass on an empty-page endpoint.
    expect(has(directive, "assert the final response carried zero records")).toBe(true);
  });

  test("it says a paging check needs a result set larger than limit to mean anything", () => {
    expect(has(directive, "genuinely larger than")).toBe(true);
  });
});

describe("the directive gives destructive operations their own section", () => {
  test("Destructive is required, and comes before the Procedure", () => {
    expect(has(directive, "## Destructive operations")).toBe(true);
    expect(has(directive, "destructive: true")).toBe(true);
    expect(has(directive, "BEFORE the Procedure")).toBe(true);
  });

  test("it says there is nothing to verify afterwards", () => {
    expect(has(directive, "cannot be undone")).toBe(true);
    expect(has(directive, "verification-after-the-fact does not exist")).toBe(true);
  });

  test("it names the one-entry scope and refuses the bulk-cleanup reading", () => {
    // The cap is the API's own signal about intent; a recipe that loops around it is
    // defeating a deliberate constraint.
    expect(has(directive, "ONE session per request")).toBe(true);
    expect(has(directive, "right-to-be-forgotten")).toBe(true);
    expect(has(directive, "rather than emitting a loop that calls it repeatedly")).toBe(true);
  });

  test("it refuses to reuse the scratch-bank advice, which implies a safety net", () => {
    expect(has(directive, "implies a safety net that is not there")).toBe(true);
  });
});

describe("the directive gives writes their own section", () => {
  test("Write safety is a required section when the job writes", () => {
    expect(has(directive, "## Write safety")).toBe(true);
    expect(has(directive, "writes: true")).toBe(true);
    expect(has(directive, "Never fold it into the Procedure")).toBe(true);
  });

  test("semantics come from write_semantics, never inferred from the verb", () => {
    // The same endpoint replaces under `set` and merges under `update`, documented
    // identically. Seven other update blocks are untested, so "update merges" is a rule
    // the recipe would be inventing.
    expect(has(directive, "Read write_semantics from the compiled output")).toBe(true);
    expect(has(directive, "never infer it from the verb")).toBe(true);
    expect(has(directive, "is inventing a rule")).toBe(true);
    expect(has(register, "C19")).toBe(true);
  });

  test("a merging write says it does not generalise", () => {
    expect(has(directive, "say it does not generalise")).toBe(true);
  });

  test("it leads with REPLACE semantics and names the loop that loses data", () => {
    // The single worst write hazard: read-modify-write silently clears every field not
    // resent, and the response cannot warn you because it echoes nothing.
    expect(has(directive, "set REPLACES")).toBe(true);
    expect(has(directive, "is CLEARED, not left alone")).toBe(true);
    expect(has(directive, "destroys every field not resent")).toBe(true);
    expect(has(instructions, "A field left out of the payload is cleared")).toBe(true);
  });

  test("it says the response proves nothing and requires a re-read", () => {
    expect(has(directive, "data: []")).toBe(true);
    expect(has(directive, "Confirmation is a re-read")).toBe(true);
  });

  test("it states the unpublished default and its consequence", () => {
    expect(has(directive, "it becomes `unpublished`")).toBe(true);
    expect(has(directive, "cannot be delivered")).toBe(true);
  });

  test("first runs are directed at a scratch bank", () => {
    expect(has(directive, "scratch bank")).toBe(true);
  });

  test("definition is handed off rather than described", () => {
    // It carries item content this dialect does not model. Inventing its shape is the
    // failure mode; L0176 composes it.
    expect(has(directive, "do not attempt to describe or invent its shape")).toBe(true);
  });

  test("the untested batch maximum is marked untested", () => {
    expect(has(directive, "Batch maximum is 50 entries. Documented; **untested**")).toBe(true);
  });
});

describe("the directive gives async its own section", () => {
  test("Polling is a required section, and never emitted alongside Paging", () => {
    expect(has(directive, "## Polling")).toBe(true);
    expect(has(directive, "never emit a Paging section for the same job")).toBe(true);
  });

  test("it reads the channel from poll_with rather than hard-coding jobs", () => {
    expect(has(directive, "Read poll_with from the compiled output")).toBe(true);
  });

  test("it takes the reference location from poll_with, never generalising", () => {
    // Both envelope shapes are REAL — offlinepackage returns an array, activities/duplicate
    // an object, each matching its own docs. A recipe that states one shape as general
    // breaks on the next async endpoint with no error, just an undefined reference.
    expect(has(directive, "take it from poll_with.job_reference_at")).toBe(true);
    expect(has(directive, "never generalise")).toBe(true);
    expect(has(directive, "both forms are real")).toBe(true);
    expect(has(instructions, "poll_with")).toBe(true);
  });

  test("it tells the reader to OMIT status, against the documentation", () => {
    // Measured: the documented Default: ["completed"] is not applied, and mirroring it
    // filters out the in-flight job — zero records, read as "no such job".
    expect(has(directive, "OMIT `status` when polling")).toBe(true);
    expect(has(directive, "following the documentation is the bug")).toBe(true);
    expect(has(directive, "Default: [\"completed\"]")).toBe(true);
  });

  test("it terminates on a terminal status, not on records appearing", () => {
    expect(has(directive, "completed` or `halted")).toBe(true);
    expect(has(directive, "not on records appearing")).toBe(true);
  });

  test("the measured async facts carry their own consumer as provenance", () => {
    // These came from a PRIVATE consumer on sandbox 386, not the demo bank the paging
    // facts came from. A fact verified on one bank is not a promise about another.
    expect(has(directive, "sandbox Item bank 386")).toBe(true);
    expect(has(directive, "a different consumer from the demo-bank facts")).toBe(true);
  });

  test("the untested jobs-paging gap is marked untested, not asserted", () => {
    expect(has(directive, "Untested")).toBe(true);
  });
});

describe("the directive refuses L0177's differential apparatus", () => {
  test("it names the differential rule and says not to import it", () => {
    expect(has(directive, "never on a differential")).toBe(true);
    expect(has(directive, "tests nothing here")).toBe(true);
  });

  test("it states the positive rule — read the envelope — with no sibling dialect named", () => {
    // Stated as a property of THIS API. A contrast against another dialect is knowledge
    // about a product the reader never asked about, and the code generator, whose RAG rows
    // are language-scoped, has no exposure to the pattern being warned off.
    expect(has(directive, "Errors are reported, not swallowed")).toBe(true);
    expect(has(directive, "reading meta.status")).toBe(true);
  });
});

describe("transport rules that are binary", () => {
  test("the URL is versioned, and a bare host is stated to be invalid", () => {
    expect(has(directive, "The URL is VERSIONED")).toBe(true);
    expect(has(directive, "a bare host is not a valid Data API endpoint")).toBe(true);
  });

  test("every call is a POST, and the directive says why a reader gets this wrong", () => {
    expect(has(directive, "Every call is a POST")).toBe(true);
    expect(has(directive, "maps `get` onto HTTP GET")).toBe(true);
  });

  test("signing is SDK-only and the signature covers the serialized request", () => {
    expect(has(directive, "never hand-roll")).toBe(true);
    expect(has(directive, "do not re-serialize or reorder keys after signing")).toBe(true);
  });
});

describe("the envelope and its traps", () => {
  test("meta.status is called out as separate from the HTTP status", () => {
    expect(has(directive, "meta.status` is separate from the HTTP status")).toBe(true);
    expect(has(directive, "separate from the HTTP status")).toBe(true);
  });

  test("a truncated read is named as indistinguishable from a complete one", () => {
    expect(has(directive, "truncated read looks exactly like a complete one")).toBe(true);
  });

  test("41003's own error message is flagged as misleading for this API", () => {
    // Measured: a bad secret returns 403/41003 whose message tells you to compare
    // security.domain with the browser's location.hostname. There is no browser here.
    expect(has(directive, "its message is misleading here")).toBe(true);
    expect(has(directive, "There is no browser in a Data API call")).toBe(true);
  });

  test("not every response is JSON, and the directive says so", () => {
    expect(has(directive, "Not every response is JSON")).toBe(true);
    expect(has(directive, "body is NOT JSON")).toBe(true);
  });

  test("the HTTP-scheme mistake is described by what actually happens", () => {
    // Measured: plain http:// gets a 301, and a POST that follows it loses its body, so
    // the API reports 41000 "Missing security parameters" about a packet that is fine.
    // The documented 403 never occurs. Naming the wrong code would send a reader off to
    // audit their signing.
    expect(has(directive, "does not happen")).toBe(true);
    expect(has(directive, "301")).toBe(true);
    expect(has(directive, "often means the URL was `http://`")).toBe(true);
    expect(has(directive, "conflict-resolution.md")).toBe(true);
    expect(has(register, "C5 — HTTP-not-HTTPS response code · RESOLVED")).toBe(true);
  });

  test("no conflict is left silently open — the register says which are", () => {
    // The register's own contract is that an unresolved conflict stays unresolved IN
    // WRITING. This asserts the table and the entries agree: every row marked OPEN must
    // have a matching entry heading, so a status can't be quietly downgraded in one place.
    //
    // Read the RAW file, not the normalized one: `norm` collapses newlines, so a
    // line-anchored pattern would run across the whole document and match on any stray
    // "OPEN" in prose. It did exactly that once C20 described a fail-OPEN behaviour.
    const raw = readFileSync(
      fileURLToPath(new URL("../spec/conflict-resolution.md", import.meta.url)), "utf-8",
    );
    const rowsOpen = [...raw.matchAll(/^\| (C\d+) \|([^|]*)\|([^|]*)\|/gm)]
      .filter(m => /\bOPEN\b/.test(m[3])).map(m => m[1]);
    const headingsOpen = [...raw.matchAll(/^### (C\d+) —.*$/gm)]
      .filter(m => /\bOPEN\b/.test(m[0])).map(m => m[1]);
    expect(rowsOpen.sort()).toEqual(headingsOpen.sort());
  });

  test("every register entry has both a table row and an entry heading", () => {
    // The failure this catches is an entry added to one and not the other — which is how
    // a conflict ends up recorded nowhere a reader will look.
    const raw = readFileSync(
      fileURLToPath(new URL("../spec/conflict-resolution.md", import.meta.url)), "utf-8",
    );
    const rows = [...raw.matchAll(/^\| (C\d+) \|/gm)].map(m => m[1]);
    const headings = [...raw.matchAll(/^### (C\d+) —/gm)].map(m => m[1]);
    expect(rows).toEqual(headings);
  });

  test("include is described per endpoint, including how it fails", () => {
    // The only fail-open behaviour found in this API, and it sits under a field name a
    // developer would assume behaves uniformly.
    expect(has(directive, "does not mean one thing, and it does not fail one way")).toBe(true);
    expect(has(directive, "SILENTLY IGNORED")).toBe(true);
    expect(has(directive, "a typo is invisible")).toBe(true);
  });

  test("the tag read/write shape mismatch is stated", () => {
    expect(has(directive, "Tags go in and come out in different shapes")).toBe(true);
    expect(has(directive, "has to transpose first")).toBe(true);
  });

  test("rate limits are per endpoint over a 5-second window", () => {
    expect(has(directive, "per endpoint, over a 5-second window")).toBe(true);
    expect(has(directive, "Limits are per individual endpoint")).toBe(true);
  });
});

describe("paths and naming", () => {
  test("paths come from the compiled map and must be reproduced verbatim", () => {
    expect(has(directive, "must REPRODUCE that map")).toBe(true);
    expect(has(directive, "Never derive a path from a key name")).toBe(true);
  });

  test("it gives the ambiguity that makes derivation unsafe", () => {
    expect(has(directive, "include-items` is `include.items")).toBe(true);
    expect(has(directive, "item-pool-id` is `item_pool_id")).toBe(true);
  });

  test("a key absent from the map was rejected and must be left out", () => {
    expect(has(directive, "was rejected by the compiler: leave it out entirely")).toBe(true);
  });

  test("the wire uses the endpoint and action, never the block keyword", () => {
    expect(has(directive, "not the block keyword")).toBe(true);
  });
});

describe("facts that stop a wrong recipe", () => {
  test("read-vs-write is never inferred from the action verb", () => {
    expect(has(directive, "Never infer read-vs-write from the action verb")).toBe(true);
    expect(has(directive, "does not tell you whether an operation writes")).toBe(true);
  });

  test("an async job gets a polling loop, not a paging loop", () => {
    expect(has(directive, "Write the polling loop instead of a paging loop")).toBe(true);
    expect(has(directive, "Paging and async are disjoint")).toBe(true);
  });

  test("`next` is a cursor, never authored", () => {
    expect(has(directive, "never a value to author")).toBe(true);
  });
});

describe("honesty about evidence", () => {
  test("the evidence convention distinguishes verified from documented", () => {
    expect(has(directive, "[verified]")).toBe(true);
    expect(has(directive, "[documented]")).toBe(true);
    expect(has(directive, "exercised END TO END")).toBe(true);
  });

  test("verified facts carry their provenance", () => {
    expect(has(directive, "public demo")).toBe(true);
    expect(has(directive, "learnosity-sdk-nodejs")).toBe(true);
  });

  test("a demo-bank verification is not overstated as a promise to the reader", () => {
    expect(has(directive, "verified for the DEMO ITEM BANK")).toBe(true);
    expect(has(directive, "never let a fact verified on the demo bank read as a promise")).toBe(true);
  });

  test("the 'no holes, nothing left to do' trap is closed", () => {
    // A design with no holes can still be operationally blocked; L0177 learned this.
    expect(has(directive, 'Never write "no holes, nothing left to do."')).toBe(true);
    expect(has(directive, "still unverified before this can work")).toBe(true);
  });

  test("a step that cannot fail is not a check", () => {
    expect(has(directive, "A step that cannot fail is not a check")).toBe(true);
  });
});

describe("the conflict register", () => {
  test("it refuses to resolve a conflict by picking the tidier answer", () => {
    expect(has(register, "An unresolved conflict stays unresolved in writing")).toBe(true);
    expect(has(register, "a resolution records what settled it")).toBe(true);
  });

  test("the two cross-dialect conflicts with L0177 are recorded, not smoothed over", () => {
    // domain means different things in each API, and L0177's differential discipline
    // does not transfer. Resolving either "consistently" would have been the bug.
    expect(has(register, "domain means different things per API")).toBe(true);
    expect(has(register, "Whether verification must be differential")).toBe(true);
    expect(has(register, "the wrong resolution would have looked like consistency")).toBe(true);
  });

  test("measured facts are scoped to what was actually exercised", () => {
    expect(has(register, "public demo Item bank")).toBe(true);
    expect(has(register, "It does not say the reader's consumer")).toBe(true);
  });
});

describe("output hygiene", () => {
  test("no runnable host-language code, and no mention of the dialect itself", () => {
    expect(has(directive, "Do NOT emit runnable host-language code")).toBe(true);
    expect(has(directive, "Do NOT mention Graffiticode")).toBe(true);
  });

  test("the recipe covers only the operation the design asked for", () => {
    expect(has(directive, "do not cover operations the design did not ask for")).toBe(true);
  });
});

/**
 * instructions.md is the CODE GENERATOR's prompt, and vocab.ts is the definitive vocabulary —
 * lexicon.ts derives lexicon.json from it, so a word that exists there and not in the instructions
 * is a word the generator will never emit correctly.
 *
 * This dialect shipped for a while with instructions.md containing ZERO of its own vocabulary: no
 * `data-job`, no `items-get`, 14KB of excellent Data API documentation and nothing about the
 * language to write it in. The generator did the only thing available and invented a plausible
 * DSL from the concepts it had been taught — `let request = { endpoint: "itembank/items", action:
 * tag get, params: {...} }` — which parsed as base-language nonsense and failed every corpus
 * prompt. The reasoning inside those programs was correct; there was simply nowhere to put it.
 *
 * So: every entry vocab.ts exports must appear in the instructions, and no vocabulary table may
 * claim a keyword the lexicon does not define. Adding a property without documenting it now fails
 * here rather than in generation.
 */
describe("instructions.md documents the whole vocabulary", () => {
  const instructions = readFileSync(
    fileURLToPath(new URL("../spec/instructions.md", import.meta.url)), "utf-8",
  );
  const all = [...ARITY1, ...Object.keys(BLOCKS), ...PROPERTIES, ...Object.keys(PAGING_TAGS)];

  test("every lexicon keyword appears", () => {
    const missing = all.filter(k => !new RegExp(`\\b${k.replace(/-/g, "\\-")}\\b`).test(instructions));
    expect(missing).toEqual([]);
  });

  test("no table row invents a keyword", () => {
    const claimed = [...instructions.matchAll(/^\| `([a-z][a-z-]+)`/gm)].map(m => m[1]);
    expect([...new Set(claimed)].filter(c => !all.includes(c))).toEqual([]);
  });

  test("the canonical program shape is shown, not just described", () => {
    expect(instructions).toContain("data-job\n  paging EXHAUSTIVE\n  items-get [");
    // The shape the generator invented when it had nothing to copy.
    expect(instructions).toContain("there is no field that names an endpoint");
  });
});

/**
 * Enumerated values are quoted STRINGS; only the paging policy is a bare TAG. vocab.ts types them
 * as `{ type: "string", values: [...] }`, and lexicon.ts registers TAG tokens only for PAGING_TAGS.
 *
 * The first vocabulary tables rendered both alike — `sort` listed as `asc` `desc` in backticks —
 * and the generator reasonably wrote `sort desc`, which is an undefined reference. Three of sixteen
 * corpus programs failed that way in one batch (`desc`, `per-dichotomous`, `reference`). A table
 * that shows a value without showing its FORM is a table that teaches the wrong form.
 */
describe("instructions.md shows the form of enumerated values", () => {
  const instructions = readFileSync(
    fileURLToPath(new URL("../spec/instructions.md", import.meta.url)), "utf-8",
  ).replace(/\s+/g, " ");

  test("the bare-vs-quoted rule is stated", () => {
    expect(instructions).toContain("Only `EXHAUSTIVE` and `SINGLE-PAGE` are bare TAG tokens");
    expect(instructions).toContain("EVERY other enumerated value is a QUOTED STRING");
  });

  test("every value-constrained field shows quotes in its table row", () => {
    for (const v of ['`"asc"`', '`"desc"`', '`"per-dichotomous"`', '`"title"`', '`["published"]`']) {
      expect(instructions).toContain(v);
    }
  });

  /**
   * The rule above was already stated and correct when an EXAMPLE below it still wrote
   * `sort desc` / `sort-field created` bare — a program that cannot compile, sitting in the
   * section the generator pattern-matches hardest. Stating a rule and demonstrating its
   * violation is worse than saying nothing: the demonstration wins.
   */
  test("no fenced example writes an enumerated value bare", () => {
    const raw = readFileSync(
      fileURLToPath(new URL("../spec/instructions.md", import.meta.url)), "utf-8",
    );
    // Value-constrained fields are declared per block as [path, type, { values }].
    const valued = Object.values(BLOCKS).flatMap((b: any) =>
      Object.entries(b.fields)
        .filter(([, f]: [string, any]) => f[1] === "string" && Array.isArray(f[2]?.values))
        .map(([name]) => name));
    expect(valued.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const fence of raw.match(/```[\s\S]*?```/g) || []) {
      for (const line of fence.split("\n")) {
        const m = line.match(/^\s*([a-z][a-z0-9-]*)\s+(\S+)/);
        // A value-constrained field followed by anything that is not a quote or a `[` list.
        if (m && valued.includes(m[1]) && !/^["[]/.test(m[2])) offenders.push(line.trim());
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * examples.md is the RAG corpus source: its prompts are run through the generator and the
 * PROGRAMS they yield are the corpus. So a block with no prompt contributes nothing to
 * training, and the corpus quietly teaches a fraction of the vocabulary.
 *
 * That is exactly what happened — the tag blocks, the sessions submissions and all eight
 * updates landed while examples.md was updated only for the delete, leaving 6 of 18 blocks
 * represented. Nothing caught it because nothing was looking. This looks.
 */
describe("the served catalog lists every block", () => {
  // language-info.json is what get_language_info and the console read, so a block missing
  // here is a block the outside world does not know exists. It fell 12 behind while
  // examples.md and spec.md were guarded and this was not — the same drift, in the file
  // that matters most for discovery.
  const info = JSON.parse(readFileSync(
    fileURLToPath(new URL("../spec/language-info.json", import.meta.url)), "utf-8"));
  const scope = JSON.parse(readFileSync(
    fileURLToPath(new URL("../spec/scope.json", import.meta.url)), "utf-8"));

  test("supported_item_types is exactly the registry", () => {
    expect([...info.supported_item_types].sort()).toEqual(Object.keys(BLOCKS).sort());
  });

  test("both status strings state the real block count", () => {
    const n = Object.keys(BLOCKS).length;
    for (const [name, status] of [["language-info", info.status], ["scope", scope.status]]) {
      const m = String(status).match(/(\d+) of 57/);
      expect(m, `${name}.status should say "N of 57"`).toBeTruthy();
      expect(Number(m![1]), `${name}.status block count`).toBe(n);
    }
  });
});

describe("spec.md indexes every block", () => {
  const spec = readFileSync(
    fileURLToPath(new URL("../spec/spec.md", import.meta.url)), "utf-8",
  );

  test("every block appears in the index", () => {
    // spec.md is the served vocabulary spec (spec-md renders it to spec.html). It fell to
    // 5 of 18 while blocks were being added, because nothing checked.
    expect(Object.keys(BLOCKS).filter((b) => !spec.includes(b))).toEqual([]);
  });

  test("it does not duplicate the per-block field tables", () => {
    // Field detail lives in instructions.md only. Two statements of one fact age
    // independently, and a stale copy of a long table would be believed.
    expect(spec).toContain("documented per block in `instructions.md`, not here");
  });
});

describe("examples.md covers the whole vocabulary", () => {
  const examples = readFileSync(
    fileURLToPath(new URL("../spec/examples.md", import.meta.url)), "utf-8",
  );

  test("every block is named in the corpus", () => {
    const missing = Object.keys(BLOCKS).filter((b) => !examples.includes(b));
    expect(missing).toEqual([]);
  });

  test("the header does not claim a block count it cannot back", () => {
    // "all N blocks" in the preamble goes stale silently; tie it to the registry. Prefer a
    // NUMERAL in the doc: the spelled-out map below runs out, and a guard that fails on
    // "thirty" teaches people to delete the guard rather than fix the count.
    const m = examples.match(/all (\w+) blocks/);
    expect(m, "examples.md should say how much surface it covers").toBeTruthy();
    const words: Record<string, number> = {
      two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
      seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    };
    expect(words[m![1]] ?? Number(m![1])).toBe(Object.keys(BLOCKS).length);
  });
});

/**
 * L0178 is atomic. It has no `composesWith` entry in the console catalog, but that fence is
 * only applied to PLANNER-proposed chains: the reactive path reads `data use "<lang>"` out of
 * the generated program itself and honours it unfenced. So a generator that emits `data use
 * "0176"` gets a composition regardless — which is exactly what happened, and it failed with
 * "Upstream L0176 failed to produce a taskId".
 *
 * The instructions are therefore the only place this can be prevented, and the sentence that
 * caused it ("content is composed in L0176") reads as a destination unless it is disarmed.
 */
describe("the dialect tells the generator it is atomic", () => {
  test("emitting `data use` is forbidden in as many words", () => {
    expect(has(instructions, "A program is ATOMIC")).toBe(true);
    expect(has(instructions, 'NEVER emit `data use "<lang>"`')).toBe(true);
    expect(has(instructions, "A program containing `data use` is malformed")).toBe(true);
  });

  test("the L0176 mentions are marked as scope, not as an upstream to call", () => {
    // Both places the dialect names L0176 must say it is a boundary, not a destination.
    expect(has(instructions, "it tells you what NOT to put in the recipe, not somewhere to go and get it")).toBe(true);
    expect(has(instructions, 'never emit `data use "0176"`')).toBe(true);
  });
});
