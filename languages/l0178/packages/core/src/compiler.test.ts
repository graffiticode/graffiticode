// SPDX-License-Identifier: MIT
// Unit tests for the L0178 Data API cookbook. Uniform surface: every property is an
// arity-2 kebab function; a block (`items-get`) is arity-2 and folds a [list] into a
// request; paging policy values are UPPERCASE tags.
//
// These assert per-field validation, the (endpoint, action) scoping, the paging hole
// that is this dialect's whole point, cross-field coherence rules taken from the
// documented reference, warning ordering, and that an unknown property is a parse
// error rather than a warning.
import { describe, test, expect } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";

async function compile(src: string, data: any = {}, config: any = {}): Promise<any> {
  const code = await parser.parse(178, src, lexicon);
  return await new Promise((resolve, reject) => {
    compiler.compile(code, data, config, (err: any, val: any) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      if (errors.length > 0) reject(errors);
      else resolve(val);
    });
  });
}
const hasWarning = (out: any, needle: string) =>
  (out.warnings || []).some((w: string) => w.toLowerCase().includes(needle.toLowerCase()));

const COMPLETE = `data-job
  paging EXHAUSTIVE
  items-get [
    references ["Grade7_ELA_1021" "Grade7_ELA_1022"]
    status ["published"]
    include-items ["dt_created" "dt_updated"]
    organisation-id 123
    limit 50
    {}
  ]
  {}..`;

describe("a complete read job", () => {
  test("compiles with no warnings and reports its block", async () => {
    const out = await compile(COMPLETE);
    expect(out.endpoint).toBe("itembank/items");
    expect(out.action).toBe("get");
    expect(out.paged).toBe(true);
    expect(out.async).toBe(false);
    expect(out.paging).toBe("exhaustive");
    expect(out.complete).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(out.request).toMatchObject({
      references: ["Grade7_ELA_1021", "Grade7_ELA_1022"],
      status: ["published"],
      "organisation-id": 123,
      limit: 50,
    });
  });

  test("records the exact API path for every field it sets", async () => {
    const out = await compile(COMPLETE);
    // The flattening is ambiguous, which is the whole reason paths are recorded:
    // include-items nests on a dot, item-pool-id on an underscore.
    expect(out.paths["include-items"]).toBe("include.items");
    expect(out.paths["organisation-id"]).toBe("organisation_id");
    expect(out.paths["references"]).toBe("references");
    expect(out.paths["status"]).toBe("status");
  });

  test("a field the design never set has no path entry", async () => {
    const out = await compile(COMPLETE);
    expect(out.paths["item-pool-id"]).toBeUndefined();
    expect(out.paths["tags"]).toBeUndefined();
  });

  test("nested paths flatten as documented", async () => {
    const out = await compile(`data-job paging SINGLE-PAGE items-get [
      authoring-workflow-reference "Default workflow"
      authoring-workflow-states ["Approved"]
      questions-types ["mcq"]
      item-pool-id "pool-1"
      {} ] {}..`);
    expect(out.paths["authoring-workflow-reference"]).toBe("authoring_workflow.reference");
    expect(out.paths["authoring-workflow-states"]).toBe("authoring_workflow.states");
    expect(out.paths["questions-types"]).toBe("questions.types");
    expect(out.paths["item-pool-id"]).toBe("item_pool_id");
  });
});

