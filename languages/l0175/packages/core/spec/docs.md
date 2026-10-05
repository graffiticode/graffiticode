<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0175 User Manual

_Revised: 2026-06-18_

**Introduction**

*Graffiticode* is a collection of domain languages for creating task-specific web apps.
**L0175** composes 5th-grade English Language Arts assessment items conforming to the
Smarter Balanced specification ELA · Grade 5 · Claim 1 (Reading), for learning targets **T4**
(Reasoning & Evidence, literary), **T11** (Reasoning & Evidence, informational), **T9**
(Central Ideas, informational), **T8** (Key Details, informational), and **T10** (Word Meanings,
informational). Targets are **different skills**: T4/T11 ask students to infer or conclude and
justify with evidence; T9 asks them to determine the main idea, the key details that build it, or
summarize; T8 **gives** the inference and asks them to select the supporting evidence; T10 asks
for the meaning of a targeted word in context.

One language serves **multiple learning targets**, chosen by a required top-level `target`:
`c1-t4` (literary, RL), `c1-t11` (informational, RI), `c1-t9` (informational, RI-1/RI-2),
`c1-t2` (literary, RL-1/RL-2), `c1-t1` (literary, RL-1), `c1-t8` (informational, RI-1/RI-7), or `c1-t10` (informational, RI-4/L-4). It is
**item-first**: a program declares its `target`, then authors the `outcome`s (questions) first —
each with a unique `id`, a `focus` correct claim (a **list** on `multi-select`), and an explicit
`stem` — then the supported and distractor `claim`s (each distractor `targets` the question(s) it
foils) and the evidence `source`s for one passage. The compiler *composes* each outcome from its
`focus` and the foils that target it, assembling a finished item (EBSR, Hot Text, Short Text,
Multiple Choice, or Multi-Select).

### Overview

The program

```
target c1-t4
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
  claim id "c1" status supported dimension character subject "Mara"
    text "Mara cares more about the tide pool than about the picnic." cites ["e1" "e3" "e4"] {}
  /* an EBSR needs 3 foils, so author at least 5 distractors targeting the question */
  claim id "c2" status distractor error-type misreads-detail targets ["q1"]
    text "Mara is angry at her brother for calling her twice." rationale "Not turning around shows absorption, not anger." cites ["e2"] {}
  claim id "c3" status distractor error-type misreads-detail targets ["q1"]
    text "Mara is bored by the pool and wants to go home." rationale "Her stillness is focus, not boredom." cites ["e2"] {}
  claim id "c4" status distractor error-type erroneous-inference targets ["q1"]
    text "Mara would rather be indoors than out at the beach." rationale "Contradicted by her smile at the crab." cites ["e3"] {}
  claim id "c5" status distractor error-type erroneous-inference targets ["q1"]
    text "Mara is waiting for her brother to come look with her." rationale "Invents a goal the passage never states." cites ["e2"] {}
  claim id "c6" status distractor error-type faulty-reasoning targets ["q1"]
    text "Mara is quiet, so something must have upset her." rationale "Treats quiet as upset without support." cites ["e2"] {}
]
evidence [
  source id "e1" line 1 quote "Mara crouched at the edge of the tide pool, ignoring the picnic behind her." status directly-supports supports ["c1"] {}
  source id "e3" line 3 quote "A tiny crab scuttled under a rock, and Mara smiled for the first time all day." status directly-supports supports ["c1"] {}
  source id "e4" line 4 quote "She traced the cold water as if the pool were the only thing that mattered." status directly-supports supports ["c1"] {}
  /* NO-GIVEAWAY: back BOTH the key and a distractor so Part B does not telegraph Part A */
  source id "e2" line 2 quote "Her brother called twice, but she did not turn around." status supports-wrong-claim supports ["c1" "c2"] {}
  source id "e6" line 6 quote "Someone asked whether she wanted a sandwich, and she said nothing at all." status supports-wrong-claim supports ["c1" "c6"] {}
  source id "e5" line 5 quote "Behind her, paper plates rustled and her mother laughed." status irrelevant supports [] {}
  source id "e7" line 7 quote "Only when her father folded the last chair did Mara stand up." status irrelevant supports [] {}
  source id "e8" line 8 quote "The tide crept in and filled the pool to its rim." status irrelevant supports [] {}
]
outcomes [
  outcome id "q1" type ebsr task-model tm1 dimension character subject "Mara" standard rl-1 focus "c1"
    stem "Which of these inferences about Mara is supported by the passage?"
    stem-b "Which sentence(s) from the passage best support your answer in Part A?" {}
]
{}..
```

