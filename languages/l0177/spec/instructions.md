<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Dialect L0177 — Learnosity Author API integration (recipe oracle)

L0177 does **not** author item content (that is L0176). The client describes an *integration design* — which Learnosity **Author API** authoring experience to embed in their app, and how it's configured. L0177 validates the design, flags **holes** (missing required properties) as steering warnings, and — via `get_spec` — returns an **implementation recipe with verification steps**.

## Program shape (uniform grammar)

A program is one `author-embed` head with a chain of property functions and exactly one **view** function, terminated with `{}` then `..`:

```
author-embed
  domain "lms.example.edu"
  user-id "u123"
  reference "algebra-item-1"
  organisation-id 100
  question-type-groups [MCQ CLOZE]
  allow-widgets [MCQ CLOZE-TEXT]
  item-edit [
    item back true scoring true reference-prefix "LEAR_" {}
    widget edit true delete false {}
  ]
  {}..
```

Uniform rules:
- **Every property is a lowercase-kebab arity-2 function** — `name value` — that chains; a chain ends with `{}`.
- **Members** (`item`, `widget`, `settings`, `filter-restricted`, `toolbar`) are arity-1: they take a property chain (`item back true … {}`).
- **Views** and **sections** are arity-2. A **view** takes a `[list]` of members.
- **A bare property chain inside a view's list sets that view's own options** — `limit 25 {}` is not a member, it sets `config.item_list.limit`. Members configure a node *inside* the view; a bare chain configures the view itself. **Terminate it with `{}` before the next member**: `[limit 25 filter-restricted … ]` makes `limit` swallow the member as its continuation, and the compiler warns that `limit` would be dropped. Write `[limit 25 {} filter-restricted … {}]`.
- **Widget-type values are UPPERCASE-kebab tags** (`MCQ`, `CLOZE-TEXT`), never quoted strings.
- **Content tags are records**, written the way Learnosity receives them:
  `[{type: "Grade", name: "4"} {type: "Subject", name: ["Math" "Science"]} {type: "Course"}]`.
  `type` is required; `name` takes one string or several, and omitting it matches every name of
  that type. A tag missing its `type` is dropped and any other key is stripped — under fail-open
  semantics a misspelt key would otherwise ride along and silently narrow nothing.
- **Some values are records**, mirroring Learnosity's payload — content tags above, and
  `item-banks [{organisation_id: 100, item_bank_name: "Math", item_pool_id: "p1"}]` for
  multiple item-bank sources. Record keys use Learnosity's own spelling; a key outside the
  schema is stripped with a warning.
- **Smart defaults**: everything is optional; `item {}` is a fully-defaulted item. Write only what you change.

## The view selects the mode (one per program)

There is no in-UI view switching, so the view you use *is* the mode:
- `item-edit [ … ]` — the **Item editor** (create/edit one item). Needs a `reference`.
- `item-list [ … ]` — the **Item browser/list**.
- `activity-edit [ … ]` — the **Activity editor**. `reference` optional.
- `activity-list [ … ]` — the **Activity browser/list**.

All four are modeled: a member or property a view doesn't define is dropped with a warning,
never passed through.

**A list request is a VIEW CONFIGURATION, never a data query.** "List activities with titles,
references and status, 15 per page", "only show items tagged Subject: Math", "show authors only
their own published items" all describe what an embedded Learnosity browser should RENDER — they
are answered with `item-list` / `activity-list` and that view's own options (`limit`, `status`,
`title-show`, `title-show-reference`, `filter-restricted` …), never with a query, a `filter`
expression, or a `FETCH`. The phrasing overlaps with data retrieval on purpose — that is how people
describe a list — but this dialect configures a UI, it does not fetch rows. A program that emits a
query expression instead of an `author-embed` head is wrong even if it parses: two such requests
were measured on 2026-08-13, one rejected as out of scope and one answered with
`filter { status: { in: [...] } }`, which compiled and would have entered the corpus as training
data teaching the same mistake.

**Members are view-scoped, and so are their properties.** A member the view doesn't accept is
**dropped with a warning** — Learnosity ignores it in that mode. Don't attach `widget`/`settings` to a
browser view: an item browser has no widgets to edit or delete.

The subtler rule: `item` names a **different Learnosity node in each view**, with a different field
set. `config.item_edit.item` and `config.item_list.item` share exactly one field name (`status`), and
that field is a boolean in one place and a list of strings in another. So a property is legal only in
the (view, member) context where Learnosity actually defines it:

| View | Member | Properties |
| :--- | :----- | :--------- |
| `item-edit` | `item` | **panes/behaviour:** `answers` `back` `columns` `dynamic-content` `dynamic-image-tag` `enable-audio-recording` `scoring` `shared-passage` `status` `tabs` `actions-show` `popup-content-enable` `math-hints-generation-enable` · **reference:** `reference-show` `reference-edit` · `reference-prefix`(str) · **title:** `title-show` `title-edit` `title-mandatory` · **tags:** `tags-show` `tags-edit` · **save:** `save-show` `save-persist` · `save-restricted-tags-all` `save-restricted-tags-either`(tag list) · `save-restricted-tags-allow-save` · **duplicate:** `duplicate-show` `duplicate-shared-passages` · **editor mode:** `mode-show` · `mode-default`(`"edit"`\|`"preview"`) · **metadata pane** (each an independent show/edit pair): `details-acknowledgements-*` `details-description-*` `details-difficulty-*` `details-note-*` `details-scoring-type-*` `details-source-*` `details-status-*` |
| `item-edit` | *(view-level)* | `tags-on-create`(tag list) |
| `item-edit` | `widget` | `edit` `delete` |
| `item-edit` | `settings` | `show` `full-height` |
| `item-list` | `item` | `url`(str, must contain `:reference`) · `enable-selection` · `status` · `title-show` `title-show-reference` |
| `item-list` | `filter-restricted` | `current-user`(bool) · `created-by`(list of str) · `status`(list of `"published"`/`"unpublished"`/`"archived"`) · `tags-all` `tags-either` `tags-none`(tag list) · `allow-filtered-tags-overwrite`(bool) |
| `item-list` | `toolbar` | `toolbar-add` `search-show` `search-status` `search-tags-show` `search-widget-type` (bool) · `search-controls`(list of str) |
| `item-list` | *(view-level)* | `limit`(num, 1–50) |
| `activity-edit` | `item` | `add-show` `edit-allow` `status-show` `title-show` `title-show-reference` `custom-points-toggle-show` `custom-points-toggle-default-checked` |
| `activity-edit` | `item-search` | `show` `back` `sort` `limit` · `title-show` `title-show-reference` · `filter-restricted-current-user` · `filter-restricted-created-by`(str list) · `filter-restricted-tags-all` `filter-restricted-tags-either` `filter-restricted-tags-none`(tag list) · `item-banks`(record list) · `toolbar-search-show` · `toolbar-search-controls`(str list) |
| `activity-edit` | `player-playback` | `show` · and `show`/`edit` pairs for `distractor-rationale-*` `distractor-rationale-response-level-*` `scroll-to-top-*` `scrolling-indicator-*` `shuffle-items-*` `skip-submit-confirmation-*` `submit-criteria-*` `warning-on-change-*` `show-acknowledgements-*` |
| `activity-edit` | `player-time` | `show` · `show`/`edit` pairs for `auto-save-*` `idle-timeout-*` `limit-type-*` `warning-time-*` · `reading-mode-goto-first-item-on-reading-time-completion-show` |
| `activity-edit` | `player-administration` | `show` · `show`/`edit` pairs for `show-exit-*` `show-extend-*` `show-save-*` |
| `activity-edit` | `player-text` `player-scoring` `duplicate` `title` | small panes — `show`, `edit`, `mandatory`, `font-size-*`, `client-side-scoring`, `deep-copy`, `duplicate-shared-passages` |
| `activity-edit` | `activity-edit-save` | `show` `persist` `restricted-tags-allow-save`(bool) · `restricted-tags-all` `restricted-tags-either`(tag list) |
| `activity-list` | `filter-restricted` | `current-user`(bool) · `created-by`(str list) · `status`(str list of `"published"`/`"unpublished"`/`"archived"`) · `tags-all` `tags-either` `tags-none`(tag list) |
| `activity-list` | `toolbar` | `toolbar-add` `add-adaptive` `add-branching` `add-random` `search` (bool) |
| `activity-list` | *(view-level)* | `full-activity-json` `status` `title-show` `title-show-reference` (bool) · `limit`(num) |
| `activity-edit` | *(view-level)* | `tags-on-create`(tag list) · `back` `details` `source` `status-show` `mode-show` · `mode-default`(`"edit"`/`"preview"`) · `reference-show` `reference-edit` · `tags-show` `tags-edit` · `description-show` `description-edit` · `difficulty-show` `difficulty-edit` · `adaptive-fields-show` `annotations-enable` `reporting-enable` `override-labels-enable` `customize-presets-enable` `resource-item-show` `player-template-builder-show` `intro-item-default-checked` `outro-item-default-checked` `activity-preview-item-reference-show` · `default-player-template`(str) · `enabled-player-templates`(str list) · `activity-edit-settings` |