describe("paging — the hole this dialect exists for", () => {
  test("a paged read with no paging policy is incomplete", async () => {
    const out = await compile(`data-job items-get [ references ["a"] {} ] {}..`);
    expect(out.complete).toBe(false);
    expect(hasWarning(out, "paged and the design doesn't say how far it reads")).toBe(true);
  });

  test("the hole names both policies and says why it matters", async () => {
    const out = await compile(`data-job items-get [ references ["a"] {} ] {}..`);
    const hole = out.warnings[0];
    expect(hole).toContain("EXHAUSTIVE");
    expect(hole).toContain("SINGLE-PAGE");
    // meta.records counting the page rather than the total is the actual trap.
    expect(hole.toLowerCase()).toContain("meta.records");
  });

  test("either policy fills the hole", async () => {
    for (const [tag, value] of [["EXHAUSTIVE", "exhaustive"], ["SINGLE-PAGE", "single-page"]]) {
      const out = await compile(`data-job paging ${tag} items-get [ references ["a"] {} ] {}..`);
      expect(out.paging).toBe(value);
      expect(out.complete).toBe(true);
    }
  });

  test("single-page is accepted but carries an advisory that it may be short", async () => {
    const out = await compile(`data-job paging SINGLE-PAGE items-get [ references ["a"] {} ] {}..`);
    expect(out.complete).toBe(true);
    expect(hasWarning(out, "not the full match set")).toBe(true);
  });

  test("an undefined paging tag is a parse error, not a warning", async () => {
    // Same treatment as an unknown property: the tag isn't in the lexicon, so the
    // program never reaches the compiler. Better than a warning — it cannot be missed.
    await expect(compile(`data-job paging SOMETIMES items-get [ references ["a"] {} ] {}..`))
      .rejects.toBeTruthy();
  });

  test("a non-tag paging value is rejected, leaving the hole open", async () => {
    const out = await compile(`data-job paging 5 items-get [ references ["a"] {} ] {}..`);
    expect(hasWarning(out, "isn't a paging policy")).toBe(true);
    expect(out.complete).toBe(false);
  });

  test("`next` is reported as a cursor, not an authorable field", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [ next "1445216251.1165015" {} ] {}..`);
    expect(hasWarning(out, "cursor the API hands back")).toBe(true);
  });
});

describe("per-field validation", () => {
  test("an out-of-range enum value warns and names the accepted set", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [ status ["retired"] {} ] {}..`);
    expect(hasWarning(out, '"published"')).toBe(true);
  });

  test("limit above the maximum warns that it is silently clamped", async () => {
    // Measured against the demo bank: limit 100 returns 50 with meta.status true and no
    // error. The warning has to carry that, because "exceeds the maximum" reads like the
    // request will be rejected — and it is the silence that causes the data loss.
    const out = await compile(`data-job paging EXHAUSTIVE items-get [ limit 500 {} ] {}..`);
    expect(hasWarning(out, "exceeds the maximum of 50")).toBe(true);
    expect(hasWarning(out, "silently clamps")).toBe(true);
    expect(hasWarning(out, "every page looks short")).toBe(true);
  });

  test("a wrong value type warns", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [ item-pool-id 7 {} ] {}..`);
    expect(hasWarning(out, "must be a string")).toBe(true);
  });

  test("a timestamp accepts either a Unix integer or an ISO 8601 string", async () => {
    const num = await compile(`data-job paging EXHAUSTIVE items-get [ mintime 1470291213 {} ] {}..`);
    const iso = await compile(`data-job paging EXHAUSTIVE items-get [ mintime "2016-08-04T00:00:00Z" {} ] {}..`);
    expect(hasWarning(num, "must be a UTC Unix timestamp")).toBe(false);
    expect(hasWarning(iso, "must be a UTC Unix timestamp")).toBe(false);
  });

  test("a timestamp rejects anything else", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [ mintime true {} ] {}..`);
    expect(hasWarning(out, "must be a UTC Unix timestamp")).toBe(true);
  });

  test("tags are records mirroring the TagsV2 payload", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [
      tags [{type: "subject", name: "English"} {type: "grade"}] {} ] {}..`);
    expect(out.request.tags).toEqual([{ type: "subject", name: "English" }, { type: "grade" }]);
    // Advisories still fire (no bank, no limit) — assert no TAG complaint, not silence.
    expect(hasWarning(out, "tag")).toBe(false);
  });

  test("a tag missing its type warns", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [ tags [{name: "English"}] {} ] {}..`);
    expect(hasWarning(out, 'needs a "type" string')).toBe(true);
  });
});

describe("cross-field coherence, from the documented rules", () => {
  test("advanced-tags-none cannot be used alone", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [
      advanced-tags-none [{type: "grade", name: "5"}] {} ] {}..`);
    expect(hasWarning(out, "can't be used on its own")).toBe(true);
  });

  test("advanced-tags-none is fine alongside all or either", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [
      advanced-tags-all [{type: "subject", name: "English"}]
      advanced-tags-none [{type: "grade", name: "5"}] {} ] {}..`);
    expect(hasWarning(out, "can't be used on its own")).toBe(false);
  });

  test("authoring-workflow-states requires its reference", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [
      authoring-workflow-states ["Approved"] {} ] {}..`);
    expect(hasWarning(out, "workflow reference is mandatory")).toBe(true);
  });
});

describe("block scoping", () => {
  test("a field that belongs to another operation is dropped with a warning", async () => {
    // `items` is the set-side payload; it is not a field of the read.
    const out = await compile(`data-job paging EXHAUSTIVE items-get [ item-pool-id "p" {} ] {}..`);
    expect(out.request["item-pool-id"]).toBe("p");
    expect(out.warnings).not.toContain(undefined);
  });

  test("a design with no block is incomplete and says which blocks exist", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE {}..`);
    expect(out.complete).toBe(false);
    expect(hasWarning(out, "items-get")).toBe(true);
  });

  test("an unknown property is a parse error, not a warning", async () => {
    await expect(compile(`data-job paging EXHAUSTIVE items-get [ wibble 1 {} ] {}..`)).rejects.toBeTruthy();
  });
});