composes a two-part EBSR item and renders it as an answerable form with a Student / Review
toggle. This example is Target 4 (literary, R&E); the other targets use the same flat-chain shape
but author their options differently — **T2**/**T9** (Central Ideas) significance-taxonomy `claim`s,
**T1**/**T8** (Key Details) `source`s with the inference given in the stem, **T10** (Word Meanings)
`meaning`s of a targeted `word`. See `instructions.md` for a full worked program per target.

### Vocabulary

| Form | Arity | Example | Description |
| ---- | :---: | ------- | ----------- |
| **target** | 2 | `target c1-t11` | Required, top level; selects the learning-target profile (`c1-t4` / `c1-t11` / `c1-t2` / `c1-t9` / `c1-t1` / `c1-t8` / `c1-t10`) |
| **passage** | 2 | `passage "Title"` | Sets the passage heading; chains with `type` and `lines` |
| **type** | 2 | `type literary` | Passage type (`literary` / `informational`) or, on an outcome, the item type |
| **lines** | 2 | `lines [ "..." "..." ]` | Passage paragraphs (one entry per source paragraph), auto-numbered from 1 — preserve the request's paragraph breaks; don't merge into one block. Hot Text selects at the sentence level automatically, so split by paragraph (not by sentence) for every task model |
| **claims** | 2 | `claims [ claim ... {} ]` | The candidate inference statements |
| **claim** | 1 | `claim id "c1" status supported ... {}` | One inference candidate (supported or distractor) |
| **evidence** | 2 | `evidence [ source ... {} ]` | The evidence sources |
| **source** | 1 | `source id "e1" line 1 status directly-supports ... {}` | One passage line tagged by support role |
| **outcomes** | 2 | `outcomes [ outcome ... {} ]` | The intended items (authored first) |
| **outcome** | 1 | `outcome id "q1" type ebsr dimension character focus "c1" stem "..." ... {}` | One question to compose |
| **rubric** | 2 | `rubric [ band ... {} ]` | Short-text scoring bands (on an outcome) |
| **band** | 1 | `band score 2 descriptor "..." {}` | One rubric row |
| **title** | 2 | `title "..."` | Optional assessment title (top level) |
| **grade** | 2 | `grade 5` | Optional reading-level target (top level); defaults to the guideline/target's grade |

