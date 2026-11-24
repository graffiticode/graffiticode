<!-- SPDX-License-Identifier: CC-BY-4.0 -->
You are given the source of a Learnosity **Author API** integration design (an `author-embed` program — a view function plus a chain of property functions) in this dialect, plus the dialect's canonical knowledge above. Produce a **developer integration RECIPE**: a precise, host-language-NEUTRAL procedure the caller implements in their own stack (Node, PHP, Ruby, .NET, …) to embed the described authoring experience.

This file states OUTPUT RULES. The FACTS — verified mechanisms, error codes, DOM anchors, traps — are in the canonical knowledge above; draw on them, do not wait for them to be repeated here.

### Evidence and verification contract

- **[documented]**: an expectation from the published reference, not a live observation.
- **[schema-confirmed]**: an identifier or structure checked against a published schema, not a behavioral test.
- **[verified] / empirically observed**: the specific behavior was exercised end to end in the stated environment. This label does not cover the entire endpoint or every supported option.
- **Verified in this deployment**: the caller actually ran the relevant checks in their deployment. Neither compilation nor a complete design establishes this.

For each measured claim, record the behavior and inputs exercised, the procedure and meaningful control where applicable, expected and observed outcomes, date, environment, API/SDK versions, and limits. Link an existing experiment record when available. If provenance is missing, say so; do not invent it or promote a documentation claim. Keep modeled coverage separate from empirical coverage. Generated recipes must preserve the evidence behind consequential claims and the checks still required of the caller.

Output these sections, in this order, as Markdown.

## Goal
One or two sentences: the authoring experience the developer will have working when done, specialized to the view and the design's specifics (mode, domain, user, reference, editor options, item bank).

- State only what the procedure achieves. **"Verified mechanism" means the MECHANISM works, never that THIS deployment has it in force** — a key can still be dropped, misplaced, or ignored under fail-open. Never write anything that reads as permission to skip a differential ("may be treated as fact once configured correctly").
- The widget `edit`/`delete` permissions are verified mechanisms and may be stated as intent the verification confirms. The question-picker restriction (`group_defaults: false` plus explicit groups and template references, from `question-type-groups`, `allow-widgets` and `allow-templates`) is a verified mechanism, measured with search included; state it as intent pending observation in THIS deployment, which the search-inclusive differential below must confirm — never as already in force.
- **If the design sets a key that can do nothing in the chosen view, say so here and recommend removing it** — name it inert, say which view it would apply in. Declining to test it is not enough; the reader would ship configuration they cannot justify.

## Blocking preconditions
Short, and first. ONLY what makes the whole task impossible if false — typically that the consumer can read the named organisation and, WHEN THE INTENT IS TO EDIT AN EXISTING item/activity, that it exists — each with its one-line check. In `item-edit` a new reference creates a new draft item; do not make existence blocking unless the design's purpose is editing existing content. Emphasis must match consequence: the fact that can end the task cannot sit where it is skimmed past.

## Preconditions
Consumer key + secret (secret **server-only**, never sent to the browser); the official server-side SDK; the serving domain; a stable author user id; the target element; and any **host-page obligations** the design implies (a real fixed footer for `fixed-footer-height`, an existing element for `scroll-into-view-selector`).

**Never write "no holes, nothing left to do."** A design with every required property present is COMPLETE AS A DESIGN and can still be operationally blocked. Give two statements: "the design is complete — no properties left to supply", then "still unverified before this can work: …" listing every precondition the integration cannot check for itself. If the design does have unfilled holes — the `<COMPILED_HOLES>` block lists them, when present — state each as "you must still provide: …". An unsatisfiable picker restriction is such a hole: say that no picker restriction can be configured until it is fixed, and never write one.

## Procedure
Numbered steps. SURGICALLY PRECISE where correctness is binary — `security` fields, the `YYYYMMDD-HHMM` UTC timestamp, the exact `mode` string, `domain` equal to the serving host, the BARE library host. ABSTRACT where it is the developer's choice (framework, HTTP, templating). Sign with the official SDK; never hand-roll. Describe only this construct's mode; note there is no in-UI view switching.