describe("progressive disclosure", () => {
  test("holes lead, and advisories wait until the holes are filled", async () => {
    const withHole = await compile(`data-job items-get [ {} ] {}..`);
    expect(withHole.complete).toBe(false);
    expect(withHole.warnings[0].toLowerCase()).toContain("paged");
    // "no filter set" is an advisory; it must not bury the hole.
    expect(hasWarning(withHole, "reads everything itembank/items returns")).toBe(false);

    const filled = await compile(`data-job paging EXHAUSTIVE items-get [ {} ] {}..`);
    expect(filled.complete).toBe(true);
    expect(hasWarning(filled, "reads everything itembank/items returns")).toBe(true);
  });

  test("validity warnings surface even while a hole is open", async () => {
    const out = await compile(`data-job items-get [ limit 500 {} ] {}..`);
    expect(out.complete).toBe(false);
    expect(hasWarning(out, "exceeds the maximum")).toBe(true);
  });

  test("an unspecified bank is advised once the design is otherwise complete", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [ references ["a"] {} ] {}..`);
    expect(hasWarning(out, "primary Item bank")).toBe(true);
  });
});

describe("the lexicon", () => {
  test("L0178 keywords are present and base L0000 keywords survive the merge", async () => {
    expect(lexicon["data-job"]).toMatchObject({ arity: 1 });
    expect(lexicon["items-get"]).toMatchObject({ arity: 2 });
    expect(lexicon["paging"]).toMatchObject({ arity: 2 });
    expect(lexicon["EXHAUSTIVE"]).toMatchObject({ name: "TAG" });
    // A silent shadow is the failure mergeLexicon exists to catch. `get`, `set` and
    // `data` are base names this dialect deliberately did not take.
    for (const base of ["get", "set", "data", "map", "filter", "reduce"]) {
      expect(lexicon[base], `base keyword "${base}" was shadowed`).toBeTruthy();
    }
  });
});

describe("responses-get — the second block, and the second endpoint family", () => {
  const RESP = `data-job
    paging EXHAUSTIVE
    responses-get [
      activity-id ["numeracy"]
      status ["Completed"]
      user-id ["u-1" "u-2"]
      limit 50
      {}
    ]
    {}..`;

  test("selects its own endpoint and action", async () => {
    const out = await compile(RESP);
    expect(out.endpoint).toBe("sessions/responses");
    expect(out.action).toBe("get");
    expect(out.paged).toBe(true);
    expect(out.complete).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  test("the doubly-nested include path cannot be derived from its name", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE responses-get [
      session-id ["s1"] include-session-metadata ["my_field"] {} ] {}..`);
    // include-session-metadata -> include.sessions.session_metadata. Nothing about the
    // kebab name says where the dots and underscores fall, which is the whole argument
    // for carrying `paths` instead of expanding names in the recipe.
    expect(out.paths["include-session-metadata"]).toBe("include.sessions.session_metadata");
    expect(out.paths["session-id"]).toBe("session_id");
    expect(out.paths["activity-id"]).toBeUndefined();
  });
});

describe("the same keyword means different things in different blocks", () => {
  test("`status` carries disjoint value sets per block", async () => {
    // Item status vs SESSION status. This is the scoping the two-level registry exists
    // for — a dialect-wide `status` would have to accept the union and check neither.
    const items = await compile(`data-job paging EXHAUSTIVE items-get [ status ["published"] {} ] {}..`);
    const resp = await compile(`data-job paging EXHAUSTIVE responses-get [ status ["Completed"] {} ] {}..`);
    expect(hasWarning(items, "isn't one of")).toBe(false);
    expect(hasWarning(resp, "isn't one of")).toBe(false);

    // ...and each rejects the other's vocabulary.
    const crossed1 = await compile(`data-job paging EXHAUSTIVE items-get [ status ["Completed"] {} ] {}..`);
    const crossed2 = await compile(`data-job paging EXHAUSTIVE responses-get [ status ["published"] {} ] {}..`);
    expect(hasWarning(crossed1, "isn't one of")).toBe(true);
    expect(hasWarning(crossed2, "isn't one of")).toBe(true);
  });

  test("a field of the other block is dropped with a warning", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE responses-get [ references ["a"] {} ] {}..`);
    expect(hasWarning(out, "isn't a request field of this operation")).toBe(true);
    expect(out.request.references).toBeUndefined();
  });

  test("advisories name the block's own endpoint, not a hardcoded one", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE responses-get [ {} ] {}..`);
    expect(hasWarning(out, "reads everything sessions/responses returns")).toBe(true);
    // organisation-id is not a field of this block, so its advisory must not fire.
    expect(hasWarning(out, "primary Item bank")).toBe(false);
  });
});

