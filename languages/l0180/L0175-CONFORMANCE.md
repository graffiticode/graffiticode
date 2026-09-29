<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0180 interaction coverage: the QTI ontology and the L0175 requirement set

The design record for what L0180's interactions are and why. Written down here because it
was living in unversioned planning notes (`~/.claude/plans/`) and in one uncommitted file in
another repo — neither survives a machine.

Sources folded in: `let-s-design-the-language-rustling-heron.md` (2026-08-31, the original
requirement set and milestones) and the implementation session of 2026-09-01, which changed
two of its conclusions. Where they disagree, this file is right.

---

## 1. Two languages, one direction

**L0175 is a content language.** It composes SBAC-grounded Grade-5 ELA material — a passage,
claims, evidence, error-typed distractors, stems — and *selects* foils by plausibility. Its
pedagogy is a data table (`targets.ts`): seven learning targets, each with its own
dimensions, error taxonomy, standards and task-model numbering.

**L0180 is an assessment language.** It authors and delivers the item that results. Agents
author in L0180 directly, with or without L0175-composed content upstream.

The bar: **anything an L0175 spec describes must be expressible in L0180 and must score
identically.** None of L0175's content machinery is ported — not the claims graph, not
`plausibility()`, not the error taxonomies. Only the delivered shapes are L0180's problem.

Task model and item type are separate axes in L0175, which is what makes this tractable:
`tm3` is short-text in T4/T11, `ebsr` in T9/T2, and hot-text in T1/T8/T10. The pedagogy
stays put. Five interaction shapes cross over.

**The reverse direction is out of scope.** An L0180 item carries no claims, evidence, error
types or task models, so it cannot round-trip back. L0175 stays the system of record: "edit
the item" means edit it there and regenerate, never patch the L0180 side.

---

## 2. Why QTI's ontology, and why none of L0160's code

L0180's `interaction`/`validation` split *is* QTI's `itemBody` vs response-declaration split.
Naming it that way is deliberate, and the vocabulary comes from L0160, the platform's earlier
QTI language (`l0160/packages/api/spec/usage-guide.md` has the element list and the
kebab/camelCase alias table).

**We took L0160's vocabulary and none of its implementation.** The reason is recorded in
`l0160/CLAUDE.md`: despite the QTI authoring surface, its compiler emits *Learnosity* —
`QTI_ASSESSMENT_ITEM` converts the QTI tree into Learnosity questions and POSTs them to the
Data API. `cardinality`, `baseType`, `match_correct` and `templateRef` appear only in its
spec prose; `QTI_MAPPING` is a stub returning an unused shape. So the naming is real and
reusable, and the response-processing semantics had to be built from the QTI spec rather than
ported. `l0160/PLATFORM-NEUTRAL-ASSESSMENT.md` (2026-08-30) records the catalog gap that
prompted all of this — a routing eval where a generic "make me a quiz" produced nine
no-calls across nine runs, correct behaviour against a catalog with no general assessment
language.

The mapping as built:

| QTI | L0180 compiled field |
| :-- | :-- |
| `itemBody` | `interaction` |
| `maxChoices` / `minChoices` / `shuffle` | same names. `shuffle` DIVERGES on its default: QTI's is false, L0180's is true, because a fixed option order is a scoring artifact and an author who wants one can say so |
| `cardinality` | `interaction.cardinality` — derived from `maxChoices`, never authored |
| `responseProcessing` template | `validation.responseProcessing` |
| `mapping` / `mapEntry` | `validation.mapping` |
| `mapping@upper-bound` | `validation.upperBound` |
| `correctResponse` | `validation.correctResponse` |
| feedback keyed by identifier | `validation.feedback` |
| `outcomeDeclaration` SCORE | `validation.points` |

`correctResponse` and `mapping` are alternatives in QTI and stay alternatives here: one
template, one shape, no field whose meaning depends on another field's presence.

QTI 3.0 XML export remains future work, but the compiled shape now carries QTI's own field
names, so an exporter is a serializer rather than a translation.

---

## 3. The requirement set

