// SPDX-License-Identifier: MIT
// Unit tests for the L0177 Author API integration oracle. Uniform surface: every
// property is an arity-2 kebab function; members are arity-1; views select the
// mode; widget-type enum values are UPPERCASE tags. These assert per-property
// validation, view/mode mapping, design-hole warnings, progressive disclosure,
// cross-context coherence, and that unknown properties are parse errors.
import { describe, test, expect } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

async function compile(src: string, data: any = {}, config: any = {}): Promise<any> {
  const code = await parser.parse(177, src, lexicon);
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

const COMPLETE = `author-embed
  domain "lms.acme.edu"
  user-id "u123"
  reference "algebra-item-1"
  organisation-id 123
  allow-widgets [MCQ CLOZE-TEXT FORMULA]
  question-type-groups [MCQ CLOZE]
  item-edit [
    item back true scoring true reference-prefix "LEAR_" {}
    widget edit true delete false {}
  ]
  container height 600 {}
  {}..`;

describe("complete design + tags", () => {
  test("a fully-specified item-edit design compiles with no warnings", async () => {
    const out = await compile(COMPLETE);
    expect(out.mode).toBe("item_edit");
    expect(out.complete).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(out.allow_widgets).toEqual(["mcq", "clozetext", "formula"]); // uppercase tags mapped
    expect(out.config.item).toMatchObject({ back: true, scoring: true, "reference-prefix": "LEAR_" });
    expect(out.config.widget).toEqual({ edit: true, delete: false });
  });

  test("each view function maps to its Learnosity mode", async () => {
    for (const [fn, mode] of [
      ["item-edit", "item_edit"], ["item-list", "item_list"],
      ["activity-edit", "activity_edit"], ["activity-list", "activity_list"],
    ]) {
      const out = await compile(`author-embed domain "d" user-id "u" ${fn} [] {}..`);
      expect(out.mode).toBe(mode);
      // All four views are modeled now — none passes members through unvalidated.
      expect(hasWarning(out, "isn't fully modeled yet")).toBe(false);
    }
  });
});

describe("design holes (progressive disclosure)", () => {
  test("no view flags the view hole", async () => {
    const out = await compile('author-embed domain "d" user-id "u" {}..');
    expect(out.complete).toBe(false);
    expect(hasWarning(out, "which authoring view")).toBe(true);
  });

  test("bare item-edit flags domain, author, reference; suppresses specificity", async () => {
    const out = await compile("author-embed item-edit [ item {} ] {}..");
    expect(out.mode).toBe("item_edit");
    expect(out.complete).toBe(false);
    expect(hasWarning(out, "domain")).toBe(true);
    expect(hasWarning(out, "author")).toBe(true);
    expect(hasWarning(out, "reference")).toBe(true);
    expect(hasWarning(out, "item bank")).toBe(false);
  });

  test("holes filled → specificity advisories surface", async () => {
    const out = await compile('author-embed domain "d" user-id "u" reference "r" item-edit [ item {} ] {}..');
    expect(out.complete).toBe(true);
    expect(hasWarning(out, "question-type-groups")).toBe(true);
    expect(hasWarning(out, "item bank")).toBe(true);
  });
});

describe("view-scoped members", () => {
  test("a member the view rejects is dropped, not folded into config", async () => {
    const out = await compile('author-embed domain "d" user-id "u" item-list [ item status true {} widget edit true delete false {} ] {}..');
    expect(out.mode).toBe("item_list");
    expect(out.config.widget).toBeUndefined(); // item_list has no widgets to edit/delete
    expect(out.config.item).toEqual({ status: true }); // an accepted member still lands
    expect(hasWarning(out, `item-list: "widget" isn't a member of this view`)).toBe(true);
  });

  // The regression test for the mis-scoping bug. `config.item_edit.item` and
  // `config.item_list.item` are different Learnosity nodes sharing one field name
  // (`status`); item-edit's fields used to be accepted here and emitted as
  // config.item_list.item.*, which the Author API silently ignores (it fails open).
  test("item-edit's item fields are not accepted by item-list", async () => {
    const out = await compile('author-embed domain "d" user-id "u" item-list [ item back true scoring true {} ] {}..');
    expect(out.config.item).toEqual({}); // dropped, not emitted under item_list
    expect(out.paths["config.item.back"]).toBeUndefined();
    expect(hasWarning(out, `item: "back" isn't a valid item property`)).toBe(true);
    expect(hasWarning(out, `item: "scoring" isn't a valid item property`)).toBe(true);
  });

  test("validity warnings surface even while design holes remain", async () => {
    const out = await compile("author-embed item-list [ widget edit true {} ] {}..");
    expect(out.complete).toBe(false);
    expect(hasWarning(out, "domain")).toBe(true); // holes still lead
    expect(hasWarning(out, "dropped")).toBe(true); // ...but the drop isn't silent
    expect(hasWarning(out, "item bank")).toBe(false); // specificity still deferred
  });
});

describe("per-property + cross-context validation", () => {
  test("a wrong-typed property warns", async () => {
    const out = await compile('author-embed domain "d" user-id "u" reference "r" item-edit [ item back "yes" {} ] {}..');
    expect(hasWarning(out, "back must be true or false")).toBe(true);
  });

  test("a property used in the wrong member warns", async () => {
    const out = await compile('author-embed domain "d" user-id "u" reference "r" item-edit [ item edit true {} ] {}..');
    expect(hasWarning(out, `item: "edit" isn't a valid item property`)).toBe(true);
  });

  test("an unknown property is a parse error", async () => {
    await expect(compile('author-embed item-edit [ item wibble true {} ] {}..')).rejects.toBeTruthy();
  });
});

describe("item-edit vocabulary", () => {
  test("the item editor's grouped nodes compile and resolve to their paths", async () => {
    const out = await compile(`author-embed
      domain "d" user-id "u" reference "r" organisation-id 1 allow-widgets [MCQ] question-type-groups [MCQ]
      item-edit [
        item actions-show true
             details-difficulty-show true details-difficulty-edit false
             details-scoring-type-show true
             duplicate-show false duplicate-shared-passages true
             math-hints-generation-enable true
             mode-default "preview" mode-show false
             popup-content-enable false
             save-show true save-persist false
             title-show true title-edit false title-mandatory true {}
      ]
      {}..`);
    expect(out.warnings).toEqual([]);
    expect(out.config.item).toMatchObject({
      "actions-show": true, "mode-default": "preview", "title-mandatory": true, "save-persist": false,
    });
    expect(out.paths).toMatchObject({
      "config.item.actions-show": "config.item_edit.item.actions.show",
      "config.item.details-scoring-type-show": "config.item_edit.item.details.scoring_type.show",
      "config.item.duplicate-shared-passages": "config.item_edit.item.duplicate.duplicate_shared_passages",
      "config.item.math-hints-generation-enable": "config.item_edit.item.math_hints_generation.enable",
      "config.item.title-mandatory": "config.item_edit.item.title.mandatory",
    });
  });

  // title-show exists in BOTH item-edit's item and item-list's item, at different
  // Learnosity paths. The view-scoped registry is what keeps them apart.
  test("title-show resolves to a different path per view", async () => {
    const edit = await compile('author-embed domain "d" user-id "u" reference "r" organisation-id 1 allow-widgets [MCQ] item-edit [ item title-show true {} ] {}..');
    const list = await compile('author-embed domain "d" user-id "u" organisation-id 1 item-list [ item title-show true {} ] {}..');
    expect(edit.paths["config.item.title-show"]).toBe("config.item_edit.item.title.show");
    expect(list.paths["config.item.title-show"]).toBe("config.item_list.item.title.show");
  });

  test("item-list's fields are rejected by item-edit, the converse of the scoping bug", async () => {
    const out = await compile('author-embed domain "d" user-id "u" reference "r" organisation-id 1 allow-widgets [MCQ] item-edit [ item url "/x/:reference" enable-selection true {} ] {}..');
    expect(out.config.item).toEqual({});
    expect(hasWarning(out, `item: "url" isn't a valid item property`)).toBe(true);
    expect(hasWarning(out, `item: "enable-selection" isn't a valid item property`)).toBe(true);
  });
});

describe("enumerated values", () => {
  test("an out-of-range enum warns rather than reaching Learnosity", async () => {
    // The API ignores what it doesn't recognise, so a bad enum would otherwise
    // produce an editor that looks configured and isn't.
    const out = await compile('author-embed domain "d" user-id "u" reference "r" organisation-id 1 allow-widgets [MCQ] item-edit [ item mode-default "readonly" {} ] {}..');
    expect(hasWarning(out, `mode-default: "readonly" isn't one of "edit", "preview"`)).toBe(true);
  });

  test("enum ranges apply elementwise to string lists", async () => {
    const out = await compile('author-embed domain "d" user-id "u" organisation-id 1 item-list [ filter-restricted status ["published" "retired"] {} ] {}..');
    expect(hasWarning(out, `status: "retired" isn't one of "published", "unpublished", "archived"`)).toBe(true);
    expect(hasWarning(out, `status: "published"`)).toBe(false); // valid members pass silently
  });
});

describe("item-list vocabulary", () => {
  const LIST = `author-embed
    domain "lms.acme.edu" user-id "u123" organisation-id 7
    item-list [
      item url "https://app.acme.edu/items/:reference/edit"
           enable-selection true
           title-show true
           title-show-reference false {}
      filter-restricted current-user true
                        status ["published" "unpublished"]
                        created-by ["u123" "u456"] {}
      toolbar toolbar-add true search-show true search-controls ["reference" "title"] {}
      limit 25 {}
    ]
    {}..`;

  test("the real item_list options compile with no warnings", async () => {
    const out = await compile(LIST);
    expect(out.mode).toBe("item_list");
    expect(out.warnings).toEqual([]);
    expect(out.config.item).toMatchObject({ "url": "https://app.acme.edu/items/:reference/edit", "enable-selection": true });
    expect(out.config["filter-restricted"]).toMatchObject({ "current-user": true, "status": ["published", "unpublished"] });
    expect(out.config.toolbar).toMatchObject({ "toolbar-add": true, "search-show": true });
  });

  test("a bare property chain sets view-level scalars", async () => {
    const out = await compile(LIST);
    expect(out.config.limit).toBe(25);
    expect(out.paths["config.limit"]).toBe("config.item_list.limit");
  });

  test("an unknown view-level property warns rather than landing", async () => {
    const out = await compile('author-embed domain "d" user-id "u" organisation-id 1 item-list [ limit 25 {} scoring true {} ] {}..');
    expect(out.config.scoring).toBeUndefined();
    expect(hasWarning(out, `item-list: "scoring" isn't a valid item-list property`)).toBe(true);
  });

  // `status` is a boolean under config.item_list.item but array[string] under
  // config.item_list.filter.restricted. A flat name->type map cannot express that,
  // which is why type checking moved to the fold along with membership checking.
  test("the same property name carries a different type per context", async () => {
    const ok = await compile('author-embed domain "d" user-id "u" organisation-id 1 item-list [ item status true {} filter-restricted status ["published"] {} ] {}..');
    expect(ok.warnings).toEqual([]);
    expect(ok.config.item.status).toBe(true);
    expect(ok.config["filter-restricted"].status).toEqual(["published"]);

    const swapped = await compile('author-embed domain "d" user-id "u" organisation-id 1 item-list [ item status ["published"] {} filter-restricted status true {} ] {}..');
    expect(hasWarning(swapped, "status must be true or false")).toBe(true);
    expect(hasWarning(swapped, "status must be a list of strings")).toBe(true);
  });
});

describe("activity-edit vocabulary", () => {
  const ACT = `author-embed
    domain "lms.acme.edu" user-id "u123" reference "quiz-1" organisation-id 7 allow-widgets [MCQ] question-type-groups [MCQ]
    activity-edit [
      back true details true mode-default "edit" reference-show true status-show false {}
      item add-show true edit-allow true title-show-reference false {}
      item-search show true limit 25 sort true filter-restricted-current-user true {}
      player-playback show true shuffle-items-show false distractor-rationale-show true {}
      player-time show true limit-type-edit true auto-save-show true {}
      player-administration show true show-exit-show false {}
      activity-edit-save show true persist false {}
      title show true mandatory true {}
    ]
    {}..`;

  test("a broad activity-edit design compiles with no warnings", async () => {
    const out = await compile(ACT);
    expect(out.mode).toBe("activity_edit");
    expect(out.complete).toBe(true);
    expect(out.warnings).toEqual([]); // no longer "isn't fully modeled yet"
    expect(out.config.back).toBe(true); // view-level scalars
    expect(out.config["player-playback"]).toMatchObject({ show: true, "distractor-rationale-show": true });
  });

  test("paned members and view-level scalars resolve to their documented paths", async () => {
    const out = await compile(ACT);
    expect(out.paths).toMatchObject({
      "config.back": "config.activity_edit.back",
      "config.mode-default": "config.activity_edit.mode.default",
      "config.status-show": "config.activity_edit.status.show",
      "config.player-playback.distractor-rationale-show":
        "config.activity_edit.player.playback.distractor_rationale.show",
      "config.player-time.limit-type-edit": "config.activity_edit.player.time.limit_type.edit",
      "config.item-search.filter-restricted-current-user":
        "config.activity_edit.item_search.filter.restricted.current_user",
    });
  });

  // Both names mirror the view segment because the bare word is taken elsewhere in the
  // dialect: `save` is a widget-templates property, `settings` an item-edit member.
  test("the two path-mirrored names map back to their plain Learnosity paths", async () => {
    const out = await compile(ACT);
    expect(out.paths["config.activity-edit-save.persist"]).toBe("config.activity_edit.save.persist");
    const s = await compile('author-embed domain "d" user-id "u" organisation-id 1 activity-edit [ activity-edit-settings false {} ] {}..');
    expect(s.paths["config.activity-edit-settings"]).toBe("config.activity_edit.settings");
  });

  test("item-edit's members and fields are rejected by activity-edit", async () => {
    const out = await compile('author-embed domain "d" user-id "u" organisation-id 1 activity-edit [ widget edit true {} item scoring true {} ] {}..');
    expect(out.config.widget).toBeUndefined();
    expect(hasWarning(out, `activity-edit: "widget" isn't a member of this view`)).toBe(true);
    expect(hasWarning(out, `item: "scoring" isn't a valid item property`)).toBe(true);
  });
});

describe("activity-list vocabulary", () => {
  const LIST = `author-embed
    domain "lms.acme.edu" user-id "u123" organisation-id 7
    activity-list [
      full-activity-json true limit 20 status true title-show true {}
      filter-restricted current-user true status ["published"] created-by ["u1"] {}
      toolbar toolbar-add true add-adaptive false add-random true search true {}
    ]
    {}..`;

  test("the activity browser compiles clean and resolves its paths", async () => {
    const out = await compile(LIST);
    expect(out.mode).toBe("activity_list");
    expect(out.warnings).toEqual([]);
    expect(out.paths).toMatchObject({
      "config.limit": "config.activity_list.limit",
      "config.title-show": "config.activity_list.title.show",
      "config.filter-restricted.created-by": "config.activity_list.filter.restricted.created_by",
      "config.toolbar.toolbar-add": "config.activity_list.toolbar.add",
      "config.toolbar.add-adaptive": "config.activity_list.toolbar.add_adaptive",
    });
  });

  // `status` is a boolean at view level (show the column) and a list of states under
  // filter-restricted (which to list) — the same word, in the same view, at two nodes.
  test("status carries a different type at view level than under filter-restricted", async () => {
    const out = await compile(LIST);
    expect(out.config.status).toBe(true);
    expect(out.config["filter-restricted"].status).toEqual(["published"]);
    expect(out.paths["config.status"]).toBe("config.activity_list.status");
    expect(out.paths["config.filter-restricted.status"])
      .toBe("config.activity_list.filter.restricted.status");
  });

  test("item-list's toolbar fields don't leak into activity-list's", async () => {
    const out = await compile('author-embed domain "d" user-id "u" organisation-id 1 activity-list [ toolbar search-show true {} ] {}..');
    expect(out.config.toolbar).toEqual({});
    expect(hasWarning(out, `toolbar: "search-show" isn't a valid toolbar property`)).toBe(true);
  });
});

describe("tag lists", () => {
  // Learnosity's TagsV2 is a list of {type, name?}. Designs write gc records so the
  // shape mirrors the payload, which needs no new keywords at all.
  test("a tag list compiles, with name as one string, several, or omitted", async () => {
    const out = await compile(`author-embed domain "d" user-id "u" organisation-id 1 item-list [
      filter-restricted tags-all [{type: "Grade", name: "4"} {type: "Subject", name: ["Math" "Science"]} {type: "Course"}] {}
    ] {}..`);
    expect(out.warnings).toEqual([]);
    expect(out.config["filter-restricted"]["tags-all"]).toEqual([
      { type: "Grade", name: "4" },
      { type: "Subject", name: ["Math", "Science"] },
      { type: "Course" }, // no name -> matches every name of that type
    ]);
    expect(out.paths["config.filter-restricted.tags-all"])
      .toBe("config.item_list.filter.restricted.tags.all");
  });

  test("a tag without a type is dropped, not sent", async () => {
    const out = await compile('author-embed domain "d" user-id "u" organisation-id 1 item-list [ filter-restricted tags-none [{name: "4"}] {} ] {}..');
    expect(out.config["filter-restricted"]["tags-none"]).toEqual([]);
    expect(hasWarning(out, 'every tag needs a "type" string')).toBe(true);
  });

  // The API fails open, so an unrecognised key would ride along invisibly.
  test("a stray key is stripped while the tag itself survives", async () => {
    const out = await compile('author-embed domain "d" user-id "u" organisation-id 1 item-list [ filter-restricted tags-either [{type: "Grade", name: "4", colour: "red"}] {} ] {}..');
    expect(out.config["filter-restricted"]["tags-either"]).toEqual([{ type: "Grade", name: "4" }]);
    expect(hasWarning(out, `"colour" isn't part of a tag`)).toBe(true);
  });

  test("a malformed name warns instead of reaching Learnosity", async () => {
    const out = await compile('author-embed domain "d" user-id "u" organisation-id 1 item-list [ filter-restricted tags-all [{type: "Grade", name: 4}] {} ] {}..');
    expect(hasWarning(out, `a tag's "name" must be a string or a list of strings`)).toBe(true);
  });

  test("tag lists reach every view that documents them", async () => {
    const ie = await compile('author-embed domain "d" user-id "u" reference "r" organisation-id 1 allow-widgets [MCQ] question-type-groups [MCQ] item-edit [ item save-restricted-tags-all [{type: "Status", name: "draft"}] {} tags-on-create [{type: "Subject", name: "Math"}] {} ] {}..');
    expect(ie.warnings).toEqual([]);
    expect(ie.paths["config.item.save-restricted-tags-all"])
      .toBe("config.item_edit.item.save.restricted_tags.all");
    expect(ie.paths["config.tags-on-create"]).toBe("config.item_edit.tags_on_create");

    const al = await compile('author-embed domain "d" user-id "u" organisation-id 1 activity-list [ filter-restricted tags-none [{type: "Grade", name: "6"}] {} ] {}..');
    expect(al.paths["config.filter-restricted.tags-none"])
      .toBe("config.activity_list.filter.restricted.tags.none");
  });
});

describe("record lists (item banks)", () => {
  const bank = (inner: string) =>
    `author-embed domain "d" user-id "u" organisation-id 1 allow-widgets [MCQ] question-type-groups [MCQ] activity-edit [ item-search ${inner} {} ] {}..`;

  test("a list of item banks compiles and resolves its path", async () => {
    const out = await compile(bank('item-banks [{organisation_id: 100, item_bank_name: "Math", item_pool_id: "p1"} {organisation_id: 200}]'));
    expect(out.warnings).toEqual([]);
    expect(out.config["item-search"]["item-banks"]).toEqual([
      { organisation_id: 100, item_bank_name: "Math", item_pool_id: "p1" },
      { organisation_id: 200 },
    ]);
    expect(out.paths["config.item-search.item-banks"])
      .toBe("config.activity_edit.item_search.item_banks");
  });

  test("a key outside the schema is stripped, and the record survives", async () => {
    const out = await compile(bank('item-banks [{organisation_id: 100, bank: "x"}]'));
    expect(out.config["item-search"]["item-banks"]).toEqual([{ organisation_id: 100 }]);
    expect(hasWarning(out, `"bank" isn't part of this record`)).toBe(true);
  });

  // Each key runs through the same validator as a property, so types come for free.
  test("a record field is type-checked like any other property", async () => {
    const out = await compile(bank('item-banks [{organisation_id: "one-hundred"}]'));
    expect(hasWarning(out, "organisation_id must be a number")).toBe(true);
  });

  // `filter` is real Learnosity vocabulary, just beyond this schema's reach. Saying so
  // keeps it distinct from a typo and from something we quietly passed through.
  test("a documented-but-unmodeled key reports itself as such, not as a typo", async () => {
    const out = await compile(bank("item-banks [{organisation_id: 100, filter: {}}]"));
    expect(out.config["item-search"]["item-banks"]).toEqual([{ organisation_id: 100 }]);
    expect(hasWarning(out, "documented Learnosity option that L0177 doesn't model yet")).toBe(true);
    expect(hasWarning(out, `"filter" isn't part of this record`)).toBe(false);
  });

  test("a non-record entry is rejected", async () => {
    const out = await compile(bank('item-banks ["not-a-record"]'));
    expect(out.config["item-search"]["item-banks"]).toEqual([]);
    expect(hasWarning(out, "each entry must be a record")).toBe(true);
  });
});

describe("view-level chains must be terminated", () => {
  // `limit 20 filter-restricted …` parses as limit taking the member as its
  // continuation, so limit ends up on the member wrapper where nothing reads it.
  // It used to vanish without a word — the exact silent loss this dialect exists to
  // prevent, and easy to write by accident.
  test("a chain running into a member warns instead of vanishing", async () => {
    const out = await compile('author-embed domain "d" user-id "u" organisation-id 1 activity-list [ limit 20 filter-restricted current-user true {} ] {}..');
    expect(out.config.limit).toBeUndefined();
    expect(hasWarning(out, 'ran into the "filter-restricted" member')).toBe(true);
    expect(hasWarning(out, "terminate the property chain with {}")).toBe(true);
  });

  test("terminating the chain keeps both, with no warning", async () => {
    const out = await compile('author-embed domain "d" user-id "u" organisation-id 1 activity-list [ limit 20 {} filter-restricted current-user true {} ] {}..');
    expect(out.config.limit).toBe(20);
    expect(out.config["filter-restricted"]).toEqual({ "current-user": true });
    expect(out.warnings).toEqual([]);
  });
});

describe("question-type-groups (the one enforced restriction)", () => {
  const base = (extra: string) =>
    `author-embed domain "d" user-id "u" reference "r" organisation-id 1 ${extra} item-edit [] {}..`;

  // Verified differentially against the live Author API: overriding a group reference
  // with an empty template_references removes the group; overriding it with the key
  // omitted leaves the group whole. Naming only the wanted groups restricts NOTHING —
  // extra references are additive — so all ten must be overridden.
  test("all ten groups are overridden: named ones kept whole, the rest removed", async () => {
    const out = await compile(base("question-type-groups [MCQ CLOZE]"));
    expect(out.warnings).toEqual([]);
    const g = out.question_type_groups;
    expect(g).toHaveLength(10);
    const kept = g.filter((x: any) => x.template_references === undefined).map((x: any) => x.reference);
    const removed = g.filter((x: any) => Array.isArray(x.template_references) && x.template_references.length === 0);
    expect(kept).toEqual(["mcq", "cloze"]);
    expect(removed).toHaveLength(8);
  });

  test("it resolves to the verified Learnosity path", async () => {
    const out = await compile(base("question-type-groups [MATH]"));
    expect(out.paths["question-type-groups"])
      .toBe("config.dependencies.question_editor_api.init_options.question_type_groups");
  });

  // SHORT-TEXT is a perfectly good widget tag, but groups and question types are
  // different taxonomies — using one where the other belongs must not silently pass.
  // (A token that is no tag at all, like ESSAY, is a parse error instead.)
  test("a widget tag used as a group tag warns and is not emitted", async () => {
    const out = await compile(base("question-type-groups [MCQ SHORT-TEXT]"));
    expect(hasWarning(out, "SHORT-TEXT isn't a question-type group")).toBe(true);
    expect(out.question_type_groups.filter((x: any) => x.template_references === undefined))
      .toEqual([{ reference: "mcq", name: "mcq" }]);
  });

  // allow-widgets names question types; nothing confirmed restricts at that granularity.
  // A design reaching for it alone must be told it enforces nothing.
  test("allow-widgets alone is flagged as unenforced", async () => {
    const out = await compile(base("allow-widgets [MCQ CLOZE-TEXT]"));
    expect(out.question_type_groups).toBeUndefined();
    expect(hasWarning(out, "on its own it enforces nothing")).toBe(true);
    expect(hasWarning(out, "add `question-type-groups`")).toBe(true);
  });

  test("with no restriction at all, the advisory names the enforced one", async () => {
    const out = await compile(base(""));
    expect(hasWarning(out, "the editor offers all ten question-type groups")).toBe(true);
  });
});

describe("no keyword shadows the inherited L0000 vocabulary", () => {
  // `filter.restricted` and `toolbar.add` are named `filter-restricted` and
  // `toolbar-add` precisely so that base `filter` and `add` survive. Assert the
  // collision was AVOIDED, not merely renamed around.
  test("base filter and add still resolve to L0000's functions", () => {
    expect(lexicon.filter).toMatchObject({ name: "FILTER", type: "<lambda list: list>" });
    expect(lexicon.add).toMatchObject({ name: "ADD", type: "<number number: number>" });
    expect(lexicon["filter-restricted"]).toMatchObject({ name: "FILTER_RESTRICTED", arity: 1 });
    expect(lexicon["toolbar-add"]).toMatchObject({ name: "TOOLBAR_ADD", arity: 2 });
  });

  test("base filter is still usable as a list function", async () => {
    const out = await compile('author-embed domain "d" user-id "u" reference "r" organisation-id 1 allow-widgets [MCQ] question-type-groups [MCQ] item-edit [] {}..');
    expect(out.mode).toBe("item_edit");
    expect(out.warnings).toEqual([]);
  });
});

describe("exact Learnosity paths accompany the design", () => {
  test("every set config key maps to its documented path", async () => {
    const out = await compile(`author-embed domain "d" user-id "u" reference "r" organisation-id 1
      item-edit [ item reference-prefix "LEAR_" tags-show true {} widget delete false {} ]
      container height 600 {}
      {}..`);
    expect(out.paths).toMatchObject({
      "config.item.reference-prefix": "config.item_edit.item.reference.prefix",
      "config.item.tags-show": "config.item_edit.item.tags.show",
      "config.widget.delete": "config.item_edit.widget.delete",
      "container.height": "config.container.height",
    });
  });

  test("a dropped field contributes no path", async () => {
    const out = await compile('author-embed domain "d" user-id "u" organisation-id 1 item-list [ item back true {} ] {}..');
    expect(Object.keys(out.paths)).not.toContain("config.item.back");
  });
});

/**
 * The shipped starting template. The console seeds a NEW item with this file verbatim (its
 * createItem runs generateCode with the literal prompt "Create a minimal starting template",
 * which short-circuits to the asset — no model involved), and the user's first real request then
 * runs as an EDIT of it. So whatever this file asserts, every console-authored item inherits and
 * the generator is correct to preserve.
 *
 * It used to be the canonical worked example — domain "lms.example.edu", user-id "u123",
 * reference "algebra-item-1", organisation-id 100, plus item/widget boilerplate. That pre-filled
 * exactly the three properties this dialect steers on, so every console item started
 * `complete: true` with zero warnings and the holes-first refinement loop could never fire. Four
 * mark-3 training items harvested on 2026-08-12 all carried those literals with no prompt
 * mentioning them; the generator had not invented them, it had inherited them.
 *
 * So the template must introduce NOTHING. Not the required properties, and not a view either —
 * the view IS the mode, so pre-picking one biases every first request toward that experience.
 */
describe("the shipped starting template introduces nothing", () => {
  const template = readFileSync(
    fileURLToPath(new URL("../spec/template.gc", import.meta.url)), "utf-8",
  );

  test("asserts none of the hole-bearing properties, and no view", () => {
    for (const prop of ["domain", "user-id", "reference", "organisation-id"]) {
      expect(template).not.toContain(prop);
    }
    for (const view of ["item-edit", "item-list", "activity-edit", "activity-list"]) {
      expect(template).not.toContain(view);
    }
  });

  test("compiles, and every design hole surfaces for the author to fill", async () => {
    const out = await compile(template);
    expect(out.complete).toBe(false);
    expect(hasWarning(out, "Which authoring view?")).toBe(true);
    expect(hasWarning(out, "serving `domain`")).toBe(true);
    expect(hasWarning(out, "identify the author")).toBe(true);
  });
});