Three details are binary and have all been got wrong in practice — state them exactly:
- **Pass the SDK's return value through untouched.** `init("author", security, secret, request)` RETURNS the complete `{ security, request: { … } }`, options nested under `request`. Learnosity's docs list `mode`/`reference`/`user` as "initialization options", which reads as flat and is the natural wrong guess; assembling a flat object fails at init. Also: `organisation_id` is an **integer**, `mode` is the exact view string.
- **`LearnosityAuthor.init(initializationOptions, domSelector, callbacks)`**, or the two-argument `init(initObject, callbacks)`. **NEVER `init(initObject, callbacks, "<element>")`** — callbacks land in the selector slot, no listener registers, silent blank editor.
- **`request.user` is an OBJECT**: `user: { id: "…" }`, plus `firstname`/`lastname`/`email` when the design carries them. A bare `user_id` string fails init.

## Gotchas
The mistakes that cause silent failures or 401s for THIS experience: domain mismatch, secret leaking to the browser, timestamp skew, missing `errorListener`, an omitted or wrong `reference`. Always include:
- **The Author API fails open on `config`** — an unrecognized key is silently ignored while the editor initializes, `readyListener` fires, and the page looks correct enforcing nothing.
- **A versioned script URL 404s** — `LearnosityAuthor` undefined, `init()` never runs, NEITHER callback fires.
- **A `41003` does not always mean the domain is wrong** — it is also what a re-serialized or reordered request produces. Check serialization before re-checking a domain that is already correct.

## Verification steps
A runnable acceptance checklist against THEIR implementation. **Output a NUMBERED Markdown list — one check per line, each a single concrete pass/fail assertion.** Never a paragraph. Include at least one negative check. At minimum:

1. `readyListener` fires and the editor renders. State that this proves INIT ONLY — ready and error are not exclusive outcomes, and a content-load failure arrives AFTER ready. Never present it as evidence the editor works.
2. The requested item/activity loads, with nothing logged after ready. When the intent is to edit EXISTING content, phrase it as "confirm the named item exists in that bank and its content renders" — a `reference` that is present but names nothing fails identically to an absent one. When the reference is meant to be new, check that an empty draft opens instead.
3. A signature tampered **inside the body, after the `$02$` prefix** triggers `errorListener` with **41003** during init. Corrupting the prefix instead yields 41001, also 401-class — so "flip a character and confirm a 401" passes without exercising the signing path.
4. The init payload delivered to the browser contains no consumer secret.
5. The `domain` in `security` equals the host serving the page.

Then add checks specific to the design, under these rules:

- **Every check on config-driven behaviour must be DIFFERENTIAL** — against a control init with the key omitted — and must state what each outcome means. Because the API fails open, observing the desired behaviour proves nothing on its own. This applies to ENABLING keys too (`edit: true` passes a bare "confirm editing works" even when the key was dropped), to list overrides (`question_type_groups`), and to `organisation_id`. Shape: *"Load twice — once as configured, once with the key omitted. If X differs, the path is live; if both runs look identical, the key changed nothing."* Say what a control-only result establishes: against a demo consumer it demonstrates the mechanism, never the caller's own value.
- **A key set to its own DEFAULT cannot be checked this way — replace the step, do not caveat it.** The control is identical by construction, so the comparison is *structurally uninformative* and reporting it as a pass or as evidence of a broken path are both wrong. Replace with: load once at the NON-default value, once omitted; the affordance must differ. Applies to every defaulted key, e.g. `shared_passage`, `settings.show`, and `widget_templates` `back`/`save`/`require_validation`.
- **A step that cannot fail is not a check — and neither is one that cannot pass.** Before emitting a step, ask what a failing AND a passing run look like IN THIS MOUNT: does the affordance exist in this view at all, and is the state reachable without vandalising something? If not, redesign or drop it. A checklist whose steps cannot produce evidence manufactures confidence, which is what this dialect exists to prevent.
- **Say which interactions WRITE, and send them at a scratch item.** Driving the editor can persist to the item bank — exercising a save path, deleting a widget. Name what a step can persist and direct the reader to a throwaway item or a duplicate; the design's `reference` is what is being verified, not what to experiment on. A step that mutates state is more dangerous than one that hangs a script and must be marked at least as loudly.
- **Name the observable anchor** for anything visible (the canonical knowledge gives them) and say what its absence means. "Open the picker and confirm the groups" without a selector is unactionable, and a loose one produces false passes against empty-state chrome.
- **Name a precondition that makes a check meaningful** when one exists — several keys are inert unless something else is true.
- **Diagnosis without a mechanism is half a step.** When a precondition cannot be checked from inside the Author API, name what answers it (item existence: the Data API `itembank/items`, a separate signed request, a one-off — not part of the integration).
- **Mark manual-only** any check that cannot run unattended, such as one gated on a native browser modal.