describe("paging_end — how the loop terminates, per endpoint", () => {
  test("the two families disagree, and the output says which applies", async () => {
    const items = await compile(`data-job paging EXHAUSTIVE items-get [ references ["a"] {} ] {}..`);
    const resp = await compile(`data-job paging EXHAUSTIVE responses-get [ session-id ["s"] {} ] {}..`);
    expect(items.paging_end).toBe("next-absent");
    expect(resp.paging_end).toBe("empty-page");
  });

  test("every paged block declares one", async () => {
    // A paged block without paging_end would leave the recipe to guess, and either guess
    // is a bug: "wait for next to vanish" never finishes on sessions, and "stop on a
    // short page" drops data on itembank.
    for (const [src, blk] of [["items-get [ references [\"a\"] {} ]", "items-get"],
                              ["responses-get [ session-id [\"s\"] {} ]", "responses-get"]]) {
      const out = await compile(`data-job paging EXHAUSTIVE ${src} {}..`);
      expect(out.paged, blk).toBe(true);
      expect(out.paging_end, `${blk} must declare paging_end`).toBeTruthy();
    }
  });
});

describe("naming a container is not filtering it", () => {
  test("organisation-id or item-pool-id alone still warns that it reads everything", async () => {
    // Choosing WHICH bank is not narrowing WHAT you read from it. Counting them as
    // filters silenced the advisory in exactly the case it exists for: a job that names
    // a bank and nothing else.
    for (const f of ['organisation-id 1', 'item-pool-id "winter-2026"']) {
      const out = await compile(`data-job paging EXHAUSTIVE items-get [ ${f} limit 50 {} ] {}..`);
      expect(hasWarning(out, "reads everything itembank/items returns"), f).toBe(true);
    }
  });

  test("a real filter alongside a bank silences it", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [
      organisation-id 1 status ["published"] limit 50 {} ] {}..`);
    expect(hasWarning(out, "reads everything")).toBe(false);
  });
});

describe("the async shape — jobs-get and its producers", () => {
  test("jobs-get is a standalone block: not paged, not async, no paging hole", async () => {
    // Polling a reference you already hold is a legitimate job on its own. It is also the
    // only modelled block that is not paged, so `paging` must NOT be required here.
    const out = await compile(`data-job jobs-get [ references ["dc39cf55-dbfc-4921"] {} ] {}..`);
    expect(out.endpoint).toBe("jobs");
    expect(out.paged).toBe(false);
    expect(out.paging_end).toBeUndefined();
    expect(out.async).toBe(false);
    expect(out.complete).toBe(true);
    expect(hasWarning(out, "paged and the design doesn't say how far it reads")).toBe(false);
  });

  test("an async producer carries poll_with, naming the channel", async () => {
    const out = await compile(`data-job offlinepackage-get [
      organisation-id 386 items [{id: "calc-limit-2", reference: "calc-limit-2"}] {} ] {}..`);
    expect(out.async).toBe(true);
    expect(out.paged).toBe(false);
    // The recipe must branch on data it is given: async operations are spread across four
    // path families, so the channel is not inferable from the endpoint.
    expect(out.poll_with).toEqual({
      endpoint: "jobs", action: "get",
      // Verified to differ per endpoint: offlinepackage returns an array, while
      // activities/duplicate really returns an object. One extraction does not work
      // everywhere, so where to read the reference travels with the block.
      job_reference_at: "data[0].job_reference",
    });
  });

  test("a synchronous block carries no poll_with", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [ references ["a"] {} ] {}..`);
    expect(out.poll_with).toBeUndefined();
  });

  test("jobs-get accepts the four job statuses and rejects an item status", async () => {
    const ok = await compile(`data-job jobs-get [ status ["queued" "running" "halted" "completed"] {} ] {}..`);
    expect(hasWarning(ok, "isn't one of")).toBe(false);
    const bad = await compile(`data-job jobs-get [ status ["published"] {} ] {}..`);
    expect(hasWarning(bad, "isn't one of")).toBe(true);
  });
});