Names repeat across views on purpose, because they mirror Learnosity's own. `title-show` is
`config.item_edit.item.title.show` in one view and `config.item_list.item.title.show` in another;
`status` is a boolean at `activity-list`'s view level but a list of states under its
`filter-restricted`. Always read the resolved path from `data.paths` rather than inferring it
from the name.

Writing an item-edit property into an item-list `item` — `item-list [ item back true {} ]` — is
**dropped with a warning**, not passed through, and so is the converse. Emitting `config.item_list.item.back` would produce a
key Learnosity silently ignores, which under fail-open semantics is worse than an error.

**Four keywords mirror more of their Learnosity path than the others.** A keyword carries one
meaning across the whole dialect, so where a bare leaf name is already taken, the name simply
elides less of its path. Nothing is invented:

| Keyword | Learnosity path | Why not the bare name |
| :------ | :-------------- | :-------------------- |
| `filter-restricted` | `config.item_list.filter.restricted` | `filter` is L0000's list function |
| `toolbar-add` | `config.item_list.toolbar.add` | `add` is L0000's arithmetic function |
| `activity-edit-save` | `config.activity_edit.save` | `save` is a `widget-templates` property |
| `activity-edit-settings` | `config.activity_edit.settings` | `settings` is an `item-edit` member |

Note this means `toolbar-add` appears inside the `toolbar` member, which reads redundantly but
keeps every keyword decodable on its own.

**`activity-edit` is the deepest view**, so its members are cut where Learnosity panes the UI: the
player settings split into `player-playback`, `player-time`, `player-administration`, `player-text`
and `player-scoring`, while small nodes stay view-level rather than becoming one-property members.
Segments below the member flatten into the property name as everywhere else, which is why
`reading-mode-goto-first-item-on-reading-time-completion-show` is as long as it is — that is
Learnosity's own segment name, not our flattening.

## Property functions

**Top-level** (in the `author-embed` chain):
- **`domain`** (string, required) — the host serving the editor; the signature binds to it.
- **`user-id`** (string, required) — the author's stable id (recorded in the item-bank audit trail). Also `user-email`, `user-firstname`, `user-lastname` (optional).
- **`reference`** (string) — the item/activity to edit (required for `item-edit`).
- **`organisation-id`** (number) — which item bank to load from.
- **The question picker** is limited by up to three properties. Each one present narrows the same
  set of documented default templates, and the compiler emits ONE restriction from them:
  `group_defaults: false` plus `question_type_groups` naming only the groups left, each with explicit
  `template_references`. Read both paths from `data.paths` and the result from
  `data.question_type_groups` / `data.picker_templates`.
  - **`question-type-groups`** (list of group **tags**: `MCQ`, `CLOZE`, `MATCH`, `WRITE-SPEAK`,
    `HIGHLIGHT`, `MATH`, `GRAPH`, `CHART`, `CHEMISTRY`, `OTHER`) — every documented template in
    those groups.
  - **`allow-widgets`** (list of question-type **tags**) — every documented template of those
    types. One type can have several templates: `MCQ` brings standard, multiple response, true or
    false, and block layout.
  - **`allow-templates`** (list of template **tags**, e.g. `MCQ-STANDARD`, `CLOZE-DROPDOWN`) —
    exactly those templates. A type with one default template uses its widget tag; a type with
    several has one tag per template (`MCQ-STANDARD`, `MCQ-MULTIPLE-RESPONSE`, `TRUE-OR-FALSE`,
    `MCQ-BLOCK-LAYOUT`, `CHOICE-MATRIX-STANDARD|INLINE|LABELS`,
    `GRAPH-PLOTTING-STANDARD|FIRST-QUADRANT`, `BAR-CHART`, `LINE-CHART`, `HISTOGRAM`, `DOT-PLOT`,
    `LINE-PLOT`).

  A restriction that leaves no template (`question-type-groups []`, `allow-widgets [FORMULA]` — a
  type with no default template — or `allow-widgets [SHORT-TEXT] question-type-groups [MCQ]`) is a
  design **hole**, and no picker config is emitted: an empty group set would fail open (below).

**Members**: see the view-scoped table above — a member's legal properties depend on the view it
appears in, and so does the type of a shared name like `status`.

**Sections** (arity-2, top level): `container` (`height`, `fixed-footer-height` numbers; `scroll-into-view-selector` string); `widget-templates` (`back`, `save`, `require-validation` booleans); `global` (`disable-onbeforeunload` boolean).