| # | Requirement | Owner | State |
| :-- | :--- | :--- | :--- |
| R1 | Single-select, N options, one correct | choice | **done** `dbcbb79` |
| R2 | Multi-select with exact-set scoring — all correct and nothing else, or zero | choice | **done** `634938f` |
| R3 | Multi-part item, conjunctive scoring — every part right for one point | item | **done** `dbcbb79` |
| R4 | Stimulus — a passage with addressable paragraphs/lines | item | **done** `dbcbb79` |
| R5 | Hottext, sentence granularity, selected within the stimulus | hottext | **done** |
| R6 | Hottext, word granularity, single selection | hottext | **done** |
| R7 | Select exactly N from a valid superset | hottext | **done** |
| R8 | Rubric-scored constructed response, not auto-scored | extended-text | **done** |
| R9 | Per-option rationale carried through to delivery | choice | **done** `634938f` |

**R1–R9 are complete.** Every L0175 item type is expressible and scores identically:
`multiple-choice`, `multi-select`, `ebsr`, all three `hot-text` shapes, and `short-text`.

What "scores identically" means for `short-text` is that L0180 does *not* score it either —
L0175's scope.json puts auto-scoring of written responses explicitly out of scope, and the
conformance case asserts the response comes back pending rather than marked.

### Two conclusions the original design got wrong

**R2 was never a conflict.** It was recorded as one — L0180 scoring multi-select per-option
was thought to be a *better* model that L0175's all-or-nothing contradicted, so one had to
give. Under QTI's ontology they are simply its two standard response-processing templates:
per-option points is `map_response`, all-or-nothing is `match_correct`. The language names
which is in force. Nothing was given up, and this is the clearest argument for having taken
the ontology at all.

**R7 belongs to hot text, not to choice.** The requirement list does not say so, and it reads
like a multi-select feature. L0175 computes `selectCount` two different ways: for hot text
it is `Math.min(HOT_TEXT_SELECT_MAX, valid - 1)` (`l0175/packages/core/src/compiler.ts:1210`)
— a genuine N-from-a-superset; for choice it is `options.filter(o => o.correct).length`
(`:932`, `:1038`, `:1051`), a presentation hint that `min-choices`/`max-choices` already
expresses. Choice needs no superset concept.

R7 was also recorded as "does not fit the current model". It does: QTI's
`mapping@upper-bound` caps a mapped score, so five valid identifiers worth 1 each with
`upper-bound 3` means any three reach the ceiling and a wrong pick cannot.

---

## 4. The interactions

### `hottext` — R5, R6, R7 — built

One container with a `granularity` word, as designed. Authors mark units by `quote`; the
compiler resolves them against the segmented passage. `upper-bound` is R7 — QTI's
`mapping@upper-bound` — and defaults so it is rarely written: with C correct selections it
defaults to their total, and `min-choices`/`max-choices` default to the count, so "click the
sentence" needs no numbers at all.

Four things came out different from the plan or from L0175, each for a reason:

1. **Two-phase resolution was forced, not chosen.** Children transform before parents, so
   `HOTTEXT` cannot see the stimulus. A `within "stimulus"` interaction emits a `pending`
   sibling that `ITEM` completes; `PROG` rejects one that survives. `hottext.ts` exists as a
   plain module because both phases call it.
2. **The passage renders once.** L0175 renders it twice — read-only in a "Passage" tab and
   clickable in the item — which works only because they are tabs. L0180 is inline, so
   `HottextPassage` takes the stimulus slot and `HottextPrompt` the part slot.
3. **No stopword fallback.** L0175 makes every content word over two characters clickable when
   the author curates no candidates. L0180 requires a `selections` list, so the clickable words
   are exactly the authored ones — and the language carries no stopword list.
4. **A quote that matches nothing, or matches twice, is an error.** L0175 warns and composes
   on, because it is selecting from a superset it generated. An L0180 author naming a sentence
   that is not in the passage has written a broken item. The message names the nearest sentence
   by edit distance.

Two fixes to the ported segmentation, both because a unit here is something a candidate clicks
rather than something a matcher tolerates:

