<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0175 Usage Guide

_Revised: 2026-06-18_

Agent-facing guide for authoring L0175 programs. Read this before composing a `create_item` prompt or an `update_item` modification.

## Overview

L0175 is a content-composition language for 5th-grade English Language Arts assessment items (Smarter Balanced spec ELA · Grade 5 · Claim 1 · Reasoning & Evidence). One language serves **multiple learning targets**; **every program first declares a top-level `target`**: `c1-t4` (Target 4 — *literary* texts, RL standards, dimensions like character/theme/point-of-view) or `c1-t11` (Target 11 — *informational* texts, RI standards, dimensions like relationships-interactions/author-use-of-information/point-of-view/purpose). Choose the target from the request (literary vs. informational text and the skill assessed); the dimensions, standards, and stem catalog (`stems.md`) are then scoped to that target, and mixing targets' vocabularies is a compile error. It is **item-first**: after picking the target you compose the questions (`outcome`s) first — each with a unique `id`, a `focus` naming its correct claim, and an explicit `stem` (and `stem-b` on EBSR) instantiated from the guideline's Appropriate-Stem catalog (`stems.md`) — then author the supported `claim`s and a *superset* of distractor `claim`s, each tagging the question(s) it foils via `targets`, plus evidence `source`s. The compiler then *composes* each outcome deterministically: it takes the correct claim from `focus`, draws that question's foils ONLY from the distractors that `targets` it, uses the authored stem, and assembles a finished item in the task model named by its item type — for Reasoning & Evidence (T4/T11): `ebsr` (two-part evidence-based selected response), `hot-text` (select-text), or `short-text` (constructed response); other targets also offer `multiple-choice`/`multi-select` (the allowed set and the per-target task-model numbering are in *Vocabulary Cues*). One passage + superset can yield several items, each with its own bound foil set. The compiler performs no generation and no stem synthesis — it selects, validates against the guideline, and warns when a question's pool falls short. Distractors are tagged by the SBAC error taxonomy (Part A: `misreads-detail`, `erroneous-inference`, `faulty-reasoning`; Part B: `supports-wrong-claim`, `irrelevant`), each carrying a rationale; composition picks foils for error-type coverage and couples Part B evidence to the claims it plausibly supports. **For each EBSR/Hot-Text question author at least 5 viable distractors that `targets` it (aim for 5–8, over-generating since some are filtered as near-duplicates or accidentally correct) — covering all three error types with ≥2 alternatives in at least two of them, and giving each a `plausibility` score (0–1). An item draws only 3 foils, so a richer targeted pool yields stronger items; fewer than 3 targeting a question is a hard error, fewer than 5 a warning. Likewise, for EBSR Part B author at least 5 non-supporting evidence lines (`supports-wrong-claim` + `irrelevant`) so the compiler can choose the most tempting 3 foil options. No-giveaway rule: at least one of those `supports-wrong-claim` lines must list BOTH the correct claim's id AND a distractor's id in its `supports` (a line that seems to support the right answer but actually backs a misreading) — otherwise the correct evidence line stands alone, Part B telegraphs Part A, and the compiler warns "possible A↔B giveaway." Do not make every wrong-claim line point only at distractors.**

**Name the item type; task-model NUMBERS are per-target and collide.** Phrase a request by item
type (`ebsr` / `hot-text` / `short-text` / `multiple-choice` / `multi-select`) — that is unambiguous.
Task-model *numbers* (TM1…TM5) are numbered **per target**, so the same number means different things
in different targets: `tm3` is **short-text** in `c1-t4`/`c1-t11`, **`ebsr`** in `c1-t9`, and
**`hot-text`** in `c1-t1`/`c1-t8`/`c1-t10`. A bare "task model 3" is therefore meaningless without
its target — never assume the Reasoning & Evidence (T4/T11) numbering carries over to the others. When a
request names a task model by number, resolve it against the **program's target** (see the per-target
task-model table in *Vocabulary Cues*) and state the item type, e.g. for `c1-t9` "task model 3 → EBSR".