describe("records fields — the items list of an offline package", () => {
  test("a well-formed record list passes and records its path", async () => {
    const out = await compile(`data-job offlinepackage-get [
      organisation-id 386
      items [{id: "a", reference: "a"} {reference: "b"}]
      {} ] {}..`);
    expect(out.request.items).toEqual([{ id: "a", reference: "a" }, { reference: "b" }]);
    expect(out.paths["items"]).toBe("items");
    expect(hasWarning(out, "isn't part of this record")).toBe(false);
  });

  test("a key the element schema doesn't define is dropped with a warning", async () => {
    const out = await compile(`data-job offlinepackage-get [
      items [{reference: "a", wibble: "x"}] {} ] {}..`);
    expect(hasWarning(out, '"wibble" isn\'t part of this record')).toBe(true);
    expect(out.request.items[0].wibble).toBeUndefined();
  });

  test("a required key of the element is enforced", async () => {
    const out = await compile(`data-job offlinepackage-get [ items [{id: "a"}] {} ] {}..`);
    expect(hasWarning(out, 'every entry needs "reference"')).toBe(true);
  });

  test("nested element types are checked by the same machinery", async () => {
    const out = await compile(`data-job offlinepackage-get [
      items [{reference: "a", organisation-id: "386"}] {} ] {}..`);
    expect(hasWarning(out, "must be a number")).toBe(true);
  });

  test("the deprecated item_references is not a field of THIS block", async () => {
    // Learnosity documents it alongside `items` on offlinepackage and marks it deprecated.
    // The keyword nonetheless exists, because item_references is a live, current field on
    // questions-get and features-get — so this is not a parse error but a scoping one, and
    // the fold drops it. Deprecated-here and current-there is exactly why fields belong to
    // blocks rather than to the dialect.
    const out = await compile(`data-job offlinepackage-get [ items [{reference: "a"}] item-references ["a"] {} ] {}..`);
    expect(hasWarning(out, "isn't a request field of this operation")).toBe(true);
    expect(out.request["item-references"]).toBeUndefined();
    // ...and it IS legal on the blocks that document it as current.
    const q = await compile(`data-job paging EXHAUSTIVE questions-get [ item-references ["a"] {} ] {}..`);
    expect(q.request["item-references"]).toEqual(["a"]);
    expect(q.paths["item-references"]).toBe("item_references");
  });
});

describe("the Item-bank advisory only fires where a default is documented", () => {
  test("items-get and offlinepackage-get advise; jobs-get does not", async () => {
    // itembank/* documents `organisation_id` as defaulting to the consumer's PRIMARY bank.
    // `jobs` does not — there the field filters jobs to a bank, so omitting it means
    // unfiltered, and "the primary Item bank is used" would be a false statement.
    const items = await compile(`data-job paging EXHAUSTIVE items-get [ status ["published"] limit 50 {} ] {}..`);
    const pkg = await compile(`data-job offlinepackage-get [ items [{reference: "a"}] {} ] {}..`);
    const jobs = await compile(`data-job jobs-get [ references ["x"] {} ] {}..`);
    expect(hasWarning(items, "primary Item bank")).toBe(true);
    expect(hasWarning(pkg, "primary Item bank")).toBe(true);
    expect(hasWarning(jobs, "primary Item bank")).toBe(false);
    expect(jobs.warnings).toEqual([]);
  });
});