Attribute functions (arity-2, merge one key into the element's record):

- **top level** — `target` (required: `c1-t4` | `c1-t11` | `c1-t2` | `c1-t9` | `c1-t1` | `c1-t8` | `c1-t10`), `title` (optional), `grade` (optional reading-level target; defaults to the target's grade), `words` (c1-t10 only — a list of `word`s)
- **word / meaning** (c1-t10) — `word` has `id`, `text`, `line`/`quote`, `meanings`; `meaning` has `id`, `text`, `status` (`correct` | `distractor`), `error-type`* + `rationale`* on distractors
- **identity / refs** — `id`, `cites` (claim→evidence ids), `supports` (evidence→claim ids), `focus` (outcome→correct claim id, or a list on `multi-select`), `targets` (distractor→outcome ids)
- **claim** — `status`, `dimension`, `text`, `error-type`*, `rationale`*, `targets`*, `plausibility` (0–1 distractor temptingness override), `subject`, `standard`, `dok`
- **evidence** — `status`, `line` (or `quote`), `supports`, `rationale`
- **outcome / stem** — `id`†, `type`†, `dimension`†, `focus`†, `stem`† (Part A / single-question / prompt, from `stems.md`), `stem-b` (Part B, required on EBSR), `subject`, `standard`, `dok`, `rubric` (short-text)
- **rubric band** — `score`, `descriptor`

\* required on distractor claims.  † required on every outcome. See `spec.md` for the full per-function reference.

### Enumerations

- `target`: `c1-t4` (literary, R&E), `c1-t11` (informational, R&E), `c1-t9` (informational, Central Ideas), `c1-t2` (**literary**, Central Ideas), `c1-t1` (**literary**, Key Details), `c1-t8` (informational, Key Details), `c1-t10` (informational, Word Meanings)
- item `type`: `ebsr`, `hot-text`, `short-text`, `multiple-choice`, `multi-select` (allowed set per target — T4/T11: ebsr/hot-text/short-text · T9: multiple-choice/multi-select/ebsr/hot-text/short-text · T8: multiple-choice/multi-select/hot-text · T10: multiple-choice/multi-select/hot-text)
- `dimension` (c1-t4): `character`, `setting`, `event`, `point-of-view`, `theme`, `topic`, `narrators-feelings`, `character-relationship`
- `dimension` (c1-t11): `relationships-interactions`, `author-use-of-information`, `point-of-view`, `purpose`, `authors-opinion`
- `dimension` (c1-t2): `theme`, `central-idea`, `key-detail`, `summary` · (c1-t9): `central-idea`, `key-detail`, `summary` · (c1-t1 / c1-t8): `supporting-evidence` · (c1-t10): `word-meaning`
- claim `status`: `supported`, `distractor` · source `status`: `directly-supports`, `supports-wrong-claim`, `irrelevant` · meaning `status` (c1-t10): `correct`, `distractor`
- `error-type` (c1-t4 / c1-t11): `misreads-detail`, `erroneous-inference`, `faulty-reasoning` · (c1-t2 / c1-t9): `too-narrow`, `too-broad`, `misreads-detail`, `insignificant` · (c1-t1 / c1-t8): none (non-supporting sources) · (c1-t10): `other-meaning`, `misinterprets`, `wrong-context`
- `standard` — full CCSS Grade-5 strand for the text type accepted; the dimension's companion is inferred when omitted. Primary companions — (c1-t4): `rl-1` + `rl-2` (theme/topic) / `rl-3` / `rl-6` [full RL `rl-1`–`rl-7`/`rl-9`, no `rl-8`] · (c1-t11): `ri-1` + `ri-3` / `ri-6` / `ri-7` / `ri-8` · (c1-t2): `rl-1` + `rl-2` · (c1-t9): `ri-1` + `ri-2` · (c1-t1): `rl-1` alone (no companion) · (c1-t8): `ri-1` + `ri-7` [c1-t11/t9/t8 accept full RI `ri-1`–`ri-9`] · (c1-t10): `ri-4` + the `l-4` / `l-5` families
- `dok`: `r-dok1`, `r-dok2`, `r-dok3` (R&E → r-dok3; T9 → r-dok2, written summary r-dok3; T8 & T10 → r-dok2)

### Grade-appropriate reading level

Author the passage **and** every claim, option, and rationale at the grade the guideline targets
(Grade 5 for `c1-t4` / `c1-t11`; override with a top-level `grade <n>` when the user asks for
another grade). Keep sentences short and mostly simple/compound (≈ `2·grade + 2` words on
average), vocabulary concrete and high-frequency, and the inference grounded in **specific
details from the text** rather than abstract literary or rhetorical analysis — DOK 3 is strategic
reasoning *within* grade-level text, not harder text. The compiler estimates the passage's
reading level and emits a warning when it reads above the target grade.