**Targets are different skills — pick the one the request assesses.** Beyond the two Reasoning &
Evidence targets above (`c1-t4` literary, `c1-t11` informational — infer/conclude and justify with
evidence), L0175 also composes **`c1-t9` — Central Ideas** (informational): a *different* skill —
synthesize and condense (the main/central idea, the key details that build it, and summary), NOT
inference. Use `c1-t9` when the request is about the **main idea**, **most important details**, or a
**summary**; dimensions `central-idea`/`key-detail`/`summary`, standards `ri-1`+`ri-2`, DOK 2 (3 for
the written summary). Its distractors are a **significance** taxonomy — usually *true* statements
that simply aren't central: `too-narrow` (a supporting detail mistaken for the main idea),
`too-broad` (an overgeneralization/off-topic), `misreads-detail`, `insignificant` (a minor detail
that doesn't belong in a summary). T9 item types are `multiple-choice` (pick the central idea),
`multi-select` (choose the two sentences that belong in a summary — `focus` is a **list**), `ebsr`
(central idea → supporting detail), `short-text` (summary), and single-part `hot-text` (click the
sentence(s) that show the main idea — the `focus` claim's directly-supporting `source`s are the
correct selection). Two new item types — `multiple-choice` (4 options, one correct) and
`multi-select` (5–6 options, an exact correct set) — are single-part: author the `stem` and a
`focus`, no Part B.

**`c1-t2` — Central Ideas over LITERARY texts** is T9's twin on a story, with the same five item
types, the same significance taxonomy, and standards `rl-1`+`rl-2`. Choose it over `c1-t9` by the
passage: story/poem → `c1-t2`, article → `c1-t9`. Two rules are T2's alone. **Theme leads**: its
dimensions are `theme`, `central-idea`, `key-detail`, `summary`, and for a story you normally want
`theme` with the correct answer phrased as a *lesson or message* ("Keeping at something can matter
more than winning"), not a plot event — reserve `central-idea` for a prompt that says "main idea".
**Summary is scoped**: the guideline forbids asking students to summarize the *entire* text, so a
T2 `summary` stem must name a section or key event ("Summarize what happens after…"). A plain
"summarize the passage" belongs to T9, not T2.

L0175 also composes **`c1-t8` — Key Details** (informational): the inference/conclusion is **GIVEN
in the stem** and the student selects the supporting **evidence** (the answer is *evidence*, not a
chosen statement). Use `c1-t8` when the request **states an idea and asks which detail/sentence
supports it**; dimension `supporting-evidence`, standards `ri-1`+`ri-7`, DOK 1–2, item types
`multiple-choice`, `multi-select`, and **single-part `hot-text`** (no Part A). Author ONE supported
`claim` = the given inference (its `focus`), state it in the `stem`, and author `source`s as the
options: `directly-supports` = correct evidence (with a `quote`), `supports-wrong-claim`/`irrelevant`
= distractor evidence. No distractor claims.

**`c1-t1` — Key Details over LITERARY texts** is the same model as `c1-t8` on a story rather than an
article: same dimension `supporting-evidence`, same item types, same DOK 1–2, same authoring recipe.
The one difference is the standard — the guideline names **`rl-1` and no companion**, so a composed
item's `standards` is exactly `["rl-1"]`; omit `standard` on the outcome. Choose between them by the
passage: story/poem/narrative → `c1-t1`, article/report → `c1-t8`. T1's stems offer `line` as a
selectable unit and say "[author/**narrator**]"; its Multi-Select is exactly two correct.

L0175 also composes **`c1-t10` — Word Meanings** (informational): the question asks for the
**meaning of a targeted word/phrase in context**, so the answer choices are **meanings**, authored
as a dedicated `word`/`meaning` structure (not claims). Use `c1-t10` when the request asks **what a
word/phrase means**; dimension `word-meaning`, standards `ri-4` + the L-4 family (`l-4a` context /
`l-4b` roots & affixes / `l-5c` word relationships / `l-4c` reference), DOK 1–2, item types
`multiple-choice`, `multi-select`, and `hot-text` (click the word matching a given definition — the correct word is `focus` with its paragraph's `line`; author the distractor candidate words either as more single-word `word`s OR as the focus word's distractor `meanings` whose `text` is the candidate word itself (a single word, not a definition), ALL appearing in that one paragraph. The compiler shows the paragraph and makes the candidate words clickable, focus correct; if no candidate words are found it falls back to making every content word a choice. The `stem` is only the instruction + definition — never paste the paragraph into the stem). Author a top-level
`words` list: a `word` (the targeted word, `line`/`quote` for context) with `meanings` — one (MC) or
≥2 (Multi-Select) `status correct` meanings + `status distractor` meanings (each with a T10
`error-type` — `other-meaning`/`misinterprets`/`wrong-context` — and a `rationale`). The outcome's
`focus` names the word; state the word and its context sentence in the `stem`.

**Write at the target grade level.** The grade is the guideline's grade (the target's — Grade 5 for `c1-t4`/`c1-t11`) unless the user's prompt asks for a different grade, in which case author a top-level `grade <n>`. Match the passage AND all question text to that grade: short, mostly simple/compound sentences; concrete, high-frequency vocabulary; an inference drawn from **specific details in the text**, not college-style literary or rhetorical analysis. DOK 3 means strategic reasoning *within* grade-level text — not harder text. The compiler estimates the passage's reading level and warns when it runs above the target grade. See **Grade-appropriate reading level** below.

**Supply the passage already split into paragraphs.** When a request includes or describes the passage text, break it into its paragraphs and keep those breaks — each paragraph becomes one numbered `lines` entry and the rendered passage preserves that paragraph structure. The code generator maintains the paragraphs you provide; it does not re-flow a wall of text into one block or re-chunk it. Separate paragraphs with a blank line (or clearly mark each one) so they survive into the final passage. **Keep paragraphs even for Hot Text** — the compiler segments each paragraph into sentences and makes each one individually selectable in Part B, so the passage keeps its paragraph layout; do not author the passage as one-sentence lines.

When composing a request, declare the `target`, then author the passage and outcomes (with their stems) first, then the inference graph (supported claims, then the targeted distractors), then the evidence. The program is one flat builder chain: top-level forms (`target`, `passage`, `type`, `lines`, `claims`, `evidence`, `outcomes`) thread a single continuation and the whole program ends with one `{}..`. Inside the `claims`/`evidence`/`outcomes` lists, each element (`claim`/`source`/`outcome`) is its own attribute chain terminated by its own `{}`. Attribute values that are free text (`text`, `rationale`, `subject`, `stem`, the passage heading) or id labels (`id`, `focus`, `cites`, `supports`, `targets`) are quoted strings; closed-enum values (`target`, `type`, `status`, `dimension`, `error-type`, `standard`, `dok`) are bare kebab-case identifiers (e.g. `c1-t11`, `ebsr`, `directly-supports`, `ri-1`).

In scope: SBAC Grade 5 · Claim 1 for targets **T4** (Reasoning & Evidence, literary, RL), **T11** (Reasoning & Evidence, informational, RI), **T9** (Central Ideas, informational, RI-1/RI-2), **T8** (Key Details, informational, RI-1/RI-7 — given-inference → evidence selection), and **T10** (Word Meanings, informational, RI-4/L-4 — meaning of a targeted word, authored as `word`/`meaning`); a single passage; the per-target dimensions and distractor taxonomy; item types `ebsr`, `hot-text`, `short-text`, `multiple-choice`, `multi-select` (allowed set varies by target); DOK r-dok1..r-dok3. Out of scope: other claims/grades or Claim-1 targets beyond T4/T11/T9/T8/T10; multi-word-phrase candidates in T10 click-the-word; dual-text stimuli; compile-time LLM generation; auto-scoring of short text; cross-language composition.

## Grade-appropriate reading level

Items must read at the grade the guideline targets. **Resolving the grade:** use the target/guideline's grade — Grade 5 for the current `c1-t4` and `c1-t11` guidelines — unless the user's prompt names a different grade, in which case author a top-level `grade <n>` (e.g. `grade 4`). The compiler echoes the resolved grade on the output and estimates the passage's reading level, warning when it reads above target.

Author the passage **and** every claim, option, and rationale to that grade (figures below are the Grade-5 instance; scale with the grade):

- **Reading level** — match the CCSS text-complexity band for the grade. Grade 5 ≈ Lexile **740–1010L**, Flesch–Kincaid grade **4.5–6.0**; don't exceed about one grade above target.
- **Sentences** — mostly simple and compound; average roughly `2·grade + 2` words (~12–16 at Grade 5), and avoid more than the occasional sentence past ~22 words or stacked subordinate clauses.
- **Vocabulary** — concrete, high-frequency words a student that age knows; at most a few grade-appropriate Tier-2 words made clear by context. Avoid abstract/academic (Tier-3) diction above grade (e.g. *ambivalence*, *juxtaposition*, *ostensibly*).
- **Passage length** — a single passage ≈ 150–350 words at Grade 5; scale with the grade.
- **Figurative language** — sparing and accessible; no dense or layered metaphor.
- **Reasoning, not just prose** — DOK 3 is *strategic thinking within grade-level text*, not college-level analysis. The correct inference must come from **concrete textual details** (what a character does or says, a stated cause and effect), not abstract thematic or authorial-technique critique beyond grade. Keep distractor and option text in the **same register** as the passage — a wrong answer that sounds more academic than the text gives itself away.

## Vocabulary Cues

Say this to get that:

- **Target** — `target c1-t4` (literary, Reasoning & Evidence), `target c1-t11` (informational, Reasoning & Evidence), `target c1-t2` (**literary**, Central Ideas), `target c1-t9` (informational, Central Ideas), `target c1-t1` (**literary**, Key Details — given-inference → evidence), `target c1-t8` (informational, Key Details — same model), or `target c1-t10` (informational, Word Meanings — meaning of a targeted word); required, first top-level form. Selects the dimensions, standards, distractor taxonomy, DOK, item types, and stem catalog.
- **Grade** — optional top-level `grade <n>` (e.g. `grade 5`). Defaults to the target/guideline's grade; author one only to override when the user asks for a different grade. Sets the reading-level target the compiler checks the passage against.
- **Passage** — `passage "Title"` sets the heading; `type literary` (or `informational`, matching the target); `lines [ "..." "..." ]` are the passage **paragraphs** — one entry per paragraph, auto-numbered from 1. Always split by paragraph, including for Hot Text: the compiler segments each paragraph into sentences and exposes each sentence as a Part B selection, so the passage keeps its paragraph format. For EBSR Part B, evidence sources carry a `quote` with the exact supporting sentence so options stay sentence-tight while `line` points at the paragraph.
- **Outcome** — the question, composed first. `outcome id "q1" type ebsr dimension character subject "Mara" focus "c1" stem "Which of these inferences about Mara is supported by the passage?" stem-b "Which sentence(s) from the passage best support your answer in Part A?" {}`. `id` is the handle distractors target; `focus` names the correct claim; `stem` (and `stem-b` on EBSR) come from `stems.md`. Vary `type` (`ebsr` / `hot-text` / `short-text`) for different task models. **Keep the Part A stem a neutral question** — fill the template's slot with the subject/skill only, and do **not** echo the correct option's wording (if the stem restates the answer, it gives it away). Paraphrase so stem and key share only the subject; the compiler warns when the stem reuses most of the correct option's words. Applies to every Hot Text and EBSR question, across all targets. **For Hot Text, Part A asks for the best STATEMENT** ("Click on the statement that best provides an inference about [X]…") whose options are inference claims — it is NOT a "click the sentences" instruction (that's Part B, fixed by the compiler). If a request says "select the sentences that show [X]", translate it: Part A is a statement prompt about [X], and the sentences that show [X] are `directly-supports` evidence (with exact `quote`s) that become Part B's answer. The compiler warns when a Hot Text Part A stem mentions sentences.
- **Claim** — a candidate inference statement. Supported: `claim id "c1" status supported dimension character subject "Mara" text "..." cites ["e1" "e2"] {}`. A distractor adds `error-type`, a required `rationale`, and `targets` (the question id(s) it foils): `claim id "c2" status distractor error-type misreads-detail targets ["q1"] text "..." rationale "..." cites ["e2"] {}`.
- **Evidence source** — a passage line tagged by its support role. `source id "e1" line 1 status directly-supports supports ["c1"] {}`. Statuses: `directly-supports`, `supports-wrong-claim`, `irrelevant`. An optional `rationale` explains a foil. For **Hot Text**, give each `directly-supports` source a `quote` naming the exact supporting **sentence** so that sentence is marked correct in Part B; a `directly-supports` source with no `quote` marks every sentence of its `line` correct. Part B asks for an **exact number** of sentences (one less than the valid count, floored at 1, capped at 3) and **any selection of that many from the valid set is correct** (a superset) — so **author ≥3 directly-supporting sentences** so the asked count is ≥2 and students aren't forced to find every one.
- **Dimensions (c1-t4)** — `character`, `setting`, `event`, `point-of-view`, `theme`, `topic`, `narrators-feelings`, `character-relationship`.
- **Dimensions (c1-t11)** — `relationships-interactions`, `author-use-of-information`, `point-of-view`, `purpose`, `authors-opinion`.
- **Dimensions (c1-t2)** — `theme` (prefer it for a story: the lesson/message), `central-idea`, `key-detail` (covers key events), `summary` (scoped to a section or key event, never the whole text).
- **Dimensions (c1-t9)** — `central-idea`, `key-detail`, `summary`.
- **Dimensions (c1-t1 / c1-t8)** — `supporting-evidence` (the answer is evidence; the inference is given in the stem). `c1-t1` is the literary target, `c1-t8` the informational one.
- **Dimensions (c1-t10)** — `word-meaning` (the answer is a meaning; authored via `word`/`meaning`).
- **Word / meaning (c1-t10)** — `words [ word id "w1" text "aqueduct" line 1 quote "…" meanings [ meaning id "m1" status correct text "a water channel" {} meaning id "m2" status distractor error-type other-meaning text "a boat" rationale "…" {} ] {} ]`; the outcome's `focus` names the word.
- **Item types** — `ebsr` (two-part: statement → evidence), `hot-text` (R&E/Central-Ideas: click the supporting/main-idea sentences; Key Details: click the evidence sentences; Word Meanings: click the word matching a definition), `short-text` (constructed response), `multiple-choice` (one correct, single-part), `multi-select` (exact correct set, single-part). MC/Multi-Select have no Part B. The allowed set is per-target (the compiler rejects others).
- **Task models are per-target — resolve a number against the target.** Task-model NUMBERS (TM1…TM5) are numbered per target and collide, so name the item type rather than a bare number; if a request says "task model N", map N to the item type for the program's target using the table below (e.g. `c1-t9` TM3 → `ebsr`, TM4 → `hot-text`). **Specify the task model on the outcome as `task-model tm3` whenever it is known** — the compiler resolves it against the target's table and **hard-errors if it disagrees with `type`** (or supplies `type` when omitted), so the intended task model is checked, not guessed. It stays optional, but the compiler emits a (non-blocking) warning when an outcome omits it, so include it whenever you know it.