## Rules throughout

- **Config paths come from the `<COMPILED_PATHS>` block and the recipe must REPRODUCE that map.** Copy verbatim into the config the developer writes. Never derive a path from a key name — the flattening is ambiguous (`title-show` → `title.show`, but `enable-selection` → `enable_selection`) and under fail-open a wrong path looks configured and is not. A key absent from that map was rejected by the compiler: leave it out entirely.
- **Question-type values**: the EXACT Learnosity strings (`mcq`, `clozetext`, `longtextV2`) — never the UPPERCASE DSL tags, never underscore forms.
- **The picker restriction is `group_defaults: false` plus ONLY the groups in the `<COMPILED_PICKER>` block's `question_type_groups`, each with its explicit `template_references`.** Emit both keys at the paths in `<COMPILED_PATHS>` and copy the group list verbatim (references are Learnosity's published defaults; never retype or derive one). Explain why `group_defaults: false` matters: with the default `true`, `question_type_groups` only EXTENDS the default groups, and hiding a group with `template_references: []` removes its sidebar tile while search still lists its templates (observed 2026-11-24). If there is no `<COMPILED_PICKER>` block, the design sets no picker restriction: write none. Never emit the old ten-group `[]` override, and never emit `group_defaults: false` with an empty group list — an empty restriction FAILS OPEN to the full catalogue.
- **Question types and templates ARE restrictable — through template references.** `allow-widgets` selects every documented template of each type (`mcq` has four); `allow-templates` selects exact templates. Name the templates the design offers (from `picker_templates` in `<COMPILED_PICKER>`) and say plainly when a type brings several. State the limit: this restricts what an author can ADD from the picker; it does not validate stored or imported item JSON, and an allowed question's settings can still be changed in the editor. Never invent a per-type config key such as `widgetTypes`.
- **A picker differential must include SEARCH.** Counting sidebar groups or tiles proves nothing: the hidden-group override passed that count while search exposed hidden templates. In BOTH the configured and the control run, (a) count `li.qtGroup` groups and the template tiles, (b) search for a question type the design does NOT allow (e.g. "essay" when essays are excluded) and (c) submit an empty search. Configured: only the offered templates appear in all three (compare each tile's `data-lrn-qe-template-reference` with the references in `<COMPILED_PICKER>`); control: the excluded type appears. Any excluded template appearing in the configured run means the restriction is NOT in force.
- **Never emit** `init_options.widgetTypes` or `config.widget_templates.widget_types` (neither restricts anything), or `config.widget_templates.edit`/`.delete` (supported by nothing).
- **Error events carry `code` and `message`, not `name`.** Direct the reader to log those and to label WHICH PHASE the error arrived in — init, or after ready — which is what makes a post-ready failure legible.
- **Label stack-specific hazards with the stack**, e.g. `[Python/Flask]`, so a reader on another stack skips them at a glance. State the neutral invariant unlabelled (the signature covers the serialized request: do not re-serialize, preserve key order end to end) and label only the stack-specific ways to violate it.
- Describe the procedure for the SPECIFIC view and properties present; do not cover views the design did not ask for.
- Do NOT emit runnable host-language code — describe the steps; the caller writes the code.
- Do NOT mention Graffiticode, this dialect, node tags, "the record", or that you are reading source.
- Output only the recipe. No preamble, no surrounding code fences.
