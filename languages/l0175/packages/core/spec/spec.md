<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0175 Vocabulary

_Revised: 2026-06-19_

**L0175** is a Graffiticode dialect for composing 5th-grade English Language Arts assessment
items (Smarter Balanced · Grade 5 · Claim 1). One language serves **multiple learning targets**,
selected by a required top-level `target`: `c1-t4` (Reasoning & Evidence, literary, RL standards),
`c1-t11` (Reasoning & Evidence, informational, RI standards), `c1-t9` (Central Ideas,
informational, RI-1/RI-2), `c1-t2` (Central Ideas, **literary**, RL-1/RL-2 — theme, and summary scoped to a key event),
`c1-t1` (Key Details, **literary**, RL-1 — the inference is given and the student selects
supporting evidence), `c1-t8` (Key Details, informational, RI-1/RI-7 — the inference is
given and the student selects supporting evidence), or `c1-t10` (Word Meanings, informational,
RI-4/L-4 — the meaning of a targeted word, options authored as `word`/`meaning`) — different
reading skills, each with its own dimensions, distractor taxonomy, DOK, item types, and stem
catalog. It is **item-first**: a
program declares its `target`, then authors the `outcome`s (questions) first — each with a unique
`id`, a `focus` naming its correct claim, and an explicit `stem` from that target's guideline
catalog — then the supported and distractor `claim`s (each distractor `targets` the question(s)
it foils) and the evidence `source`s for one passage. The compiler **composes** each outcome by
taking its `focus` claim, drawing that question's foils from the distractors that `targets` it,
and assembling a finished item (`ebsr`, `hot-text`, or `short-text`). It selects and validates
authored content against the target profile; it does not generate content or stems.

The core language specification (syntax, semantics, base library) is here:
[Graffiticode Language Specification](./graffiticode-language-spec.html)

## Authoring shape

A program is **one flat builder chain** ending in a single `{}..`:

```
target c1-t4
title "Optional assessment title"
passage "Heading"
type literary
lines [ "First paragraph…" "Second paragraph…" ]   /* one entry per paragraph */
claims [ claim ... {} claim ... {} ]
evidence [ source ... {} source ... {} ]
outcomes [ outcome ... {} outcome ... {} ]
{}..
```

Three function roles make up the idiom:

- **Attribute functions** are arity-2 `(value, continuation)` and merge one key into the
  record: `text "…" cont` → `{ ...cont, text: "…" }`. They are generic — the same `id`,
  `status`, `text`, `type` appear on several forms — and the element wrapper validates them in
  context.
- **Collection builders** (`claims`, `evidence`, `outcomes`, `rubric`) and the passage forms
  (`passage`, `type`, `lines`, `title`) are arity-2 and thread **one shared continuation**, so
  the whole top level is a single chain closed by **one** trailing `{}`.
- **Element wrappers** (`claim`, `source`, `outcome`, `band`) are arity-1; each element's own
  attribute chain is terminated by its **own** `{}` inside the list.

Free text (`text`, `rationale`, `subject`, `stem`, the passage heading) and id labels
(`id`, `focus`, `cites`, `supports`, `targets`) are **quoted strings**; closed-enum values
(`ebsr`, `character`, `misreads-detail`, `rl-1`, …) are **bare kebab-case identifiers**;
`line`, `score`, `plausibility`, and `grade` are **numbers**.

---

# Function reference

## Structural forms