**Widget-type tags** (the DSL authoring values; each maps to Learnosity's lowercase type string — lowercase, hyphens removed): `MCQ, SHORT-TEXT, LONG-TEXT, PLAIN-TEXT, CLOZE-TEXT, CLOZE-ASSOCIATION, CLOZE-DROPDOWN, CLOZE-FORMULA, CLOZE-INLINE-TEXT, CHOICE-MATRIX, CLASSIFICATION, ORDER-LIST, SORT-LIST, FORMULA, GRAPH-PLOTTING, HIGHLIGHT-TEXT, HOTSPOT, TOKEN-HIGHLIGHT, NUMBER-LINE, ASSOCIATION, FILL-IN-THE-BLANKS, IMAGE-CLOZE-ASSOCIATION, IMAGE-CLOZE-TEXT`.

Map the client's request to the right view and set the properties they gave. **Do not invent `domain`, `user-id`, or `reference`** — omit them and the compiler flags them as design holes for the client to supply.

## Warnings are repair signals

The compiler returns `data.warnings` — imperative, specific steering hints. **Design holes (missing required properties) come first**; once filled, specificity advisories (restrict widget types, pick an item bank) surface. The client reads them and refines the design (via `update_item`) until it's complete. (A truly-unknown property is a parse error, not a warning — every valid property is a function.)

## `data.paths` gives the exact config paths — use them verbatim

The compiler also returns `data.paths`: a map from every config key the design set to its **exact
Learnosity path**, e.g. `"config.item.reference-prefix"` → `"config.item_edit.item.reference.prefix"`.
A design's kebab names are deliberately ambiguous about nesting (`title-show` is `title.show`, but
`enable-selection` is `enable_selection`), so **never derive a path from a key name — read it from
`data.paths`**. A key absent from `paths` was dropped and must not appear in the recipe at all. This
is the channel by which the recipe names config paths without guessing, which matters precisely
because the API fails open: a wrong path looks identical to a right one in a running editor.

## Canonical Learnosity Author API knowledge (the recipe draws on this)

### Evidence and verification contract

- **[documented]**: an expectation from the published reference, not a live observation.
- **[schema-confirmed]**: an identifier or structure checked against a published schema, not a behavioral test.
- **[verified] / empirically observed**: the specific behavior was exercised end to end in the stated environment. This label does not cover the entire endpoint or every supported option.
- **Verified in this deployment**: the caller actually ran the relevant checks in their deployment. Neither compilation nor a complete design establishes this.

For each measured claim, record the behavior and inputs exercised, the procedure and meaningful control where applicable, expected and observed outcomes, date, environment, API/SDK versions, and limits. Link an existing experiment record when available. If provenance is missing, say so; do not invent it or promote a documentation claim. Keep modeled coverage separate from empirical coverage. Generated recipes must preserve the evidence behind consequential claims and the checks still required of the caller.


Facts below marked **[verified]** were confirmed against the live Author API (v1.144.0) using
Learnosity's public demo consumer on `localhost`. Schema-confirmed names and paths establish structure, not behavior. Anything without a live observation must retain its documented or schema-confirmed status; do not present it as behavior verified in the caller's deployment.

- **Script tag [verified]:** load the Author API from the **bare host** — `<script src="https://authorapi.learnosity.com"></script>`. It defines the global `LearnosityAuthor`. Do **not** invent a versioned file path: `https://authorapi.learnosity.com/latest/authorapi.js` **404s**, `LearnosityAuthor` is then undefined, `init()` never runs, and *neither callback fires* — a silently blank page.
- **Init — CORRECTED 2026-08-12.** Server-side, build a signed request, then call
  `LearnosityAuthor.init(initializationOptions, domSelector, callbacks)` — the documented order.
  Learnosity's own demo repo also uses the two-argument form `init(initObject, callbacks)`, where
  the target element is defaulted. **Never `init(initObject, callbacks, "<element>")`**: that puts
  the callbacks object in the selector slot, so neither listener is ever registered, and you get
  exactly the silent blank editor described in the bullet above — the failure mode hardest to
  trace, produced by the guidance meant to prevent it. This bullet previously carried a
  **[verified]** marking while asserting that wrong order; an implementer running it in a browser,
  against the README and the demo repo, is what caught it. A marking is only as good as the run
  behind it: use **[verified]** only for something exercised end to end, and say what exercised it.
- **`request.user` is an OBJECT and is required [verified — browser run, 2026-08-12].**
  `initObject = { security, request: { mode, reference?, config, user } }`, where
  `user = { id, firstname?, lastname?, email? }`. A bare `user_id` string — or no `user` at all —
  fails init with *"A user attribute must be provided and be an object when initializing the Author
  API"*. Build it from the design's `user-id`, and fill `firstname`/`lastname`/`email` from
  `user-firstname`/`user-lastname`/`user-email` when the design carries them: those feed the Author
  Site's audit trail, so a real deployment wants them even though init does not require them.