- L0175's regex keeps only runs ending in `.!?`, so an unterminated final sentence is dropped
  silently. Here the remainder is kept.
- It splits `"Stop!" she called.` in two, leaving `"Stop!"` as its own clickable sentence.
  L0175 calls that acceptable; in the Grade-5 literary prose T4 and T2 use, dialogue is
  constant. A run starting lowercase is a continuation, so it rejoins.

### `extended-text` — R8 — built

`responseProcessing: "human"`, a `rubric` of at least two bands, and an optional `exemplar`.
The item is worth its top band. Built as designed; three things are worth knowing.

1. **`human` is not `points: 0`.** An unscored poll has nothing to earn; this has points nobody
   has awarded yet. `Score.pending` is the difference, and collapsing them would tell a
   candidate they scored zero on work no one has read. An item holding a written part reports
   its other parts' points, flags `pending`, and is never `correct`.
2. **`conjunctive` refuses a written part** at compile time — "every part correct" is
   undecidable over one — so it belongs in an additive item, where the rest still scores. The
   scorer handles `pending` under conjunctive anyway rather than reporting a confident zero.
3. **The renderer keeps local state**, uniquely. Every other interaction is fully controlled,
   which is cheap because a click is discrete; a textarea reporting each keystroke would
   recompile per character. The draft commits on blur, and a ref guards the effect that adopts
   an externally changed response so a fresh compile cannot clobber live typing.

### The schema, now that parts are heterogeneous

`itemInteraction.parts` was `allOf: [choiceInteraction]` — an item could only hold choice
parts, and a new part type failed the schema gate before anything else. It is now a `oneOf`
union, and `choiceValidation` became **`responseValidation`**, shared by every interaction:
a key is `responseProcessing` plus identifiers, and nothing in it is choice-specific. A third
interaction adds one `$defs` entry and two union members, and touches no validation shape.

---

## 5. Verification

**`conformance.test.ts` is the gate.** It compiles a program per L0175 delivered shape and
asserts the scorer against L0175's own `SCORING` map
(`l0175/packages/core/src/compiler.ts:1257-1263`), on **behaviour rather than shape**. It
also asserts that `hottext` and `extended-text` are absent from the lexicon, so it fails the
day either lands and asks for its cases.

**Assert on scoring, never on text.** L0175's own `assertCoverage` substring-matches `STR`
literals ≥16 chars against the spec. It cannot see structure, answer keys or ordering, and it
catches elision but never hallucination — an EBSR item collapsed into a single choice reports
full coverage because every string survived. Treat it as an elision alarm only.

**The round-trip harness is `packages/core/tools/roundtrip/`.** `conformance.test.ts` proves
L0180 *can* express each shape — it compiles programs a person wrote. This asks whether a
GENERATED one scores the same, over five real L0175 items (T8 multiple-choice, T9 multi-select,
T4 EBSR, T8 hot text, T9 short text — every type in `SCORING`, across three passages).

Three steps, separate because only the middle one needs the platform:

| | |
|---|---|
| `npm run roundtrip:fixtures` | compile the five examples with L0175's own compiler into `fixtures/*.l0175.json` |
| `npm run roundtrip:prompts` | print the item in English — passage, stems, options, key, scoring rule |
| `npm run roundtrip` | compile `generated/*.gc`, score both sides, report per type |

The generation between them is whatever produced `generated/<example>.gc` — `create_item("0180", …)`
over MCP, the console, or a person — and the programs are committed, with `generated/index.json`
recording the item id and the language the platform routed each request to. A regression then
reads as a diff of what the generator did, next to what it now scores.

**Responses are semantic and the expectation is L0175's.** L0175 keys `A`, `B`, `C`; L0180
derives its own ids and a generator may order the options differently, so a case says "pick the
option that reads like this" and `compare.ts` aligns by normalized text — which is also how
content loss becomes visible rather than a comparison that quietly skips. The expected score is
L0175's rule, not L0180's output: one point, all or nothing. The battery is therefore mostly
near-misses — a subset, a superset, one part of two — because that is where per-option scoring
and all-or-nothing come apart. An additive EBSR out of 2 that pays 1 for half passes every shape
check and fails here.