| Form | Arity | Takes | Description |
| :--- | :---: | :--- | :--- |
| `target` | 2 | tag | Top level: the learning target — `c1-t4` (R&E literary, RL), `c1-t11` (R&E informational, RI), `c1-t9` (Central Ideas informational, RI-1/RI-2), `c1-t2` (Central Ideas literary, RL-1/RL-2), `c1-t1` (Key Details literary, RL-1 alone), `c1-t8` (Key Details informational, RI-1/RI-7), or `c1-t10` (Word Meanings informational, RI-4/L-4). Selects the valid dimensions/standards, distractor taxonomy, DOK, item types, and stem catalog. Always author one; defaults to `c1-t4` if omitted. |
| `title` | 2 | string | Optional assessment title; echoed on the composed output. |
| `grade` | 2 | number | Optional top-level reading-level target (e.g. `grade 5`). Defaults to the target/guideline's grade (5 for `c1-t4`/`c1-t11`); echoed on the output. The compiler estimates the passage's reading level and warns when it reads above this grade. |
| `passage` | 2 | string | Opens the stimulus; the value is the passage **heading**. Chains with `type` and `lines`. |
| `type` | 2 | tag | On the passage: `literary` \| `informational`. On an `outcome`: the item type `ebsr` \| `hot-text` \| `short-text` \| `multiple-choice` \| `multi-select`. |
| `lines` | 2 | string list | The passage **paragraphs** (one entry per paragraph by default), **auto-numbered from 1** (the numbers `source.line` refers to). Use finer units (sentences) only when a task needs them, e.g. click-the-sentence Hot Text. |
| `claims` | 2 | list | The collection of candidate `claim`s (the inference graph's nodes). |
| `claim` | 1 | chain | One candidate inference/conclusion statement — either the correct answer or a foil. |
| `evidence` | 2 | list | The collection of evidence `source`s. |
| `source` | 1 | chain | One passage line tagged by its support role. |
| `outcomes` | 2 | list | The collection of intended items. |
| `outcome` | 1 | chain | One item to compose; varying it projects the same pool into a different item. |
| `rubric` | 2 | band list | On a `short-text` outcome: the scoring `band`s (defaults to 0/1/2 if omitted). |
| `band` | 1 | chain | One rubric row (a `score` + a `descriptor`). |

## Identity & references

| Attribute | On | Value | Description |
| :--- | :--- | :--- | :--- |
| `id` | claim, source, outcome | string | Stable identifier. Claim/source ids are referenced by `cites` / `supports` / `focus`; an outcome's id is referenced by a distractor's `targets`. **Must be unique** within claims, within sources, and within outcomes (duplicates are a hard error). |
| `cites` | claim | id list | The evidence `source` ids this claim draws on. For the correct claim, the `directly-supports` members become Part B's correct option(s). |
| `supports` | source | id list | The claim ids this evidence backs — *truly* for the correct claim, or *temptingly* for a distractor claim. A source tied to both the correct claim and a foil is what makes a Part B option plausibly support more than one Part A option (the no-giveaway rule). |
| `focus` | outcome | id | **Required** — the supported claim that is this question's correct answer. |
| `targets` | distractor | id list | **Required on distractors** — the outcome id(s) of the question(s) this foil is authored against. Composition draws an item's foils only from the distractors that target it. |

`cites` / `supports` references that don't resolve produce a **warning** (the item still
composes). A `focus` that isn't a supported claim, or a `targets` to a missing outcome, is a
**hard error** — the binding is the contract.

## Claim content

| Attribute | Value | Req. | Description |
| :--- | :--- | :---: | :--- |
| `status` | tag | ✓ | `supported` (a valid inference — a candidate correct answer) or `distractor` (a foil). |
| `dimension` | tag | ✓ on supported | The inference target (`character`, `theme`, `point-of-view`, …). Required on supported claims (it must match the outcome); on distractors the binding is by `targets`, so it is not needed. |
| `text` | string | ✓ | The statement a student reads as an option. |
| `error-type` | tag | ✓ on distractor | Which student misconception the foil targets: `misreads-detail`, `erroneous-inference`, or `faulty-reasoning`. |
| `rationale` | string | ✓ on distractor | Why a student would plausibly choose this foil (the error it targets). Surfaced in the item's `distractorAnalysis`. |
| `targets` | id list | ✓ on distractor | The outcome id(s) this foil is authored against (see *Identity & references*). |
| `plausibility` | number 0–1 | — | Optional author override for how tempting the foil is. If omitted, the compiler computes a score from evidence overlap, structural parallelism, and error type, and uses it to pick the strongest foil per error type among those targeting the outcome. |
| `subject` | string | — | Who/what the claim is about (e.g. `"Mara"`, or a specific reference like `"Cortez's age"`); echoed in review metadata. |
| `standard` | tag | — | The companion RL standard the claim addresses; emitted on the item. |
| `dok` | tag | — | The claim's cognitive demand (`r-dok3`). |

