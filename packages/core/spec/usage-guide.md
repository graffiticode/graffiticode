<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0176 Usage Guide

Agent-facing guide for authoring Learnosity-compatible assessment items through L0176. Read this before composing a `create_item` prompt or an `update_item` modification.

## Overview

L0176 is an authoring language for Learnosity-compatible assessment items. Input is a natural-language description of a single item (or a small group sharing a stimulus); output is a Learnosity item JSON with a stem, one or more interactions, validation rules, scoring, and optional metadata tags. L0176 is the right tool when the job is "produce one assessment item"; it is not an activity-builder, a delivery engine, or a host-app integration surface.

When composing a request, name the item type explicitly ("multiple choice", "cloze with dropdowns", "short-text", "math fill-in", "order the list", "classification", "token highlight") if it is known — the language has a fixed catalog of interactions and guessing costs a round-trip. Include the stem, the correct answer, any distractors, and the scoring model (exact match, partial credit, manual rubric). For a math fill-in, say which property of the answer must match — its exact form, any equivalent form, or just its value — and name every distinct expression you want accepted; notation (`1/2` vs `\frac{1}{2}`) never needs spelling out. If the *shape* of the answer matters, say so in words — "in scientific notation", "as a mixed number", "to two decimal places", "a whole number" — and say whether the value must also be right, since checking the form and checking the value are separate rules. Describe shared context — a reading passage, an image, a diagram — only once; the backend will attach it to grouped items.

In scope: item authoring, item- and question-level metadata, row-by-row variants from a dynamic data table, and embedding other Graffiticode interactions as questions. Out of scope: activity-level assembly, delivery configuration, learner-side analytics, and host-app embedding — those belong downstream of this language and are handled by the Learnosity Items/Activities APIs or by the host app that renders the compiled JSON.

Item-level metadata (tags, difficulty, DOK) and question-level metadata (per-distractor rationale, acknowledgements) are supported via a `metadata` block at the relevant level — describe tags, difficulty, and per-option rationale in plain English and L0176 attaches them to the right level automatically.

## Item Types

L0176 emits one of the following interactions per question. Use the English cue when you know what you want — it removes ambiguity for the backend.

| Type key          | Natural-language cues                                               | When to use                                                                 |
|-------------------|----------------------------------------------------------------------|------------------------------------------------------------------------------|
| `mcq`             | "multiple choice", "MCQ", "pick one", "select the best answer"      | Single correct answer (or multi-select with `multiple-responses`) from a list. |
| `shorttext`       | "short text", "short response", "fill in one word"                  | One-line typed answer with exact-match validation.                          |
| `longtext`        | "essay", "long response with rich text"                             | Rubric-scored long-form response with formatting.                           |
| `plaintext`       | "plain-text essay", "open-ended response"                           | Rubric-scored long-form response without formatting.                        |
| `clozetext`       | "fill in the blank", "cloze with typed answers"                     | Inline blanks filled by typing; one or more blanks per stem. Say so if an answer runs long — blanks cap typed input at 15 characters unless raised. |
| `clozeassociation`| "drag and drop into blanks", "drag the correct term into the gap"   | Inline blanks filled by dragging from a bank of choices.                    |
| `clozedropdown`   | "dropdowns in the sentence", "cloze with dropdown selectors"        | Inline blanks filled by selecting from a per-blank dropdown.                |
| `clozeformula`    | "math fill-in", "cloze with a formula answer"                       | Inline blank that accepts a math expression, scored by comparing expressions — say which property must match (see Math equivalence). |
| `choicematrix`    | "grid", "rate each statement", "true/false matrix"                  | 2D grid: rows are stems, columns are options; one selection per row, or several with multiple responses. |
| `orderlist`       | "order these", "put in order", "sequence"                           | Drag items into the correct sequence.                                       |
| `classification`  | "sort into categories", "bucket these items"                        | Drag items into named category buckets.                                     |
| `bowtie`          | "bow-tie", "NGN", "NCLEX bow-tie", "actions, condition, monitor"    | NGN/NCLEX bow-tie: pick 2 actions, 1 condition, 2 parameters to monitor.    |
| `token-highlight` | "token highlight", "hot text", "highlight the words", "click the verbs", "select the words in the text" | Click words, sentences or paragraphs in a passage. Say which parts are correct and how the passage should be split. |
| `custom`          | "spreadsheet question", "use this spreadsheet", "embed an L0179 widget", "concept web question", "embed an L0183 web", "embed a Graffiticode interaction" | Embed a separately deployed Graffiticode-language interaction as the question — most commonly an L0179 spreadsheet. The interaction's content can be authored inline or read from an upstream pipeline task (see Pipeline Composition). |