- **Signing is SDK-handled [verified]:** use the official Learnosity **server-side SDK** for your language (.NET / Java / Node.js / PHP / Python / Ruby) to generate the `security` object from your consumer key + secret. Do not hand-roll signing unless unavoidable.
- **⚠ The SDK RETURNS the whole init object; do not rebuild it [verified — implementer build,
  2026-08-12].** `sdk.init("author", security, secret, request)` returns
  `{ security, request: { mode, reference?, config, user, organisation_id } }` — the request
  options **nested under `request`**, not spread at the top level. That entire return value is what
  `LearnosityAuthor.init()` takes. This is the shape most likely to be got wrong, because
  Learnosity's own docs list `mode`/`reference`/`user` as "initialization options", which reads as a
  FLAT object; an implementer settled it only by reading the SDK's `index.js` and a demo `.php`.
  Assembling a flat object fails at init. Pass the SDK's return value through untouched.
- **Types are not forgiving [verified — implementer build, 2026-08-12]:** `organisation_id` must be
  an **integer**, not a numeric string, and `mode` must be the exact string for the view
  (`item_edit` / `item_list` / `activity_edit` / `activity_list`) — no other casing or spelling.
- **`security` [verified]** = `{ consumer_key, domain, timestamp (UTC, `YYYYMMDD-HHMM`), signature }`. The consumer **secret** signs the request but is **never** sent to the browser. `domain` MUST equal the host actually serving the page — a mismatch (or any tampered signature) yields Learnosity error **41003 "Signatures do not match"**. This is the **#1 cause of a failed init**.
- **`mode`** selects the view; there is no in-UI switch between the item/activity list/edit views — build a separate page/init per experience.

- **⚠ The Author API FAILS OPEN on config [verified].** An unrecognized `config` key is **silently ignored**: the editor still initializes, `readyListener` still fires, and the page looks correct — while enforcing nothing. A wrong config path therefore produces an authoring experience that *appears* restricted but is not. Never tell a client a restriction is in force unless they have observed it in the running editor.

- **Restricting what authors may add: `group_defaults: false` plus explicit groups [verified
  2026-11-24, search included — measurements below].** The picker is configured through
  `config.dependencies.question_editor_api.init_options` (Question Editor options passed through the
  Author API). The restriction is two keys there:
  - `group_defaults: false` — only the groups defined in `question_type_groups` are shown
    (help.learnosity.com 16735159465757). With the default `true`, `question_type_groups` EXTENDS the
    default groups instead.
  - `question_type_groups` — ONLY the wanted groups, each `{reference, name, template_references}`
    with the template references written out explicitly. The default group references are `mcq`,
    `cloze`, `match`, `writespeak`, `highlight`, `math`, `graph`, `chart`, `chemistry`, `other`.

  The template references are **Learnosity's published defaults, the same for every consumer**
  (help.learnosity.com 360000755178, "Customizing the Tile View With Author API", Default settings →
  Question templates, advanced layout mode, retrieved 2026-11-24 [documented]) — e.g. standard
  multiple choice `9e8149bd-e4d8-4dd6-a751-1a113a4b9163`, Cloze with drop down
  `2fbba51b-e35e-441f-83c7-2662e2e81fa6`, Cloze with text `457fe101-0667-4a35-b193-b849653acb52`. The
  simple layout mode uses a different set, which L0177 does not model. Copy every reference from
  `data.question_type_groups`; never retype one.

  Measured 2026-11-24 with the `init_options` L0177 compiles, signed by the official Node SDK 0.7.3
  for the public demo consumer on `localhost`, `item_edit` on a new draft reference, saving disabled
  (Author API v1.152.2, Question Editor v3.152.2, unpinned). Each run opened Add, counted visible
  `li.qtGroup` groups and `[data-lrn-qe-template-reference]` tiles, searched "essay", then submitted
  an empty search:

  | init config | groups | "essay" search | empty search |
  |---|---:|---|---|
  | control (no `init_options`) | 10 | 7 templates | 66 tiles |
  | `allow-templates [MCQ-STANDARD CLOZE-DROPDOWN] question-type-groups [MCQ CLOZE]` | 2 | none | 2 tiles: `9e8149bd-…`, `2fbba51b-…` |
  | `question-type-groups [MCQ CLOZE]` | 2 | none | 13 tiles, exactly the documented mcq + cloze references |
  | hand-built `group_defaults: false`, `question_type_groups: []` | 0 | — | 50 raw question types (fails open) |

  Limits: one consumer (the shared demo account), one API version, searches for "essay" and empty
  only, the picker only (not imported or stored item JSON, nor settings inside an allowed question).
  It shows the MECHANISM works; it does not show a caller's deployment has it in force — that is the
  caller's own differential (below).