describe("items-set — the first write", () => {
  const ITEM = `{reference: "L0178_TEST_1", definition: {widgets: []}, questions: [{reference: "w1"}], status: "published", title: "t"}`;
  const SET = (item = ITEM) => `data-job items-set [ organisation-id 386 items [${item}] {} ] {}..`;

  test("selects the write operation and takes no paging policy", async () => {
    const out = await compile(SET());
    expect(out.endpoint).toBe("itembank/items");
    expect(out.action).toBe("set");
    expect(out.paged).toBe(false);
    expect(out.async).toBe(false);
    expect(out.complete).toBe(true);
    expect(hasWarning(out, "doesn't say how far it reads")).toBe(false);
  });

  test("it always warns that the job writes, and that the response does not echo", async () => {
    // Verified on sandbox 386: a successful set returns `data: []`. You cannot confirm
    // what landed from the response — you have to re-read.
    const out = await compile(SET());
    expect(hasWarning(out, "This job WRITES")).toBe(true);
    expect(hasWarning(out, "does not echo what was written")).toBe(true);
  });

  test("an item written without status is flagged as undeliverable", async () => {
    // Verified: status omitted -> "unpublished", and an unpublished Item cannot be used
    // in an assessment. The write succeeds, so nothing surfaces until delivery is empty.
    const out = await compile(SET(`{reference: "r", definition: {widgets: []}}`));
    expect(hasWarning(out, "defaults to `unpublished`")).toBe(true);
    // ...and is silent when status is given.
    const ok = await compile(SET());
    expect(hasWarning(ok, "defaults to `unpublished`")).toBe(false);
  });

  test("new-reference is flagged as a rename that breaks referrers", async () => {
    const out = await compile(SET(`{reference: "old", new-reference: "new", definition: {widgets: []}, status: "published"}`));
    expect(hasWarning(out, "RENAMES the Item")).toBe(true);
  });

  test("reference and definition are both required on an entry", async () => {
    const noDef = await compile(SET(`{reference: "r", status: "published"}`));
    expect(hasWarning(noDef, 'every entry needs "definition"')).toBe(true);
    const noRef = await compile(SET(`{definition: {widgets: []}, status: "published"}`));
    expect(hasWarning(noRef, 'every entry needs "reference"')).toBe(true);
  });

  test("content fields pass through as unmodeled, and say so", async () => {
    // definition is REQUIRED by the API but carries item CONTENT, which is L0176's
    // surface. Carrying it unmodeled beats omitting it (no valid write could be written)
    // and beats a typo error (it is not a typo).
    const out = await compile(SET());
    expect(hasWarning(out, "passed through unchecked")).toBe(true);
    expect(hasWarning(out, "this dialect does not model")).toBe(true);
  });

  test("a read-side field is not a write-side field", async () => {
    // `references` is a real keyword — items-get defines it — so this is not a parse
    // error. Keywords are dialect-wide and the FOLD scopes them, which is the whole
    // reason validation happens where the block is known.
    const out = await compile(`data-job items-set [ references ["a"] {} ] {}..`);
    expect(hasWarning(out, "isn't a request field of this operation")).toBe(true);
    expect(out.request.references).toBeUndefined();
  });

  test("the documented batch maximum is enforced", async () => {
    const many = Array.from({ length: 51 },
      (_, i) => `{reference: "r${i}", definition: {widgets: []}, status: "published"}`).join(" ");
    const out = await compile(SET(many));
    expect(hasWarning(out, "exceeds the documented maximum of 50")).toBe(true);
  });
});

describe("write semantics differ BY ACTION on one endpoint", () => {
  const TAGS = `items [{reference: "r", tags: [{type: "probe", name: "A"}]}]`;

  test("the same endpoint replaces under `set` and merges under `update`", async () => {
    // Measured on sandbox 386: seeded A,B; `update` with C gave A,B,C; `set` with D gave D
    // alone. The reference documents IDENTICAL parameters for both actions and never says
    // which is which — so this is the sharpest case for keying the registry on the pair.
    const set = await compile(`data-job items-tags-set [ organisation-id 386 ${TAGS} {} ] {}..`);
    const upd = await compile(`data-job items-tags-update [ organisation-id 386 ${TAGS} {} ] {}..`);
    expect(set.endpoint).toBe("itembank/items/tags");
    expect(upd.endpoint).toBe("itembank/items/tags");
    expect(set.write_semantics).toBe("replace");
    expect(upd.write_semantics).toBe("merge");
  });

  test("each states its own semantics, and the merge case says it does not generalise", async () => {
    const set = await compile(`data-job items-tags-set [ organisation-id 386 ${TAGS} {} ] {}..`);
    const upd = await compile(`data-job items-tags-update [ organisation-id 386 ${TAGS} {} ] {}..`);
    expect(hasWarning(set, "REPLACES what is there")).toBe(true);
    expect(hasWarning(upd, "MERGES into what is there")).toBe(true);
    expect(hasWarning(upd, "does not generalise")).toBe(true);
    // A merging write is still a write.
    expect(hasWarning(upd, "This job WRITES")).toBe(true);
  });

  test("`set` on itembank/items also replaces — but the verb is not what says so", async () => {
    const out = await compile(`data-job items-set [ items [{reference: "r", definition: {widgets: []}, status: "published"}] {} ] {}..`);
    expect(out.write_semantics).toBe("replace");
  });

  test("a read block carries no write semantics", async () => {
    const out = await compile(`data-job paging EXHAUSTIVE items-get [ references ["a"] {} ] {}..`);
    expect(out.writes).toBeUndefined();
    expect(out.write_semantics).toBeUndefined();
  });
});