No `hotspot` or `image-label` interaction today; describe those as MCQ over labeled positions if you must.

## Vocabulary Cues

Say this to get that:

- **Stem** — the prompt text the learner reads ("write the stem as…").
- **Distractors** — incorrect options in an MCQ; request "distractors that match common misconceptions" rather than just "wrong answers".
- **Valid response** — the correct answer(s). For MCQ each option carries a value of your choosing, and the correct answer names those values.
- **Rubric / manual scoring** — `longtext` and `plaintext` are always manually scored. Say how many points the essay is worth, and name the rubric if the host already has one — L0176 records its reference; it does not author the rubric itself.
- **Exact match / partial credit** — picks the scoring model; default is exact match. Ask for "partial credit" (or "score each correct answer separately") on a multi-select MCQ, choice matrix, cloze, order list, classification, or token-highlight item and L0176 sets a partial-match scoring type, awarding a fraction of the point per correct response instead of requiring every response to be right. Say "score each position against its neighbours" on an order list for pairwise scoring, which that type alone supports. Single-answer types are all-or-nothing and reject anything else.
- **Math equivalence (`clozeformula` only)** — a math answer is compared as an *expression*, never as text, so notation is always free: `1/2`, `1 / 2`, and `\frac{1}{2}` are the same answer under every method. What you choose is which property is compared. Say "must match this form" for a syntactic comparison (the default), "accept any equivalent form" / "however they write it" for symbolic equivalence, "any answer with the same value" for numeric value, or "the answer must be simplified" when simplifying is the skill. To accept several *different* expressions — "1/2, 0.5, or 2/4" — list them; L0176 emits each as a Learnosity alternate. Only genuinely different expressions need listing. You can also ask for a property rather than an answer — "the response must be expanded", "must be factorised" — which scores the form of the response with no answer to compare against.
- **Answer form (`clozeformula`)** — separate from equivalence: it constrains how the answer is *written*, not what it equals. Say "in scientific notation", "as a decimal", "as a fraction", "as a mixed number", "a whole number", "to two decimal places", or "give a variable". Nine forms are available — number, integer, decimal, scientific, variable, fraction, simple fraction, mixed fraction, and fraction-or-decimal — and the first four also take a digit count. A form check accepts *any* response of that shape, right or wrong, so if the value matters too, say both ("the right value, written in scientific notation") and L0176 emits two rules on the blank.
- **Tolerance (`clozeformula`)** — "within 0.05", "give or take", "plus or minus", "anything between X and Y" widen what counts as the right *value*, and are written into the answer as `7.07±0.05`. Distinct from "to N decimal places", which rounds before comparing rather than widening the range.
- **Alternate/synonym answers** — when a blank should accept genuinely different answers (synonyms, alternate phrasings, or genuinely equivalent expressions in clozeformula), say "also accept", "accepts X or Y", "alternate correct answer", or "synonym answer". L0176 emits each alternate scored the same as the primary. Available on every scored type; each alternate is a *complete* answer set — one answer per blank — rather than an extra answer for a single blank.
- **Shared stimulus** — a passage, image, or diagram attached once to a group of items. Describe it once at the top of the request.
- **Tags / standards** — NGSS, CCSS, Bloom's level — mention them by their conventional names (e.g., "NGSS MS-LS1-2", "CCSS 6.NS.A.1") and L0176 attaches them at the item level so the Learnosity Author Site can filter on them.
- **Difficulty / DOK** — a difficulty word ("medium", "hard") and a Depth of Knowledge level (the integer 1–4) become item-level tags. Ask for a "difficulty level of N" only when you mean the Author Site's integer Difficulty level field, which is a separate calibration.
- **Distractor rationale** — for MCQ, ask for "a one-line rationale per distractor" or "explain why each wrong answer is wrong". L0176 attaches these at the question level, one per response, where the Author Site review pane shows them alongside the item. Note the Questions API renders nothing for them at delivery: the data is in the question, and a host that wants to show learners a rationale has to render it itself.
- **Instant feedback** — turns on immediate per-response feedback in the interaction. Say "add a check answer button", "let students check their work", "show a check button", or "submit for feedback" and L0176 emits `instant-feedback true`.
- **Shuffle options** — randomizes option order at render time.
- **Save to the item bank** — by default an item renders as a preview and is *not* written to the Learnosity item bank. Say "save to the item bank" (or equivalent) to persist it; it lands as `status: unpublished` (draft). The write happens only when the compile runs with a Learnosity connection selected; without one the save is skipped (reported as `skipped: "no-connection"`) and the preview still renders. Publishing is done from the Learnosity Author Site UI, not from the DSL.
- **Bow-tie (NGN/NCLEX)** — three source pools and three drop zones in a 2-1-2 layout. Standard NCLEX phrasing is "actions to take", "condition most likely", "parameters to monitor". Prompt with the clinical scenario as the stimulus, a titled pool of options per zone, and which options are correct. Nothing validates the result — say what the drop zones are and check the rendered question, because a mis-numbered answer will not be caught.
- **Token highlight (also called "hot text")** — the learner clicks words, sentences or paragraphs in a passage. Provide the passage and say which parts are correct, and whether the passage should be split by word, sentence or paragraph, or into a specific set of clickable phrases. Say "they may pick at most N" to cap selections. Works for tasks like "click every verb" or "highlight the supporting evidence".
- **Embedded interaction (custom question)** — when the item should render an interaction authored in another Graffiticode language (e.g. an L0179 spreadsheet or an L0183 concept web), say "embed the L0179 spreadsheet" or "use this spreadsheet as the question". Name the language by its number (`L0179`, `L0167`, …). Provide the stem and any framing prose; the deployed interaction handles its own rendering and scoring.