## Evidence content

| Attribute | Value | Description |
| :--- | :--- | :--- |
| `status` | tag | The support role: `directly-supports` (real backing for its claim), `supports-wrong-claim` (real text that *seems* to back a foil), or `irrelevant` (off-point — a Part B distractor). |
| `line` | number | The numbered passage entry (a paragraph by default, 1-based) this source draws on. Must be within the passage (out-of-range → warning). |
| `quote` | string | A verbatim excerpt shown instead of the whole `line`. For EBSR Part B, set this to the exact supporting **sentence** (with `line` pointing at its paragraph) so options stay sentence-tight. |
| `supports` | id list | See *Identity & references* — the claim(s) this evidence backs. |
| `rationale` | string | Optional: why this line is a tempting-but-wrong Part B foil. If omitted, composition synthesizes one from the source's status. |

## Outcome & stem control

| Attribute | Value | Req. | Description |
| :--- | :--- | :---: | :--- |
| `id` | string | ✓ | Unique question id; distractors `targets` it. |
| `type` | tag | ✓ | The task model: `ebsr`, `hot-text`, `short-text`, `multiple-choice`, or `multi-select`. |
| `dimension` | tag | ✓ | The skill facet the item assesses (must match the focus claim's dimension). |
| `focus` | id \| id list | ✓ | The supported claim that is the correct answer; on `multi-select` a **list** of ids = the correct set (see *Identity & references*). |
| `stem` | string | ✓ | The Part A / single-question stem (or, for `short-text`, the prompt), authored from the guideline's Appropriate-Stem catalog (`stems.md`). |
| `stem-b` | string | ✓ on ebsr | The EBSR Part B stem, authored from the catalog. (Hot Text's Part B instruction is fixed; Short Text has no Part B.) |
| `subject` | string | — | The noun phrase the stem is about, e.g. `"Mara"` or `"the letter Cortez burned"`; echoed in review metadata. |
| `standard` | tag | — | The primary RL standard; `rl-1` (cite evidence) is added automatically, and the dimension's companion standard is inferred. |
| `dok` | tag | — | Target cognitive demand (default: the target's — `r-dok3` for R&E, `r-dok2` for T9; a `short-text` summary is `r-dok3`). |
| `rubric` | band list | — | `short-text` only — replace the default 0/1/2 rubric with authored `band`s. |

## Rubric band

| Attribute | Value | Description |
| :--- | :--- | :--- |
| `score` | number | The points this band awards (e.g. `2`, `1`, `0`). |
| `descriptor` | string | What a response at this score looks like. |

---

## Enumerations

- **`target`**: `c1-t4` (R&E literary), `c1-t11` (R&E informational), `c1-t9` (Central Ideas informational), `c1-t2` (Central Ideas **literary**), `c1-t1` (Key Details **literary**), `c1-t8` (Key Details informational), `c1-t10` (Word Meanings informational) — required, top level
- **item `type`**: `ebsr`, `hot-text`, `short-text`, `multiple-choice`, `multi-select` (allowed set is per-target) · **passage `type`**: `literary`, `informational`
- **`dimension` (c1-t4)**: `character`, `setting`, `event`, `point-of-view`, `theme`, `topic`, `narrators-feelings`, `character-relationship`
- **`dimension` (c1-t11)**: `relationships-interactions`, `author-use-of-information`, `point-of-view`, `purpose`, `authors-opinion`
- **`dimension` (c1-t2)**: `theme`, `central-idea`, `key-detail`, `summary` · **(c1-t9)**: `central-idea`, `key-detail`, `summary` · **(c1-t1 / c1-t8)**: `supporting-evidence` · **(c1-t10)**: `word-meaning`
- **claim `status`**: `supported`, `distractor` · **source `status`**: `directly-supports`, `supports-wrong-claim`, `irrelevant` · **meaning `status` (c1-t10)**: `correct`, `distractor`
- **`error-type` (c1-t4 / c1-t11)**: `misreads-detail`, `erroneous-inference`, `faulty-reasoning` · **(c1-t2 / c1-t9)**: `too-narrow`, `too-broad`, `misreads-detail`, `insignificant` · **(c1-t1 / c1-t8)**: none — non-supporting sources · **(c1-t10)**: `other-meaning`, `misinterprets`, `wrong-context`
- **`standard`** — the full CCSS Grade-5 strand for the target's text type is accepted; the dimension's companion is inferred when you omit it. Primary companions: **(c1-t4)** `rl-1` + `rl-2` (theme/topic) / `rl-3` / `rl-6` — full **RL** strand `rl-1`–`rl-7`/`rl-9` accepted (no `rl-8`) · **(c1-t11)** `ri-1` + `ri-3` / `ri-6` / `ri-7` / `ri-8` · **(c1-t2)** `rl-1` + `rl-2` · **(c1-t9)** `ri-1` + `ri-2` · **(c1-t1)** `rl-1` **alone** — no companion in the guideline · **(c1-t8)** `ri-1` + `ri-7` — c1-t11/t9/t8 accept the full **RI** strand `ri-1`–`ri-9` · **(c1-t10)** `ri-4` + the `l-4` / `l-5` families. **`dok`**: `r-dok1`, `r-dok2`, `r-dok3`

## How composition uses the vocabulary

For each outcome, the compiler takes the `focus` supported claim as the correct answer and
draws the foils from the distractors that `targets` that outcome (most plausible per error
type), then:

- **ebsr** — Part A: the correct claim + 3 targeted distractor claims; Part B: a
  `directly-supports` line + 3 foils drawn from `supports-wrong-claim` and `irrelevant` sources.
- **hot-text** — Part A as above; Part B exposes every passage line as selectable, with the
  correct claim's `directly-supports` lines marked correct.
- **short-text** — the authored prompt plus a 0/1/2 `rubric`; no distractors.

It emits `distractorAnalysis` (every foil's error type/status + rationale + the claim it ties
to + plausibility), an `answerKey`, the matched `standards` and `dok`, and `warnings`.
**Hard errors** (invalid enum; missing `id`/`focus`/`stem`; distractor missing its `rationale`
or `targets`; a `focus`/`targets` that doesn't resolve; fewer than 3 foils targeting an
option item; duplicate `id`) fail the compile and carry source coordinates. **Warnings** (thin
targeted distractor pool, thin Part B pool, dangling `cites`/`supports`, hot-text ambiguity)
are non-fatal and ride on the item.

## Example

An EBSR item about a character's motivation, plus a short-text item with an authored rubric:

```
target c1-t4
title "The Tide Pool"
passage "The Tide Pool"
type literary
lines [
  "Mara crouched at the edge of the tide pool, ignoring the picnic behind her."
  "Her brother called twice, but she did not turn around."
  "A tiny crab scuttled under a rock, and Mara smiled for the first time all day."
  "She traced the cold water as if the pool were the only thing that mattered."
  "Behind her, paper plates rustled and her mother laughed."
  "Someone asked whether she wanted a sandwich, and she said nothing at all."
  "Only when her father folded the last chair did Mara stand up."
  "The tide crept in and filled the pool to its rim."
]
claims [
  claim id "c1"
    status supported
    dimension character
    subject "Mara"
    standard rl-1
    text "Mara cares more about the tide pool than about the picnic."
    cites [
      "e1"
      "e3"
      "e4"
    ] {}
  claim id "c2"
    status distractor
    error-type misreads-detail
    plausibility 0.8
    targets [ "q1" ]
    text "Mara is angry at her brother for calling her twice."
    rationale "Not turning around shows absorption, not anger."
    cites [
      "e2"
    ] {}
  claim id "c3"
    status distractor
    error-type misreads-detail
    plausibility 0.6
    targets [ "q1" ]
    text "Mara is bored by the pool and wants to go home."
    rationale "Her stillness is focus, not boredom."
    cites [
      "e2"
    ] {}
  claim id "c4"
    status distractor
    error-type erroneous-inference
    plausibility 0.55
    targets [ "q1" ]
    text "Mara would rather be indoors than out at the beach."
    rationale "Contradicted by her smile at the crab."
    cites [
      "e3"
    ] {}
  claim id "c5"
    status distractor
    error-type erroneous-inference
    plausibility 0.5
    targets [ "q1" ]
    text "Mara is waiting for her brother to come look with her."
    rationale "Invents a goal the passage never states."
    cites [
      "e2"
    ] {}
  claim id "c6"
    status distractor
    error-type faulty-reasoning
    plausibility 0.45
    targets [ "q1" ]
    text "Mara is quiet, so something must have upset her."
    rationale "Treats quiet as upset without support."
    cites [
      "e2"
    ] {}
]
evidence [
  source id "e1"
    line 1
    quote "Mara crouched at the edge of the tide pool, ignoring the picnic behind her."
    status directly-supports
    supports [
      "c1"
    ] {}
  source id "e3"
    line 3
    quote "A tiny crab scuttled under a rock, and Mara smiled for the first time all day."
    status directly-supports
    supports [
      "c1"
    ] {}
  source id "e4"
    line 4
    quote "She traced the cold water as if the pool were the only thing that mattered."
    status directly-supports
    supports [
      "c1"
    ] {}
  /* NO-GIVEAWAY: a supports-wrong-claim source backing BOTH the key and a distractor, so
     Part B does not telegraph Part A */
  source id "e2"
    line 2
    quote "Her brother called twice, but she did not turn around."
    status supports-wrong-claim
    supports [
      "c1"
      "c2"
    ] {}
  source id "e6"
    line 6
    quote "Someone asked whether she wanted a sandwich, and she said nothing at all."
    status supports-wrong-claim
    supports [
      "c1"
      "c6"
    ] {}
  source id "e5"
    line 5
    quote "Behind her, paper plates rustled and her mother laughed."
    status irrelevant
    supports [] {}
  source id "e7"
    line 7
    quote "Only when her father folded the last chair did Mara stand up."
    status irrelevant
    supports [] {}
  source id "e8"
    line 8
    quote "The tide crept in and filled the pool to its rim."
    status irrelevant
    supports [] {}
]
outcomes [
  outcome id "q1"
    type ebsr
    task-model tm1
    dimension character
    subject "Mara"
    standard rl-1
    focus "c1"
    stem "Which of these inferences about Mara is supported by the passage?"
    stem-b "Which sentence(s) from the passage best support your answer in Part A?" {}
  outcome id "q2"
    type short-text
    task-model tm3
    dimension character
    subject "Mara"
    standard rl-1
    focus "c1"
    stem "What inference can be made about Mara? Explain using key details from the passage to support your answer."
    rubric [
      band score 2
        descriptor "Valid inference with specific evidence." {}
      band score 1
        descriptor "Partial inference or weak evidence." {}
      band score 0
        descriptor "No valid inference or no evidence." {}
    ] {}
]
{}..
```

The example above is Target 4 (literary, R&E). The other targets keep the same flat-chain shape
but differ in what the options are: **T11** is the same R&E shape over an informational passage
(RI standards); **T9** (Central Ideas) options are `claim`s judged by significance (`too-narrow` /
`too-broad` / `insignificant` / `misreads-detail`); **T8** (Key Details) gives the inference in the
stem and the options are `source`s (no distractor claims); **T10** (Word Meanings) options are
`meaning`s of a targeted `word` authored in a top-level `words` list. See `instructions.md` for a
full worked program per target and `stems.md` for each target's stem catalog.