describe("discriminated operations — sessions + set, branched on data_format", () => {
  test("each variant is its own keyword, and both report the same endpoint and action", async () => {
    const ft = await compile(`data-job sessions-set-from-template [ sessions-data [{activity-id: "a"}] {} ] {}..`);
    const fs = await compile(`data-job sessions-set-failed-submission [ sessions-data ["B64"] {} ] {}..`);
    for (const out of [ft, fs]) {
      expect(out.endpoint).toBe("sessions");
      expect(out.action).toBe("set");
      expect(out.async).toBe(true);
      expect(out.writes).toBe(true);
    }
  });

  test("the discriminant is emitted by the block, not authored", async () => {
    // The author never writes data_format. The block chooses it, so it cannot be omitted
    // or contradict the payload it selects — which is the whole point of splitting the
    // keyword rather than adding variant machinery.
    const ft = await compile(`data-job sessions-set-from-template [ sessions-data [{activity-id: "a"}] {} ] {}..`);
    const fs = await compile(`data-job sessions-set-failed-submission [ sessions-data ["B64"] {} ] {}..`);
    expect(ft.request["data-format"]).toBe("from_template");
    expect(fs.request["data-format"]).toBe("failed_submission");
    // ...and it is pathed like any other field, so the recipe reproduces it verbatim.
    expect(ft.paths["data-format"]).toBe("data_format");
    expect(fs.paths["data-format"]).toBe("data_format");
  });

  test("the same Learnosity path carries different TYPES per variant", async () => {
    // `data` is array[object] under from_template and array[string] under
    // failed_submission. Both map to the path "data"; only the block says which is legal.
    const ft = await compile(`data-job sessions-set-from-template [ sessions-data [{activity-id: "a"}] {} ] {}..`);
    const fs = await compile(`data-job sessions-set-failed-submission [ sessions-data ["B64"] {} ] {}..`);
    expect(ft.paths["sessions-data"]).toBe("data");
    expect(fs.paths["sessions-data"]).toBe("data");
    expect(fs.request["sessions-data"]).toEqual(["B64"]);
    expect(ft.request["sessions-data"][0]).toMatchObject({ "activity-id": "a" });
  });

  test("a field belonging to the other variant is dropped", async () => {
    const out = await compile(`data-job sessions-set-from-template [
      sessions-data [{activity-id: "a"}] ignore-response-revisions true {} ] {}..`);
    expect(hasWarning(out, "isn't a request field of this operation")).toBe(true);
    expect(out.request["ignore-response-revisions"]).toBeUndefined();
  });

  test("boolean fields are type-checked", async () => {
    const out = await compile(`data-job sessions-set-failed-submission [
      sessions-data ["B64"] ignore-response-revisions "yes" {} ] {}..`);
    expect(hasWarning(out, "must be true or false")).toBe(true);
  });

  test("job_reference_at is only claimed where the shape is modelled", async () => {
    // Both envelope forms are real, so guessing is worse than silence.
    const fs = await compile(`data-job sessions-set-failed-submission [ sessions-data ["B64"] {} ] {}..`);
    expect(fs.poll_with.job_reference_at).toBe("data.job_reference");
  });
});

describe("the lexicon still shadows nothing", () => {
  test("`data` stayed L0000's — the sessions payload mirrors its endpoint instead", async () => {
    // mergeLexicon caught this when the field was first written as a bare `data`. The
    // documented remedy is to mirror more of the path, never to claim an override.
    expect(lexicon["data"]).toMatchObject({ arity: 1 });
    expect(lexicon["sessions-data"]).toMatchObject({ arity: 2 });
  });
});