## Pipeline Composition

L0176 items can read content from an upstream task in the console pipeline. The most common case is a `custom` question backed by an L0179 spreadsheet: the L0179 task produces the sheet's authored state, and the L0176 item embeds that state as the question's `data` by passing the base-language `data` primitive to `model`. Two equivalent forms exist: `data use "<lang>"` (preferred) declares the upstream language explicitly so the console can reactively generate and chain the upstream task; `data {default}` is the untyped fallback for manually wired chains. The pipeline editor wires the upstream task ID; L0176 source does not reference task IDs directly.

What you describe in the prompt:

- Which language to embed (e.g. "L0179 spreadsheet", "L0183 concept web").
- The stem and framing — "use the spreadsheet below to compute the column totals", etc.
- Whether the item is preview-only or persisted to the bank.

What happens automatically:

- L0176 emits a `custom` question with `lang` set to the embedded language and `model data use "<lang>"` reading the upstream value. The `use` annotation lets the console discover the upstream language and chain it; without an upstream bound, `data` falls back to `{}` so the item still renders for preview.
- Scoring is delegated to the deployed interaction's own scorer; do not request `valid-response` for embedded interactions.
- `save-to-itembank` produces a snapshot. Persisted items capture the upstream content at compile time and do not update when the upstream is later edited. If the user wants live updates from the upstream, keep the item in preview mode rather than persisting.

A single L0176 program has at most one upstream. Distinct upstreams per question require distinct L0176 programs.