<!-- GENERATED:task-models START (from targets.json — regenerated by tools/build-static.js; do not edit by hand) -->
| Target | tm1 | tm2 | tm3 | tm4 | tm5 |
|--------|-----|-----|-----|-----|-----|
| `c1-t4` — Grade 5 · Claim 1 · Target 4 (Reasoning & Evidence) | ebsr | hot-text | short-text | — | — |
| `c1-t11` — Grade 5 · Claim 1 · Target 11 (Reasoning & Evidence) | ebsr | hot-text | short-text | — | — |
| `c1-t2` — Grade 5 · Claim 1 · Target 2 (Central Ideas) | multiple-choice | multi-select | ebsr | hot-text | short-text |
| `c1-t9` — Grade 5 · Claim 1 · Target 9 (Central Ideas) | multiple-choice | multi-select | ebsr | hot-text | short-text |
| `c1-t1` — Grade 5 · Claim 1 · Target 1 (Key Details) | multiple-choice | multi-select | hot-text | — | — |
| `c1-t8` — Grade 5 · Claim 1 · Target 8 (Key Details) | multiple-choice | multi-select | hot-text | — | — |
| `c1-t10` — Grade 5 · Claim 1 · Target 10 (Word Meanings) | multiple-choice | multi-select | hot-text | — | — |
<!-- GENERATED:task-models END -->
- **Central Ideas (c1-t2 / c1-t9) distractor `error-type`** — `too-narrow`, `too-broad`, `misreads-detail`, `insignificant` (true-but-not-central); R&E targets use `misreads-detail`/`erroneous-inference`/`faulty-reasoning`. Keep an `insignificant` foil plausible — the guideline warns against details so trivial the option is implausible.
- **Program terminator** — top-level forms chain with no `{}` between them; the program ends with a single `{}..`.