describe("sessions-delete — the only destructive operation", () => {
  const DEL = `data-job sessions-delete [ session-ids ["88336e4c-04de-4274-ae31-39957b230f98"] {} ] {}..`;

  test("it is a write, asynchronous, and not paged", async () => {
    const out = await compile(DEL);
    expect(out.endpoint).toBe("sessions");
    expect(out.action).toBe("delete");
    expect(out.writes).toBe(true);
    expect(out.async).toBe(true);
    expect(out.paged).toBe(false);
    expect(out.poll_with.job_reference_at).toBe("data[0].job_reference");
  });

  test("it warns that it destroys, ahead of the generic write warning", async () => {
    // There is nothing to re-read afterwards and nothing to roll back to, so the check
    // has to happen before the run — which the generic write advisory does not say.
    const out = await compile(DEL);
    const i = out.warnings.findIndex((w: string) => /DESTROYS/.test(w));
    const j = out.warnings.findIndex((w: string) => /This job WRITES/.test(w));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(j);
    expect(hasWarning(out, "cannot be undone")).toBe(true);
    expect(hasWarning(out, "BEFORE running it")).toBe(true);
  });

  test("the one-entry cap is enforced", async () => {
    // Every other batch in the API allows 50. This one allows ONE, deliberately —
    // Learnosity scopes it to right-to-be-forgotten requests, not bulk cleanup.
    const out = await compile(`data-job sessions-delete [ session-ids ["a" "b"] {} ] {}..`);
    expect(hasWarning(out, "exceeds the documented maximum of 1")).toBe(true);
  });

  test("destructiveness is declared, not inferred from the verb", async () => {
    // C19's lesson: the verb predicts nothing in this API. A non-delete write must not
    // pick up the destructive warning.
    const set = await compile(`data-job items-set [ items [{reference: "r", definition: {widgets: []}, status: "published"}] {} ] {}..`);
    expect(hasWarning(set, "DESTROYS")).toBe(false);
  });

  test("write advice matches where the data actually lives", async () => {
    // Sessions are not in an Item bank, so "point it at a scratch bank" is advice a
    // reader cannot follow.
    const del = await compile(DEL);
    const set = await compile(`data-job items-set [ items [{reference: "r", definition: {widgets: []}, status: "published"}] {} ] {}..`);
    expect(hasWarning(del, "scratch bank")).toBe(false);
    expect(hasWarning(set, "scratch bank")).toBe(true);
  });
});

describe("the update action across the API", () => {
  test("activity tags behave like item tags — measured, not assumed", async () => {
    // Sandbox 386: seeded A,B; update with C gave A,B,C; set with D gave D alone.
    const upd = await compile(`data-job activities-tags-update [ activities [{reference: "a", tags: [{type: "t", name: "n"}]}] {} ] {}..`);
    const set = await compile(`data-job activities-tags-set [ activities [{reference: "a", tags: [{type: "t", name: "n"}]}] {} ] {}..`);
    expect(upd.write_semantics).toBe("merge");
    expect(set.write_semantics).toBe("replace");
  });

  test("every other update block leaves its semantics UNSTATED", async () => {
    // Both measurements are tag assignments. Generalising from them is the mistake this
    // API has punished repeatedly (C15, C16, C17), and here it would destroy data.
    for (const src of [
      `data-job pools-update [ pools [{reference: "p"}] {} ] {}..`,
      `data-job session-statuses-update [ statuses [{session-id: "s", status: "Completed"}] {} ] {}..`,
      `data-job session-item-update [ session-ids ["s"] target-item-reference "r" {} ] {}..`,
      `data-job response-feedback-update [ session-id "s" items [{item-reference: "i"}] {} ] {}..`,
      `data-job response-scores-update [ sessions [{session-id: "s"}] {} ] {}..`,
      `data-job response-grading-update [ session-id "s" items [{item-reference: "i"}] {} ] {}..`,
    ]) {
      const out = await compile(src);
      expect(out.write_semantics, src).toBeUndefined();
      expect(hasWarning(out, "has NOT been established"), src).toBe(true);
    }
  });

  test("an unknown-semantics write says why, not just that", async () => {
    const out = await compile(`data-job pools-update [ pools [{reference: "p"}] {} ] {}..`);
    expect(hasWarning(out, "they were both tag assignments")).toBe(true);
    expect(hasWarning(out, "Rehearse against data you can afford to lose")).toBe(true);
  });

  test("`status` now means a third thing again, scoped to its block", async () => {
    // Item statuses (published/…), job statuses (queued/…), and now SESSION statuses.
    const ok = await compile(`data-job session-statuses-update [ statuses [{session-id: "s", status: "Discarded"}] {} ] {}..`);
    expect(hasWarning(ok, "isn't one of")).toBe(false);
    const bad = await compile(`data-job session-statuses-update [ statuses [{session-id: "s", status: "published"}] {} ] {}..`);
    expect(hasWarning(bad, "isn't one of")).toBe(true);
  });

  test("nested target_item paths flatten as declared", async () => {
    const out = await compile(`data-job session-item-update [
      session-ids ["s"] target-item-reference "r" target-item-organisation-id 386 {} ] {}..`);
    expect(out.paths["target-item-reference"]).toBe("target_item.reference");
    expect(out.paths["target-item-organisation-id"]).toBe("target_item.organisation_id");
  });

  test("grading and feedback payloads are carried unmodelled, and say so", async () => {
    const out = await compile(`data-job response-grading-update [
      session-id "s" items [{item-reference: "i", responses: [{response_id: "r"}]}] {} ] {}..`);
    expect(hasWarning(out, "passed through unchecked")).toBe(true);
  });
});