## Dynamic Data

Learnosity supports a per-activity table of variable values. Each session draws one row and substitutes the columns into question text via `{{colname}}` placeholders. L0176 reaches this two ways:

- **Inherited** — an embedded L0179 custom question whose compiled output includes `templateVariablesRecords` (L0179's range expansion of `params { … }`) automatically flows through to the item's dynamic content. Authors do nothing extra; reference variables in stems with `{{A1}}`-style placeholders.
- **Hardwired** — declare the table directly with `params`, written in the `items` list beside the items: `items [ params [{ A1: "50", A2: "25" } { A1: "100", A2: "75" }] item [...] ] {}`. Use this when there is no upstream L0179 widget but the question still needs row-by-row variation. Describe it as "a table of values" or "a different pair of numbers each time", and say which values vary.

When both are present, the inherited table wins — embedded L0179 widgets are authoritative about their own variables.

## Metadata

L0176 attaches metadata at two levels.

**Item-level metadata** is what the Learnosity Author Site indexes for search and filtering. Standards tags (NGSS, CCSS, custom taxonomies), difficulty, and DOK go here. Mention them in the prompt and L0176 attaches them to the item record.

**Question-level metadata** travels with the individual interaction if it is reused. The headline field is per-distractor rationale on MCQ — when you ask for "a one-line rationale per distractor", L0176 emits these as question-level metadata that the Author Site shows in the review pane.

You usually do not need to think about which level is which — describe what you want in plain English and L0176 places the metadata at the level that makes it useful. Example: *"Create a 4-option MCQ on the function of mitochondria. Distractors should match common misconceptions, and add a one-line rationale per distractor explaining the misconception. Tag with NGSS MS-LS1-2, difficulty medium, DOK 2."* — produces an item with NGSS/difficulty/DOK at the item level and per-option rationale at the question level.

## Example Prompts

- *"Math fill-in: solve 2x + 3 = 11 for x. Accept any equivalent form of the answer."* → `clozeformula` with an `equivSymbolic` rule
- *"Write a cloze item with three dropdowns about the stages of mitosis in order: prophase, metaphase, anaphase. Show the stem above a sentence with blanks."* → `clozedropdown`
- *"Short-text item asking students to define 'allele' in one sentence. Exact match on 'a variant of a gene'."* → `shorttext`
- *"Given this passage about photosynthesis, write three related MCQs sharing the passage as a stimulus. Each should target a different depth-of-knowledge level."* → three `mcq` items grouped under one stimulus
- *"Create an MCQ on the function of mitochondria with four options. Distractors should match common misconceptions, and add a one-line rationale per distractor. Tag with NGSS MS-LS1-2, difficulty medium, DOK 2."* → `mcq` with item-level NGSS/difficulty/DOK tags and question-level per-option rationale
- *"Update item-id <X>: change the stem to be shorter and clearer, but keep all the existing tags and rationale."* → preserves both metadata blocks; only the stem changes
- *"Create a spreadsheet question. Embed the L0179 spreadsheet as the interaction. Stem: 'Use the spreadsheet below to compute the column totals for the first quarter.' "* → `custom` with `lang "0179"` reading the upstream sheet via `data use "0179"`; preview by default, no `valid-response` (the L0179 scorer handles scoring).

## Out of Scope

- **Activity-level assembly** — stringing items into a timed test, sections, or branching. Belongs in Learnosity Activities API.
- **Delivery configuration** — proctoring, time limits, attempt caps, accommodations at delivery time.
- **Learner-side analytics** — response data, mastery, reporting. Served by Learnosity Data / Reports APIs after items have been delivered.
- **Host-app embedding** — mounting the rendered item inside a React app, Canvas LTI, etc. Handled by the host runtime, not by this language surface. See the L0176 docs site for integration guidance.
- **Raw Learnosity JSON** — L0176 authors items in natural language and emits Learnosity JSON; requests for hand-written JSON patches should go to a lower-level tool, not here.