- **⚠ Hiding groups is NOT a restriction — search bypasses it [observed 2026-11-24].** The previous
  L0177 mechanism overrode all ten default groups, omitting `template_references` on the kept ones
  and setting `[]` on the rest, under the default `group_defaults: true`. That removes **sidebar
  tiles only**. Observed with the public demo consumer on `localhost`: the sidebar showed only
  Multiple Choice and Cloze, but **searching "essay" listed seven essay templates from the hidden
  groups**, and an empty search listed a broad catalogue. The hidden templates are still in the
  catalogue that search reads. These earlier measurements (Author API v1.144.0, demo consumer)
  counted SIDEBAR groups and tiles only, and say nothing about search:

  | init config | sidebar groups | sidebar templates |
  |---|---:|---:|
  | control (nothing set) | 10 | 51 |
  | `init_options.widgetTypes` | 10 | 51 |
  | `question_type_groups`, **new** reference | 11 | 53 |
  | `question_type_groups`, override `mcq` with one reference | 10 | 45 |
  | `question_type_groups`, override `math` with `[]` | 9 | 44 |
  | override all ten, keeping `mcq` + `cloze` | 2 | 13 |

  Under `group_defaults: true` a **new** group reference ADDS a group — it restricts nothing — which is why an earlier
  investigation concluded the key did nothing: the config was in force and the picker looked
  untouched. Only comparing against a control distinguishes "ignored" from "additive".

- **⚠ An empty restriction FAILS OPEN [documented].** With `group_defaults: false` and no defined
  group matching any template, the picker shows no groups and lists the question types and default
  templates instead (360000755178, "Behavior with other init options") — the full catalogue. So
  never emit `group_defaults: false` with an empty or non-matching `question_type_groups`; the
  compiler refuses such a design as a hole.

- **Question types and templates are finer than groups, and both are restrictable.** A group holds
  several question types (`mcq` and `choicematrix` are both in Multiple Choice), and a question
  type can have several templates (`mcq` has four). Restricting by type means listing every
  documented template of that type; restricting to one template means listing only its reference.
  Both are ordinary `template_references`. The picker tile's `data-lrn-qe-template-reference`
  attribute shows a template's reference in the running editor, which is how to check that the
  catalogue holds exactly what was configured, and how to find a consumer's CUSTOM templates
  (`question_type_templates`), which the documented list does not include. Limits: a template
  restricts what an author can ADD from the picker. It is not server-side validation of stored or
  imported item JSON, and an allowed question's own settings (e.g. multiple responses on a
  standard MCQ) can still be changed in the question editor.

- **⚠ These do NOT restrict the picker [verified]:**
  `config.dependencies.question_editor_api.init_options.widgetTypes` (no effect; absent from the
  current reference) and `config.widget_templates.widget_types`, which is documented as
  `{default, show}` — which tile view opens and whether the type buttons show. It was never a
  restriction key, so testing it for restriction tested the wrong thing.