**The prompt is composed from L0175's compiled item, not from `get_spec`.** This is the one
departure from the design note above, and §6 is the reason: `get_spec` describes L0175's
unparsed claims-and-evidence superset, so a round trip through it measures that gap rather than
this repo's fidelity. Composing from the compiled item isolates the question L0180 can answer —
given a faithful description, does the generated program score the way L0175 says.

**`compare.test.ts` gates it offline**, with the fixtures committed so it needs neither the
sibling repo nor a network. `port.ts` builds the mechanical L0180 program for each fixture and
all five score identically; four negative controls prove the comparison bites — an additive
EBSR, per-option credit on an exact-set part, a dropped option, a dropped passage, and a
short-text delivered as an auto-scored blank.

### What the first run found (2026-09-04)

**Four of five round trips score identically**, on the first generation, with no retries. The
EBSR came back conjunctive; the multi-select and the hot text both came back
`response-processing "match-correct"` with the choice counts set; the hot text used
`within "stimulus"` and quoted three sentences. Every option aligned — 4/4, 6/6, 8/8, 8/8.

**The fifth still does not reach L0180, and the failure has changed shape rather than closing.** `create_item("0180", …)` for the short-text item was
re-routed by the platform to **L0175**, which returned a claims-and-evidence program. The prompt
is a passage plus a written-response question and a rubric — the shape L0175 authors — so the
composer read it as content to compose rather than an item to deliver. Nothing about L0180's
expressiveness is implicated: `conformance.test.ts` scores that same shape as an `extended-text`,
and `port.ts` does it mechanically. It is a routing failure, reported as `ROUTED` rather than as
a compile error so nobody goes looking in the compiler, and it belongs with the other open
items in §6.

Retested on 2026-09-05, once the console catalog had learned about the newer interaction types:
the request now **stays on L0180** and is refused at the scope gate rather than re-routed, with a
message that argues against itself — *"This request doesn't fit any available Graffiticode
language. This is a written-response assessment item with a rubric for hand-scoring, which is
explicitly in scope for L0180's extended-text interaction type."* The verdict contradicts its own
rationale, so the gate votes against what it has just described. This shape has therefore never
made it through the hand-off; what moved is which way it breaks, and both ways are the console's
routing rather than anything here.

---

## 6. Open on the L0175 side

Not this repo's work, and it only affects the MCP hand-off path, not authoring L0180
directly:

- **L0175 has no `spec/spec-directive.md`**, so `get_spec` describes its *unparsed source* —
  the claims-and-evidence superset with its distractor pools — rather than the composed item.
  A faithful hand-off needs the stem, the options in order, and which is correct.
  `l0177/packages/core/spec/spec-directive.md` is the precedent, guarded by its own
  `spec-directive.test.ts`.
- **Derived values never reach spec generation.** L0175 computes no `paths` map, so the
  compiler's distractor selection and answer key are invisible to the spec — exactly what
  L0177's directive calls "the one thing source cannot carry".
- Consider raising L0175's `spec` tier in `console/src/lib/model-priority.ts`; it defaults to
  fast/Haiku, and `console/CLAUDE.md` advises raising it for a dialect whose spec asks for
  more than verbalizing the content.
- **A delivery request for a written response routes to L0175, not here.** The round trip's
  short-text prompt — a passage, a question, a rubric — asked for 0180 and came back an L0175
  program (§5). Content-shaped input is being read as a request to author content, where it was
  a request to deliver an item somebody already authored. The routing corpus is in
  `graffiticode-mcp-server`, not in either language.

## 7. Out of scope

`inline-choice`, `order`, `match`, `associate`, `gap-match`, `hotspot`, `slider` — no L0175
driver. (`text-entry` has since been built, for the general catalog rather than for conformance:
the routing eval's other open refusal was a cloze item. It is not part of the L0175 set.) The `responseProcessing` dispatch makes each additive rather than
a refactor. Item metadata (standards, DOK, grade) likewise: an L0175 spec carries alignment,
but nothing in delivery reads it.
