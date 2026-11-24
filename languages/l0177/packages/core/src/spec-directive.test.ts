import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

// These files are PROMPTS, not code: spec-directive.md drives get_spec, and instructions.md is the
// canonical knowledge it draws on. Nothing else in the repo guards them, and every rule asserted
// below was installed after a live Author API run contradicted the recipe.
//
// The rules have now been rewritten TWICE by live evidence, in opposite directions. First the
// documented widget-type path turned out to restrict nothing, so the recipe was made to refuse
// any path. Then a differential run showed the restriction does work — via question_type_groups,
// overriding all ten default groups — and that the earlier "no effect" reading came from supplying
// a NEW group reference, which is additive: the config was in force and the picker looked
// untouched. Both readings were honest; only the comparison against a control separated them.
//
// Then a third time, 2026-11-24: that ten-group override narrowed only the SIDEBAR. Searching the
// picker for "essay" listed seven templates from the hidden groups — the sidebar count, which was
// the differential, could not see it. An independent implementation of the documented mechanism
// (group_defaults false plus only the wanted groups, each naming its template references) showed
// two templates and no essay. So these assertions pin that mechanism as DOCUMENTED, the search
// check that would have caught the bypass, and the fail-open refusal of an empty restriction. When
// a search-inclusive differential confirms the mechanism, record it in instructions.md and promote
// the label; never promote it from documentation alone. (Promoted the same day: the fixed compiler's
// output, run with search, held — see the measurements in instructions.md.)
//
// What this test does NOT do: it pins the prompt, not the output. A passing run says the rules are
// still written down — it cannot tell you the generator obeyed them. Recipe generation is sampled,
// and we have watched a rule hold in one generation and lapse in the next. Catching that needs an
// eval over N generations, not a unit test.

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../spec/${name}`, import.meta.url)), "utf-8")
    // Prettier formats spec/*.md (there is no .prettierignore), so it may rewrap any of these
    // lines. Match on whitespace-normalized substrings, never on exact lines or line numbers.
    .replace(/\s+/g, " ");

const directive = read("spec-directive.md");
const instructions = read("instructions.md");

describe("spec-directive.md keeps the rules the live API taught us", () => {
  test("the picker restriction is group_defaults false plus only the wanted groups", () => {
    expect(instructions).toContain("config.dependencies.question_editor_api.init_options");
    expect(directive).toContain("`group_defaults: false` plus ONLY the groups in the `<COMPILED_PICKER>` block's `question_type_groups`");
    // With the default true, question_type_groups only extends the defaults.
    expect(directive).toContain("only EXTENDS the default groups");
    expect(directive).toContain("Never emit the old ten-group `[]` override");
  });

  test("hiding groups is named as sidebar-only, with the observation that showed it", () => {
    expect(instructions).toContain("Hiding groups is NOT a restriction — search bypasses it");
    expect(instructions).toContain("removes **sidebar tiles only**");
    expect(instructions).toContain("counted SIDEBAR groups and tiles only");
  });

  // Promoted 2026-11-24 on a search-inclusive differential; the table is the evidence.
  test("the mechanism is verified with search, and the evidence is recorded", () => {
    expect(instructions).toContain("[verified 2026-11-24, search included");
    expect(instructions).toContain("| control (no `init_options`) | 10 | 7 templates | 66 tiles |");
    expect(instructions).toContain("50 raw question types (fails open)");
    // Verified MECHANISM is not a verified DEPLOYMENT.
    expect(directive).toContain("intent pending observation in THIS deployment");
  });

  test("a picker differential must include search, in both runs", () => {
    expect(directive).toContain("A picker differential must include SEARCH");
    expect(directive).toContain("search for a question type the design does NOT allow");
    expect(directive).toContain("submit an empty search");
    expect(directive).toContain("Counting sidebar groups or tiles proves nothing");
  });

  // The prompt carries what the compiler resolved (graffiticode-app withCompiledData); a rule that
  // names data the prompt never holds sends the generator off to derive it.
  test("the picker and the holes are read from the blocks the prompt carries", () => {
    expect(directive).toContain("<COMPILED_PICKER>");
    expect(directive).toContain("<COMPILED_HOLES>");
    expect(directive).toContain("If there is no `<COMPILED_PICKER>` block, the design sets no picker restriction");
    expect(directive).not.toContain("data.question_type_groups");
    expect(directive).not.toContain("data.picker_templates");
  });

  test("an empty restriction is refused, because it fails open", () => {
    expect(instructions).toContain("An empty restriction FAILS OPEN");
    expect(directive).toContain("never emit `group_defaults: false` with an empty group list");
  });

  test("still refuses the paths that were shown not to restrict", () => {
    expect(directive).toContain("Never emit");
    expect(directive).toContain("widgetTypes");
    expect(directive).toContain("widget_templates.widget_types");
  });

  test("question types and templates are restrictable through template references", () => {
    expect(directive).toContain("Question types and templates ARE restrictable — through template references");
    expect(directive).toContain("`mcq` has four");
    expect(directive).toContain("Never invent a per-type config key");
    // The limit: picker restriction, not validation of stored content.
    expect(directive).toContain("it does not validate stored or imported item JSON");
  });

  test("config-behaviour checks must be differential, including enabling keys", () => {
    expect(directive).toContain("must be DIFFERENTIAL");
    expect(directive).toContain("ENABLING keys too");
    // The specific hole the generator slipped through: a bare "confirm editing works".
    expect(directive).toContain("confirm editing works");
    // The rule generalized fine in one measured generation and not in another: with worked
    // examples only for `widget.*`, a recipe reproduced those two verbatim and left the group
    // check bare ("confirm only the MCQ and cloze groups are visible") — the worthless shape, on
    // the one key with no example. So question_type_groups gets its own, and the closing sentence
    // says the shape applies to keys with no example rather than naming a list to match against.
    expect(directive).toContain("list overrides (`question_type_groups`)");
    expect(directive).toContain("if both runs look identical, the key changed nothing");
  });

  // All three came from an implementer building against a generated recipe on 2026-08-12. Each was
  // stated confidently and wrongly, and the first was stated under a [verified] marking — which is
  // why the marking convention itself now demands naming the run behind it.
  test("init() argument order is the documented one, and the wrong one is named", () => {
    expect(directive).toContain("init(initializationOptions, domSelector, callbacks)");
    expect(directive).toContain('NEVER `init(initObject, callbacks, "<element>")`');
    expect(instructions).toContain("init(initializationOptions, domSelector, callbacks)");
  });

  test("request.user is an object, and a design with only user-id still needs one built", () => {
    expect(directive).toContain("`request.user` is an OBJECT");
    expect(instructions).toContain("must be provided and be an object");
    expect(instructions).toContain("user = { id, firstname?, lastname?, email? }");
  });

  test("ready is not proof of load — errorListener can fire after it", () => {
    expect(directive).toContain("proves INIT ONLY");
    expect(instructions).toContain("can fire AFTER `readyListener`");
    // The check that actually catches a broken editor.
    expect(directive).toContain("The requested item/activity loads");
    // NOT a specific code. Two implementers observed 10000 and 40003 for the same scenario on
    // 2026-08-12, both direct browser observations, so the rule keys on the PHASE instead. An
    // earlier version of this test pinned "error 10000" and would now be enforcing one of two
    // contradictory readings as though it were settled.
    expect(instructions).toContain("treat any post-ready error as content-load");
    expect(instructions).toContain("10000");
    expect(instructions).toContain("Match on the PHASE, not the code");
  });

  // Round three, 2026-08-12: gaps found building container-and-settings. None made the recipe
  // wrong; each made a mandated check impossible to satisfy or a required value impossible to look up.
  test("the paths map is carried in the prompt and reproduced in the recipe", () => {
    expect(directive).toContain("<COMPILED_PATHS>");
    expect(directive).toContain("must REPRODUCE that map");
  });

  test("a differential against a key set to its own default is uninformative, not failing", () => {
    expect(directive).toContain("structurally uninformative");
    expect(directive).toContain("identical by construction");
    // The escape: prove it by setting the NON-default value instead.
    expect(directive).toContain("NON-default value");
  });

  test("inert-unless-precondition keys and host-page obligations are named", () => {
    expect(instructions).toContain("enable scrolling for long content");
    expect(directive).toContain("host-page obligations");
    expect(instructions).toContain("tall enough");
  });

  test("a present-but-nonexistent reference fails identically to an omitted one", () => {
    expect(directive).toContain("present but names nothing");
    expect(directive).toContain("confirm the named item exists in that bank");
  });

  // 2026-11-24: in item-edit a new reference creates a draft, so existence is blocking only when
  // the design's purpose is editing existing content.
  test("item existence is conditional on the intent to edit existing content", () => {
    expect(directive).toContain("WHEN THE INTENT IS TO EDIT AN EXISTING item/activity");
    expect(directive).toContain("a new reference creates a new draft item");
    expect(directive).toContain("check that an empty draft opens instead");
    expect(instructions).toContain("a new reference is how a new draft item is created");
  });

  // Round two of implementer feedback, 2026-08-12. The first three defects made the recipe wrong;
  // these three made it incomplete in ways that cost the reader a detour into the SDK source.
  test("the SDK's return value is passed through, not reassembled flat", () => {
    expect(directive).toContain("RETURNS the complete");
    expect(directive).toContain("options nested under `request`");
    expect(instructions).toContain("do not rebuild it");
    // The wrong guess is natural because the docs read as flat — say so, or the rule looks arbitrary.
    expect(directive).toContain("natural wrong guess");
  });

  test("the types that bite are stated", () => {
    expect(directive).toContain("integer");
    expect(instructions).toContain("must be an **integer**");
  });

  test("error events carry code and message, not name", () => {
    expect(directive).toContain("not `name`");
    expect(instructions).toContain("does **not** reliably carry `e.name`");
    // Phase labelling is what made a post-ready 10000 legible in the field.
    expect(directive).toContain("WHICH PHASE");
  });

  // Round four, 2026-08-12: gaps found building groups-math-templates. The theme is that good
  // epistemics without a mechanism still leaves the reader stuck — and that a hedge is not a fix.
  test("design-complete is separated from operationally ready", () => {
    expect(directive).toContain('Never write "no holes, nothing left to do');
    expect(directive).toContain("still unverified before this can work");
  });

  test("a default-valued check is REPLACED, not caveated, and cannot-fail steps are banned", () => {
    expect(directive).toContain("replace the step, do not caveat it");
    expect(directive).toContain("A step that cannot fail is not a check");
    // The rule must generalize past the two keys it was first written for.
    expect(directive).toContain("every defaulted key");
    expect(directive).toContain("require_validation");
  });

  test("UI checks name an observable anchor", () => {
    expect(directive).toContain("Name the observable anchor");
    expect(instructions).toContain("li.qtGroup");
    expect(instructions).toContain(".lrn-author-widget-drag-wrapper");
    // The selector that produced a false pass on an empty editor.
    expect(instructions).toContain("EMPTY-STATE chrome");
  });

  test("existence checks name the mechanism that answers them", () => {
    expect(directive).toContain("Diagnosis without a mechanism is half a step");
    expect(instructions).toContain("itembank/items");
  });

  test("checks that cannot run unattended are marked", () => {
    expect(directive).toContain("cannot run unattended");
    expect(directive).toContain("Mark manual-only");
  });

  // Round five, 2026-08-12/13. The first of these cost a live item: the document's only danger
  // marker protected the automation harness while the steps drove the real editor and saved.
  test("write hazards are named and pointed at a scratch item", () => {
    expect(directive).toContain("Name what a step can persist");
    expect(directive).toContain("throwaway item or a duplicate");
    expect(instructions).toContain("can WRITE to the item bank");
  });

  test("the signature covers serialization, and 41003 is not always the domain", () => {
    expect(directive).toContain("serialized request");
    expect(directive).toContain("preserve key order end to end");
    expect(directive).toContain("does not always mean the domain is wrong");
    // The stack-specific tripwires that make this invisible in Node and immediate in Python.
    expect(instructions).toContain("JSON_SORT_KEYS");
  });

  test("a step must be able to pass as well as fail, in THIS mount", () => {
    expect(directive).toContain("neither is one that cannot pass");
    expect(instructions).toContain("no list to return to");
  });

  test("a verified mechanism is not a verified deployment", () => {
    expect(directive).toContain('"Verified mechanism" means the MECHANISM works');
    expect(directive).toContain("permission to skip a differential");
  });

  // Round six, 2026-08-13. Two factual corrections and three about emphasis: the core mechanics
  // held under every differential the implementer ran; the failures were all at the edges.
  test("the tamper check names 41003, and where to tamper", () => {
    expect(directive).toContain("**41003**");
    expect(directive).toContain("after the `$02$` prefix");
    expect(instructions).toContain("41001 vs 41003");
  });

  // Corrected 2026-11-24: the earlier text called 457fe101-… an account-specific id. It is the
  // documented default reference of "Cloze with text", the same for every consumer.
  test("template references are Learnosity's published defaults, not account-specific", () => {
    expect(instructions).toContain("Learnosity's published defaults, the same for every consumer");
    expect(instructions).toContain("457fe101-0667-4a35-b193-b849653acb52");
    expect(instructions).not.toContain("ACCOUNT-SPECIFIC UUID");
  });

  test("what can block the whole task leads the document", () => {
    expect(directive).toContain("## Blocking preconditions");
    expect(directive).toContain("Emphasis must match consequence");
  });

  test("stack-specific hazards are labelled so the wrong-stack reader can skip them", () => {
    expect(directive).toContain("[Python/Flask]");
    expect(directive).toContain("neutral invariant unlabelled");
  });

  test("an inert key is named as a design problem, not just left untested", () => {
    expect(directive).toContain("recommend removing it");
    expect(directive).toContain("name it inert");
  });

  test("the Goal states intent, never an accomplished restriction", () => {
    expect(directive).toContain("intent pending observation");
    expect(directive).toContain("permission to skip a differential");
  });

  test("gotchas mandate the two silent failures", () => {
    expect(directive).toContain("fails open on"); // unrecognized config key is ignored
    expect(directive).toContain("versioned script URL 404s"); // blank page, neither callback fires
  });

  test("widget permissions point at the real path, not widget_templates", () => {
    expect(instructions).toContain("config.item_edit.widget.edit");
    expect(directive).toContain("widget_templates");
    expect(directive).toContain("supported by nothing");
    // Verified differentially on an item with two widgets, so the recipe may assert them.
    expect(instructions).toContain("Widget edit/delete permissions [verified]");
  });
});

describe("instructions.md keeps the canonical knowledge honest", () => {
  // 2026-08-13: two of 23 corpus prompts hit the same boundary, in opposite directions — the scope
  // gate rejected "List activities with titles, references and status, 15 per page" as a data
  // query, and the generator answered "only show published and unpublished activities" with
  // `filter { status: { in: [...] } }`, a FETCH expression that compiled. Configuring what an
  // embedded browser renders reads like data retrieval and is not.
  test("a list request is view configuration, not a data query", () => {
    expect(instructions).toContain("never a data query");
    expect(instructions).toContain("it does not fetch rows");
    const scope = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../spec/scope.json", import.meta.url)), "utf-8"),
    );
    expect(scope.in_scope.join(" ")).toContain("CONFIGURING AN EMBEDDED BROWSER VIEW");
    expect(scope.out_of_scope.join(" ")).toContain("WHO consumes the result");
  });

  test("the restriction mechanism is recorded as documented, with its group references", () => {
    expect(instructions).toContain("`group_defaults: false` plus explicit groups [verified");
    expect(instructions).not.toContain("MECHANISM VERIFIED");
    expect(instructions).toContain("question_type_groups");
    // Every default group reference is named, so a design's groups can be checked against them.
    for (const g of ["mcq", "cloze", "match", "writespeak", "highlight",
      "math", "graph", "chart", "chemistry", "other"]) {
      expect(instructions).toContain(`\`${g}\``);
    }
  });

  test("the widget permission measurements are recorded", () => {
    expect(instructions).toContain("Widget edit/delete permissions [verified]");
    expect(instructions).toContain("control (no widget config)");
  });

  test("the additive-reference trap is written down, with its measurements", () => {
    expect(instructions).toContain("ADDS");
    expect(instructions).toContain("restricts nothing");
    // The differential table is the evidence; without it the claim is just an assertion.
    expect(instructions).toContain("control (nothing set)");
  });

  test("fail-open semantics are recorded — the root cause of the bad recipe", () => {
    expect(instructions).toContain("FAILS OPEN");
  });
});

describe("the directive actually ships", () => {
  test("build-static copies spec-directive.md into the served bundle", () => {
    // build-static.js copies under an existsSync() guard, so a rename or deletion would silently
    // stop publishing the directive rather than failing the build.
    const buildStatic = readFileSync(
      fileURLToPath(new URL("../tools/build-static.js", import.meta.url)),
      "utf-8",
    );
    expect(buildStatic).toContain("spec-directive.md");
  });
});