- **Widget-type name strings [schema-confirmed]:** the question `type` values below are
  Learnosity's exact strings — lowercase, except a `V2` suffix, which keeps its capital (confirmed in `schemas.learnosity.com` → `question_type_templates`,
  which is keyed by exactly these). They are correct as *question type* identifiers, which is a separate taxonomy from the
  picker groups that `question_type_groups` restricts. Copy them exactly — do NOT
  derive them, do NOT change their case, do NOT add underscores:

  | DSL tag | Learnosity question `type` value |
  |---|---|
  | `MCQ` | `mcq` |
  | `SHORT-TEXT` | `shorttext` |
  | `LONG-TEXT` | `longtext` |
  | `PLAIN-TEXT` | `plaintext` |
  | `CLOZE-TEXT` | `clozetext` |
  | `CLOZE-ASSOCIATION` | `clozeassociation` |
  | `CLOZE-DROPDOWN` | `clozedropdown` |
  | `CLOZE-FORMULA` | `clozeformula` |
  | `CLOZE-INLINE-TEXT` | `clozeinlinetext` |
  | `CHOICE-MATRIX` | `choicematrix` |
  | `CLASSIFICATION` | `classification` |
  | `ORDER-LIST` | `orderlist` |
  | `SORT-LIST` | `sortlist` |
  | `FORMULA` | `formula` |
  | `GRAPH-PLOTTING` | `graphplotting` |
  | `HIGHLIGHT-TEXT` | `highlighttext` |
  | `HOTSPOT` | `hotspot` |
  | `TOKEN-HIGHLIGHT` | `tokenhighlight` |
  | `NUMBER-LINE` | `numberline` |
  | `ASSOCIATION` | `association` |
  | `FILL-IN-THE-BLANKS` | `fillintheblanks` |
  | `IMAGE-CLOZE-ASSOCIATION` | `imageclozeassociation` |
  | `IMAGE-CLOZE-TEXT` | `imageclozetext` |
  | *added 2026-11-24 from the documented `question_type_templates` keys (help.learnosity.com 360000755178) [documented], not re-checked against the schema:* | |
  | `IMAGE-CLOZE-ASSOCIATION-V2` | `imageclozeassociationV2` |
  | `IMAGE-CLOZE-DROPDOWN` | `imageclozedropdown` |
  | `LONG-TEXT-V2` | `longtextV2` |
  | `AUDIO` · `VIDEO` · `DRAWING` | `audio` · `video` · `drawing` |
  | `SIMPLE-SHADING` | `simpleshading` |
  | `CLOZE-FORMULA-V2` | `clozeformulaV2` |
  | `IMAGE-CLOZE-FORMULA` · `IMAGE-CLOZE-FORMULA-V2` | `imageclozeformula` · `imageclozeformulaV2` |
  | `MULTI-STEP-MATH` | `multistepmath` |
  | `FORMULA-ESSAY-V2` | `formulaessayV2` |
  | `NUMBER-LINE-PLOT` | `numberlineplot` |
  | `SIMPLE-CHART` | `simplechart` |
  | `CHEMISTRY` · `CLOZE-CHEMISTRY` | `chemistry` · `clozechemistry` |
  | `CHEMISTRY-ESSAY-V2` · `IMAGE-CLOZE-CHEMISTRY` | `chemistryessayV2` · `imageclozechemistry` |
  | `FILE-UPLOAD` · `IMAGE-UPLOAD` · `RATING` · `GRIDDED` | `fileupload` · `imageupload` · `rating` · `gridded` |

  `LONG-TEXT`, `FORMULA`, `FILL-IN-THE-BLANKS`, `CLOZE-INLINE-TEXT`, `HIGHLIGHT-TEXT` and
  `IMAGE-CLOZE-ASSOCIATION` are valid question types with NO documented default picker template, so
  `allow-widgets` cannot offer them through the picker restriction (the compiler warns).

  Example: the design `allow-widgets [MCQ CLOZE-TEXT]` refers to the question types `mcq` and `clozetext` — **RIGHT**. Writing `MCQ`, `CLOZE_TEXT`, or `CLOZE-TEXT` as the Learnosity value is **WRONG**. (These are question TYPES. In the picker restriction they select every documented template of the type — see above.)