## Example Prompts

- *"Write an EBSR item about the main character's motivation in a short story about a girl at a tide pool."* → `target c1-t4`, `ebsr`
- *"From the same passage, also produce a short-text constructed-response item and a hot-text item."* → `short-text`, `hot-text`
- *"Add a faulty-reasoning distractor that mistakes the character's quiet focus for fear."* → distractor `claim`
- *"Make an EBSR item about how the author uses evidence to support a point in an informational article about bridges, standard ri-8."* → `target c1-t11`, `dimension author-use-of-information`
- *"Write an item about the relationships between the events in a history passage."* → `target c1-t11`, `dimension relationships-interactions`
- *"Which sentence best states the main idea of this article? (multiple choice)"* → `target c1-t9`, `type multiple-choice`, `dimension central-idea`
- *"What is the theme of this story? Make it a two-part item with the evidence in Part B."* → `target c1-t2`, `type ebsr` (tm3), `dimension theme`; the correct answer is a lesson, not a plot event
- *"Have students summarize what happens after the storm, using details from the story."* → `target c1-t2`, `type short-text` (tm5), `dimension summary` — scoped to a key event, which is the only kind of summary T2 allows
- *"Make a multi-select asking for the two sentences that belong in a summary."* → `target c1-t9`, `type multi-select`, `dimension summary`, `focus` is a list of the two correct claims
- *"The article says aqueducts brought water to distant cities — which detail best supports that? (multiple choice)"* → `target c1-t8`, `type multiple-choice`, `dimension supporting-evidence`; the inference goes in the `stem`, the options are `source`s
- *"Make a click-the-sentence item where students select the evidence for a stated conclusion."* → `target c1-t8`, `type hot-text` (single-part), `dimension supporting-evidence`
- *"In this story, the reader can conclude the boy regrets what he said — which line best supports that?"* → `target c1-t1` (the literary Key Details target), `type multiple-choice`, `dimension supporting-evidence`; standards are `rl-1` alone
- *"What does the word 'aqueduct' mean as used in this article? (multiple choice)"* → `target c1-t10`, `type multiple-choice`, `dimension word-meaning`; a `word` with candidate `meaning`s, `focus` names the word
- *"Read the paragraph below. Click the word that means 'a channel that carries water'."* → `target c1-t10`, `type hot-text` (click-the-word); author the candidate `word`s (correct one is `focus` with its paragraph's `line`, plus a few distractor candidate words from the same paragraph); definition in the stem, passage NOT in the stem
- *"Keep the passage at a 4th-grade reading level."* → top-level `grade 4`; author shorter sentences and simpler vocabulary (the default is the guideline's Grade 5)

## Out of Scope

- **Other targets / grades / claims** — L0175 covers G5 · Claim 1, targets T4 (Reasoning & Evidence, literary), T11 (Reasoning & Evidence, informational), T9 (Central Ideas), T8 (Key Details), and T10 (Word Meanings). Other claims, grades, or Claim-1 targets belong in their own dialects.
- **Dual-text stimuli** — a single passage only in this version.
- **Compile-time generation** — the compiler selects and validates authored content; it does not invent claims, distractors, or evidence.
- **Auto-scoring** — short-text responses are hand-scored against the rubric; the compiler emits the rubric only.
- **Cross-language composition** — each item runs in exactly one dialect.