- **Widget edit/delete permissions [verified].** `config.item_edit.widget.edit` and
  `config.item_edit.widget.delete` (L0177's `widget` member) both work, and independently.
  Measured differentially on an item holding two widgets, counting per-widget affordances:

  | init config | Edit controls | Delete controls |
  |---|---:|---:|
  | control (no widget config) | 4 | 2 |
  | `widget.delete: false` | 4 | **0** |
  | `widget.edit: false` | **2** | 2 |

  (Two of the four Edit controls are the item-level Edit/Preview toggle, which neither key
  touches — `edit: false` removes exactly the two per-widget ones.) The recipe may state these
  as fact. Do **not** use `config.widget_templates.edit`/`.delete`; that path is supported by
  nothing.
- **41001 vs 41003 — a tampered signature can fail the WRONG way [implementer, 2026-08-13].** The
  signature is version-prefixed (`$02$…`). Corrupting a character in the PREFIX yields **41001**, a
  parameter-format complaint, not the **41003** signature mismatch. Both are 401-class, so a check
  written as "flip a character and confirm a 401" passes on 41001 while never exercising the signing
  path at all. Tamper inside the signature BODY, after the prefix, and assert on 41003 specifically.
- **⚠ The signature covers the SERIALIZED request [implementer, 2026-08-12].** Signing with the SDK
  is necessary and not sufficient: the payload must reach the browser byte-for-byte. Anything that
  re-serializes or reorders it between signing and `LearnosityAuthor.init()` invalidates the
  signature and yields **41003** — whose message names `security.domain`, so the API's own error
  text sends you to a domain that is already correct. Known tripwires: Flask's `jsonify` sorts keys
  by default (`JSON_SORT_KEYS`); Express's `res.json()` preserves insertion order, which is why the
  hazard is invisible in Node and immediate in Python. This is language-NEUTRAL as a rule (do not
  re-serialize; preserve key order end to end) with stack-specific ways to violate it.
- **⚠ Driving the editor can WRITE to the item bank [implementer, 2026-08-12].** The Author API
  verification steps are not read-only: exercising the widget Save path persists to the real item
  behind `reference`. Verification should run against a throwaway item or a duplicate, never the
  design's own reference. One implementer modified a live item following steps that never said so.
- **Keys that are inert unless a precondition holds.** `container.height` and
  `container.fixed-footer-height` do nothing unless the item has **"enable scrolling for long
  content"** turned on — a differential against an item without it shows no difference for reasons
  unrelated to the path. `fixed-footer-height` also presumes the host page really has a fixed footer
  of that height, and `scroll-into-view-selector` presumes that element exists and that the page is
  tall enough for the target's top edge to leave the viewport. These are host-page obligations, not
  properties of the integration.
- **Affordances a standalone mount does not have [implementer, 2026-08-12].** `item.back` renders no
  Back control in a standalone `item_edit` mount, because there is no list to return to — a
  differential on it produces nothing in either direction. Similarly, stock templates ship with
  `valid_response` populated, so an "unvalidated save" state is not reachable without destructive
  editing. Do not mandate a check for an affordance the view never renders.
- **Observable anchors [reported by an implementer, 2026-08-12 — not independently re-run].** A UI
  check needs something specific to look at, or it becomes "does it look right", which is exactly
  what fails open. Known anchors: the question-type picker's groups are `li.qtGroup`; an authored
  widget in the editor body is `.lrn-author-widget-drag-wrapper`. Do NOT invent a looser selector —
  `[class*="widget"]` matches Learnosity's own EMPTY-STATE chrome and will report a confident pass
  on an editor holding nothing, which is how one implementer's "did the item load?" check passed
  against a blank editor.
- **Confirming an item or activity EXISTS is not an Author API question [implementer, 2026-08-12].**
  The Author API gives no signal for it — a reference naming nothing initializes cleanly and renders
  empty. That matters only when the intent is to EDIT AN EXISTING item: in `item-edit`, a new
  reference is how a new draft item is created, so a reference naming nothing is valid there
  (observed 2026-11-24: a new draft reference opened the editor and the picker worked). The answer lives in the **Data API** `itembank/items` endpoint (a separate API, its own
  signed request). L0177 does not integrate the Data API and is not describing how to author items
  there; naming the endpoint that answers a precondition is a pointer, not a scope change.
- **Client-side wiring [verified]:** provide a `readyListener` (fires when initialized) and an `errorListener`; optionally `assetRequest` (your DAM) and `customButtons`. The error event carries
  **`e.code` and `e.message`**. It does **not** reliably carry `e.name` — that is `undefined` for
  both 41003 and 10000, and is only populated when `init()` throws a local `Error` [verified —
  implementer build, 2026-08-12]. Handle both shapes; do not instruct anyone to log `e.name` as
  though it were always present.
- **⚠ `errorListener` can fire AFTER `readyListener`, not instead of it [verified — browser run,
  2026-08-12].** They are not exclusive outcomes. Init and content-loading are separate phases: with
  an `organisation_id` the consumer cannot access, the editor initializes, `readyListener` fires,
  and only then does the content request fail. So **`readyListener` firing is evidence that init
  succeeded, and nothing more**. It is not evidence that the item or activity loaded, that the item
  bank was reachable, or that the design's `organisation-id` is valid. Any check that stops at
  "ready fired" passes on a broken editor.
  **Match on the PHASE, not the code.** Two implementers observed different codes for an
  inaccessible organisation on 2026-08-12 — one reported **10000**, the other **40003** — and both
  were direct browser observations, so neither is being discarded. The stable, actionable fact is
  the timing: an error arriving *after* ready is a content-load failure, whatever its number. A
  recipe should tell the reader to label the phase and treat any post-ready error as content-load,
  rather than to match one code. (A tampered signature, by contrast, reliably yields **41003**
  *during* init.)

### Gotchas and acceptance criteria
Both are stated in the canonical knowledge above and are the RECIPE's to render — the spec-directive
says what each section must carry. They were restated here and drifted: the copy still pinned error
10000 for an inaccessible organisation (two implementers observed different codes; the rule is now
to match on the phase) and still accepted "a 401-class error" for a tampered signature (which passes
on a 41001 prefix corruption without exercising the signing path). Two statements of one fact age
independently, so there is one.

OUT_OF_SCOPE: authoring item **content** (→ L0176); item-bank CRUD (Data API), assessment delivery (Items API) and analytics (Reports API) — each a separate sibling dialect, none built yet, and none a future mode of L0177; emitting runnable host-language code (the recipe is language-neutral).
