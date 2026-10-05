<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0175 Dialect Extensions

_Revised: 2026-08-28_

L0175 composes 5th-grade ELA assessment items (Smarter Balanced · Grade 5 · Claim 1 ·
Reasoning & Evidence) from an authored, inline superset of tagged content. One language serves
**multiple learning targets**; a program selects its target up front.

## Step 0 — pick the learning target

Always declare a top-level `target` (the SBAC learning target the program composes for):

- **`c1-t4`** — Target 4: Reasoning & Evidence over **literary** texts (RL standards). Dimensions:
  `character`, `setting`, `event`, `point-of-view`, `theme`, `topic`, `narrators-feelings`,
  `character-relationship`. Companion standards by dimension: `character` / `character-relationship`
  / `setting` / `event` → `rl-3`; `point-of-view` / `narrators-feelings` → `rl-6`; **`theme` /
  `topic` → `rl-2`** (the CCSS theme standard — **not** `rl-9`). `rl-1` (cite evidence) is always
  added. You normally **omit** `standard` and let the dimension pick its companion; the full
  Grade-5 **RL** strand (`rl-1`–`rl-7`, `rl-9`) is accepted if you author one explicitly.
  **`theme` vs `topic`** (same `rl-2`, different dimensions): `topic` = what the text is *about*
  (cued by "**mostly about**" / "what is the story about"); `theme` = the *lesson/message* (cued by
  "the theme" / "the message" / "the lesson"). Tag a "mostly about" prompt `topic` and phrase its
  correct answer as a subject statement, not a life lesson.
- **`c1-t11`** — Target 11: Reasoning & Evidence over **informational** texts (RI standards).
  Dimensions: `relationships-interactions`, `author-use-of-information`, `point-of-view`,
  `purpose`, `authors-opinion`. Standards: `ri-1` (always) + `ri-3` / `ri-6` / `ri-7` / `ri-8` / `ri-9`.
  **`purpose` vs `point-of-view`** (both read "author's …", different companions): `purpose` = *why
  the author wrote it* (cued by "author's purpose") → `ri-8`; `point-of-view` = *the author's stance*
  (cued by "author's point of view") → `ri-6`. Tag by the cue and prefer to **omit** `standard` so
  the dimension infers the right companion.
- **`c1-t2`** — Target 2: **Central Ideas** over **literary** texts (RL standards). The **literary
  twin of `c1-t9`** and, with it, the only target offering **all five** item types
  (`multiple-choice`, `multi-select`, `ebsr`, `hot-text` single-part, `short-text`). Dimensions:
  `theme`, `central-idea`, `key-detail`, `summary` — all four answer to `rl-2`, so `standards`
  composes to `["rl-1", "rl-2"]`. **DOK 2** (3 for the written response). Same **significance**
  distractor taxonomy as T9 (`too-narrow`, `too-broad`, `misreads-detail`, `insignificant`).
  **Two T2-only rules:** (1) **theme leads** — for a story or poem prefer `theme` and phrase the
  correct answer as a *lesson or message*, not a plot summary (`central-idea` is for a "main idea"
  prompt); (2) **summary is scoped** — the guideline forbids asking students to summarize the
  *entire* text, so every `summary` stem must point at a section or key event ("Summarize what
  happens after…"). `key-detail` covers the guideline's "key events".
- **`c1-t9`** — Target 9: **Central Ideas** over **informational** texts (RI standards). A
  DIFFERENT skill from Reasoning & Evidence — synthesize and condense: the main/central idea, the
  key details that build it, and summary (NOT inference + justification). Dimensions: `central-idea`,
  `key-detail`, `summary`. Standards: `ri-1` (always) + `ri-2`. **DOK 2** (3 only for the written
  summary). Item types: `multiple-choice`, `multi-select`, `ebsr`, `short-text`, and single-part
  `hot-text` (click the sentence(s) that show the main idea — its directly-supporting `source`s are
  the correct selection). Distractors use a **significance** taxonomy (`too-narrow`,
  `too-broad`, `misreads-detail`, `insignificant`) — usually true statements that just aren't the
  central idea.
- **`c1-t1`** — Target 1: **Key Details** over **literary** texts. The **literary twin of `c1-t8`**
  and the same model: the inference/conclusion is **GIVEN in the stem**, and the student selects the
  supporting **evidence**. Dimension: `supporting-evidence`. Standard: **`rl-1` and nothing else** —
  the guideline names no companion, so a composed item's `standards` is exactly `["rl-1"]`; omit
  `standard` on the outcome. **DOK 1–2**. Item types: `multiple-choice`, `multi-select`, `hot-text`
  (single-part) — no EBSR, no short-text. **Author ONE supported `claim` = the given inference (its
  `focus`), state it in the `stem`, and author `source`s as the options: `directly-supports` =
  correct evidence (with a `quote`), `supports-wrong-claim`/`irrelevant` = distractor evidence. No
  distractor claims.** Its stems offer `line` as a selectable unit and say `[author/narrator]`;
  Multi-Select is exactly **two** correct.
- **`c1-t8`** — Target 8: **Key Details** over **informational** texts (RI standards). A DIFFERENT
  model: the inference/conclusion is **GIVEN in the stem**, and the student selects the supporting
  **evidence** (the answer is evidence, not a chosen statement). Dimension: `supporting-evidence`.
  Standards: `ri-1` (always) + `ri-7`. **DOK 1–2**. Item types: `multiple-choice`, `multi-select`,
  `hot-text` (single-part) — no EBSR, no short-text. **Author ONE supported `claim` = the given
  inference (its `focus`), state it in the `stem`, and author `source`s as the options:
  `directly-supports` = correct evidence (with a `quote`), `supports-wrong-claim`/`irrelevant` =
  distractor evidence. No distractor claims.**
- **`c1-t10`** — Target 10: **Word Meanings** over **informational** texts. The MOST different
  model: the question asks for the **meaning of a targeted word/phrase in context**, so the answer
  choices are **meanings**, authored as `word`/`meaning` (not claims). Dimension: `word-meaning`.
  Standards: `ri-4` (always) + the L-4 family by strategy (`l-4a` context, `l-4b` roots/affixes,
  `l-5c` word relationships, `l-4c` reference). **DOK 1–2**. Item types: `multiple-choice`,
  `multi-select`, and `hot-text` (click the word in the excerpt matching a given definition).
  **Author a top-level `words` list: a
  `word` (the targeted word, with `line`/`quote` for context) holding `meanings` — one (MC) or ≥2
  (Multi-Select) `status correct` + `status distractor` meanings (each with a T10 `error-type`
  + `rationale`). The outcome's `focus` names the word; state the word + its context in the `stem`.**

**Infer the target — the user need not state it.** Pick on **two axes: the skill asked, and the
text type.** Most skills exist in both a literary and an informational target, so decide the skill
first, then the text type:

| Skill — how to recognize it | **Literary** (story / poem / narrative) | **Informational** (article / report) |
|---|---|---|
| **Reasoning & Evidence** — infer/conclude AND justify ("infer/conclude/why") | `c1-t4` | `c1-t11` |
| **Central Ideas** — theme, main idea, the key details that build it, or a summary ("theme/message/main idea/summarize") | `c1-t2` | `c1-t9` |
| **Key Details** — the request **states an inference and asks which detail/sentence supports it** (the answer is evidence) | `c1-t1` | `c1-t8` |
| **Word Meanings** — "what does [word] mean [in context]" | — | `c1-t10` |

The skill cues also point at a dimension: character / theme / narrator's point of view → the R&E
literary target. When the **text type** is genuinely ambiguous, prefer the literary target; when the
**skill** is ambiguous, match the verbs in the request. Write the choice as the first top-level
form: `target c1-t11`. Use the dimensions, standards, and stem catalog (in `stems.md`) for that
target; mixing targets' vocabularies is a compile error, and the passage `type` must match the
target (literary for T4/T2/T1; informational for T11/T9/T8/T10). If `target` is omitted entirely
the compiler defaults to `c1-t4` and warns — so always emit one explicitly rather than relying on
the default.

## Authoring contract

**Compose questions first (item-first).** After picking the target, author the N `outcome`s you
want — each with a unique `id`, a `focus` naming its correct claim, and an explicit `stem` (and
`stem-b` on EBSR) taken from the target's section of the Appropriate-Stem catalog (`stems.md`).
THEN author the supported claims each `focus` names, and a superset of distractor claims, each
tagged with `targets` listing the question id(s) it foils. The compiler draws an item's foils
ONLY from the distractors that target that outcome — so every wrong answer is authored against
that exact stem and key.

A program is ONE flat builder chain ending in a single `{}..`. Top-level forms
(`target`, `passage`, `type`, `lines`, `claims`, `evidence`, `outcomes`) chain with no `{}`
between them. Inside the `claims` / `evidence` / `outcomes` lists, each element (`claim` /
`source` / `outcome`) is its own attribute chain terminated by its own `{}`; whitespace separates
elements (commas are optional).

Quote free text (`text`, `rationale`, `subject`, passage heading) and id labels (`id`,
`cites`, `supports`). Write closed-enum values as bare kebab-case identifiers (`c1-t4`, `ebsr`,
`character`, `misreads-detail`, `directly-supports`, `rl-1`, `r-dok3`).

## Forms and attributes

- **target** `c1-t4` | `c1-t11` | `c1-t2` | `c1-t9` | `c1-t1` | `c1-t8` | `c1-t10` — top level; selects the learning-target profile (dimensions,
  standards, stem catalog). Always author one; if omitted, the compiler defaults to `c1-t4`.
- **grade** `<n>` — optional, top level (e.g. `grade 5`). The reading-level target the compiler
  checks the passage against. Defaults to the guideline/target's grade (5 for `c1-t4`/`c1-t11`);
  author one only to override when the user's prompt asks for a different grade.
- **passage** `"heading"` — plus `type` (`literary` | `informational`) and
  `lines [ "..." ... ]`. **By default each entry is one PARAGRAPH of the passage**, auto-numbered
  from 1 (so the passage shows numbered paragraphs, matching SBAC). **Preserve the paragraph breaks
  the request supplies** — emit one `lines` entry per source paragraph; do not merge the passage
  into a single entry or re-chunk it. Split by paragraph for **every** task model, including Hot
  Text: the compiler segments each paragraph into sentences and makes each sentence individually
  selectable in Hot Text Part B, so the passage keeps its paragraph layout — do **not** author the
  passage as one sentence per line.
- **claim** — `id`, `status` (`supported` | `distractor`), `dimension` (required on supported
  claims), `text`. A `distractor` also requires `error-type`, a non-empty `rationale`, and
  `targets` (the outcome id(s) of the question(s) it foils). Optional: `cites` (evidence ids),
  `subject`, `standard`, `dok`, and `plausibility` (a 0–1 override for how tempting a distractor
  is — otherwise the compiler computes it from evidence overlap, structure, and error type when
  choosing among the foils of the same error type that target the outcome).
- **source** — `id`, `line` (the numbered passage entry — a paragraph by default) or `quote`,
  `status` (`directly-supports` | `supports-wrong-claim` | `irrelevant`), `supports` (claim ids).
  Optional `rationale` explaining a foil. **For EBSR Part B, give the source a `quote` with the
  exact supporting SENTENCE** while `line` points at the paragraph that contains it — so Part B
  options stay tight sentences even though the passage is numbered by paragraph. (Without `quote`,
  the option text is the whole paragraph at `line`.)
- **outcome** — `id` (required, unique — distractors target it), `type`
  (`ebsr` | `hot-text` | `short-text` | `multiple-choice` | `multi-select`), `dimension`, `focus`
  (required — the id of the supported correct claim; on `multi-select` a **list** of ids = the
  correct set), `stem` (required — the Part A / single-question stem / short-text prompt, authored
  from `stems.md`), and on EBSR `stem-b` (required — the Part B stem). Optional: `subject`,
  `standard`, `dok`, `task-model` (`tm1`..`tm5` — the per-target task model; the compiler resolves
  it to the item type for the program's `target` and hard-errors if it disagrees with `type`, so it
  both documents and guards intent — see "Task models are per-target" below), and `rubric`
  (short-text only — a list of `band score <n> descriptor "…"` elements; defaults to a 0/1/2 rubric
  if omitted).
- **band** — a rubric row: `band score 2 descriptor "…" {}`. Used only inside an outcome's `rubric`.
- **word** / **meaning** (**target `c1-t10` only**) — a top-level `words` list of `word`s; each
  `word` has `id`, `text` (the targeted word/phrase), optional `line`/`quote` (its context), and a
  `meanings` list. A `meaning` has `id`, `text` (the definition/synonym), `status`
  (`correct` | `distractor`), and on a distractor an `error-type` (`other-meaning` | `misinterprets`
  | `wrong-context`) + `rationale`. The outcome's `focus` names the `word`; its correct meaning(s)
  are the key, the distractor meanings the foils. Example:
  `words [ word id "w1" text "aqueduct" line 1 quote "The aqueduct carried water." meanings [ meaning id "m1" status correct text "a water channel" {} meaning id "m2" status distractor error-type other-meaning text "a boat" rationale "another meaning, ignores context" {} ] {} ]`
  For a **click-the-word** (`hot-text`) item, author the focus `word` (the correct one) as the
  outcome's `focus` with the `line` of its paragraph, then the **distractor candidate words** either
  (a) as more single-word `word`s in the list, or (b) as the focus word's distractor `meanings`
  whose `text` IS the candidate word (a single word, with error-type + rationale) — for hot-text the
  meaning text must be the literal word to click, not a definition. **All candidates must be words
  that appear in that one paragraph.** The compiler shows the paragraph and makes the candidate words
  clickable, with the focus word correct. The `stem` is just the instruction + definition — do
  **not** paste the paragraph into it (the compiler warns if you do). ⚠ If you author *only* the
  focus word with a real multi-word definition (no candidate words), the compiler falls back to
  making **every** content word clickable — list the candidate words to avoid that. Candidates not
  in the focus word's paragraph are warned and dropped.
- A top-level **`title`** attribute (before `passage`) names the assessment; it is echoed on the output.

## Stems (Appropriate Stems)

**You author the stem; the compiler does not generate it. Use the guideline's Appropriate-Stem
templates verbatim — do not invent phrasings.** `stems.md` has a **section per target** (T4, T11,
T9, T8, T10), each with its own task models — open the section for the `target` you picked. For
each item, pick the one template that matches the item type and the task, and fill its bracketed
`[...]` slot. Author `stem` (Part A / single-question / short-text prompt) and, on EBSR, `stem-b`
(Part B).

### Task models are per-target — a number alone is meaningless

⚠ **Task-model numbers are PER-TARGET and COLLIDE across targets.** The same number maps to a
different item type depending on the `target`. Look at `tm3` alone:

| Number | `c1-t4` / `c1-t11` | `c1-t2` / `c1-t9` | `c1-t1` / `c1-t8` / `c1-t10` |
|--------|--------------------|-------------------|------------------------------|
| **tm3** | short-text | **ebsr (two-part)** | hot-text |

So "task model 3" cannot be resolved without first knowing the target. **Do not assume the
Reasoning & Evidence (T4/T11) numbering applies elsewhere** — under the Central Ideas targets
(`c1-t2`, `c1-t9`), Task Model 3 is EBSR, Task Model 4 is Hot Text, Task Model 5 is Short Text.

The full per-target task-model → item-type mapping (the compiler enforces exactly this):

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

**Normalization rule (required).** When a request names a task model by number ("TM3", "task
model 3"), **resolve it against the row for the program's `target`** in the table above — never the
T4/T11 default. Before composing, echo the resolution, e.g. `target c1-t9, TM3 → ebsr`, and author
that item type.

**Author it whenever the request specifies a task model.** When the request names a task model —
by number ("TM3") or via an item type that implies one — author the resolved number directly on the
outcome as `task-model tm3` (alongside `type`). The compiler resolves it against the target's table
and **hard-errors on a mismatch** with `type` (or supplies `type` when you omit it) — so
`outcome … task-model tm3 type ebsr` on `c1-t9` is self-checking, and `task-model tm3 type
short-text` is rejected. It stays optional (the compiler emits a non-blocking warning when an
outcome omits it), but specifying it makes the task model explicit and verifiable — so include it
whenever it is known.

The task-model mapping and Part-A choices below are the **Reasoning & Evidence (T4/T11)** catalog
(EBSR → Task Model 1, Hot Text → Task Model 2, Short Text → Task Model 3; task = inference vs.
conclusion vs. author-intent; plain subject vs. narrator's-feelings vs. relationship). **T9, T8,
and T10 use different task models and stems** — see their `stems.md` sections (e.g. T9 "Which
sentence best shows the main idea…", T8 states the inference then "Which detail … best supports
this conclusion?", T10 "What does the word … most likely mean?"). Common R&E Part A choices:

- inference — "Which of these inferences about [...] is supported by the passage?"
- conclusion — "Which of these conclusions about [...] is supported by the passage?"
- author-intent — "What did the author most likely mean by including [...] in the passage?"

**Specificity rule (required).** Fill the `[...]` slot — the guideline's
`[provide character's name / setting / event / author's point of view / theme / topic]` slot —
with the **specific** reference the question is about, the same string you put in `subject`:
`character`→ the character's name (`"Mother"`); `point-of-view`→ `"the narrator's point of view"`;
`setting` / `event` / `theme` / `topic`→ the specific setting/event/theme/topic;
`narrators-feelings`→ "the narrator's feelings toward {subject}"; `character-relationship`→
"{subject}'s relationship with {other}". Do **not** leave it generic (`"the character"`) and do
**not** pad it — write `"the theme"`, not `"the theme of the passage"` (the stem already ends
"…supported by the passage"). A specific subject is what makes the four answer choices
discriminating. Hot Text uses the "Click on the statement…" forms; Short Text ends with
"Explain using key details from the passage to support your answer."

**Hot Text Part A asks for the best STATEMENT — never for passage sentences.** The Part A `stem`
must be a Task Model 2 "Click on the statement that best provides an inference/conclusion about
[...]" prompt whose four options are inference `claim`s. Selecting the supporting sentences is
**Part B**, which the compiler fixes automatically — you never author it. **Translate a request
that says "select/click the sentences that show [X]"**: that phrasing describes the *Part B*
target, not the Part A stem. Author Part A as "Click on the statement that best provides an
inference about [X] that is supported by the passage." (a statement about [X]), make the correct
`claim` that inference, and mark the sentences that show [X] as `directly-supports` evidence with
exact `quote`s — those become Part B's correct selections. Do **not** copy "select the sentences
that…" into the `stem`. The compiler warns ("Hot Text Part A must ask for the best STATEMENT…")
when a Hot Text Part A stem mentions sentences.

The concrete answer and its foils are authored as `claim`s (the correct claim, named by the
outcome's `focus`, states the inferred fact, e.g. "Cortez is about twelve"; its foils `targets`
the outcome). Remember the answer must be **inferable from evidence** (Target 4) — a fact stated
outright is literal recall and out of scope.

## Authoring guidance

The distractor-pool, error-type-coverage, and EBSR Part-B rules below are the **Reasoning &
Evidence (T4/T11)** contract — they apply wherever wrong answers are authored as `distractor`
claims. The other targets author their wrong answers differently (see Step 0): **T9** uses
`distractor` claims too but with the significance taxonomy (`too-narrow` / `too-broad` /
`misreads-detail` / `insignificant`); **T8** has **no distractor claims** — its foils are
non-supporting `source`s (`supports-wrong-claim` / `irrelevant`); **T10** authors distractor
`meaning`s, not claims. The grade-level, length-balance, and stem-wording rules apply to **all**
targets.

- For each EBSR/Hot-Text outcome, author **at least 5 viable distractor claims that `targets`
  it**, covering all three error types (`misreads-detail`, `erroneous-inference`,
  `faulty-reasoning`) — with ≥2 alternatives in at least two of the types. An item draws only 3
  foils, so a deeper targeted pool gives selection real choice. **Fewer than 3 targeted foils is
  a hard error** (the item can't be composed); fewer than 5 triggers a composition warning.
- A distractor may `targets` more than one question when it genuinely foils each (e.g. several
  items built around the same correct claim). Keep foils written to the specific stem + key they
  target — that is the whole point of binding by `targets` rather than by dimension.
- **Over-generate: aim for 5–8 distinct distractors per question** (some will be filtered as
  near-duplicates or accidentally correct), spanning a spread of difficulty, and give each a
  `plausibility` score (0–1) for how tempting it is to a partial-understander. Composition selects
  the most plausible foil per error type from this scored pool; if a score is omitted the compiler
  computes one from the inference graph (evidence overlap, structure, error type).
- Tag evidence so Part B has material: mark the sources that **directly support** the correct
  claim, and author **at least 5 non-supporting foil sources** — `supports-wrong-claim` sources
  plus `irrelevant` sources. EBSR Part B draws 3 foils + the correct source; a pool of ≥5 lets the
  compiler pick the most tempting 3. Fewer than 5 triggers a composition warning. Give each EBSR
  Part B source a `quote` with the exact supporting **sentence** (and a `line` pointing at its
  paragraph), so the four Part B options are tight sentences rather than whole paragraphs.
- **Hot Text Part B selects sentences, not paragraphs.** Keep the passage split by paragraph; the
  compiler segments each paragraph into sentences and exposes every sentence as a selectable Part B
  option, preserving the paragraph layout. Mark the correct sentence(s) by giving each
  `directly-supports` source a `quote` with the exact supporting **sentence** (and a `line` at its
  paragraph). A `directly-supports` source with no `quote` marks every sentence of its `line`
  correct.
- **Hot Text Part B asks for an EXACT number of sentences from a SUPERSET of valid answers.** The
  valid (directly-supporting) sentences are a superset; the student must select a specific count,
  and **any selection of that many drawn from the valid set is correct** — they never have to find
  every one. The compiler sets the count to **one less than the valid count** (a proper subset),
  floored at 1 (one valid sentence) and capped at 3 (so it stays ≤3 once there are more than 4
  valid): `count = min(3, validCount − 1)`, or 1 when `validCount ≤ 1`. It writes the matching
  "Click N sentence(s)…" instruction. **Author a real superset: mark every sentence that genuinely
  supports the inference as a `directly-supports` source with an exact `quote` — aim for ≥3 so the
  asked count is ≥2 and there's real choice.** With only one valid sentence the compiler warns and
  the answer is that single sentence.
- **No-giveaway rule (EBSR Part B): for every EBSR question, author at least one
  `supports-wrong-claim` line whose `supports` lists BOTH the correct claim's id AND a
  distractor's id** — a passage line that *seems* to back the correct inference but actually
  props up a misreading. Part B asks "which line supports your Part A answer?"; if none of the
  Part B foils also point at the correct claim, the correct line is the only one "about" the
  right answer, so a student can back into Part A from the evidence (and the compiler warns
  "possible A↔B giveaway"). Tie the shared line to a distractor you expect Part A to use, so it
  is selected as a Part B foil. Do **not** make every `supports-wrong-claim` line point only at
  distractors — that is exactly what triggers the warning.
  Example: `source id "e2" line 2 status supports-wrong-claim supports ["c1" "c2"] {}` — `c1` is
  the correct claim, `c2` one of its foils; this line tempts in both Part A and Part B.
- **Length-balance rule (no length giveaway): keep the correct claim's `text` parallel in
  length and detail to its distractors.** A frequent tell is the key being the longest, most
  qualified, most-detailed option — a partial-understander learns to pick "the long one." Write
  the correct claim as tersely as it can be stated, and give the foils comparable specificity
  (similar clause count and roughly the same length) rather than short, flat statements. The same
  applies to the EBSR Part B `quote`s — pick supporting and non-supporting sentences of similar
  length. The compiler flags a "possible length giveaway" warning when the correct option is the
  longest AND notably longer than the average distractor; treat that warning as a cue to pad the
  foils or trim the key.
- **Stem-wording rule (no answer echo): the Part A stem must not reuse the correct option's
  wording.** Keep the stem a neutral question that names only the subject/skill (fill the catalog
  template's `[...]` slot with the subject, e.g. "the narrator's point of view" or "how the city's
  systems helped people") — do **not** restate the correct claim's phrasing in the stem. If the
  stem already contains the answer's distinctive words ("...that best show that the city *had
  systems that helped people move around the city and get fresh water*", when the key says the
  city "*had built systems … that let people move through the city and get fresh water*"), the
  answer is obvious without reading the options. **Paraphrase** so the stem and the key share only
  the subject, and word the correct option in the passage's own terms. This applies to **every
  Hot Text and EBSR question, across all targets**. The compiler warns ("Part A: the stem reuses
  much of the correct option's wording …") when the stem reuses most of the key's content words —
  treat it as a cue to reword the stem.
- **Grade-appropriate text complexity: author the passage AND all question text at the target
  grade.** The grade is the guideline/target's grade (Grade 5 for `c1-t4`/`c1-t11`) unless the
  user asks for another, in which case set a top-level `grade <n>`. At the Grade-5 instance:
  reading level near the CCSS grade-4–5 band (Lexile ≈ 740–1010L, Flesch–Kincaid grade ≈ 4.5–6.0);
  sentences mostly simple/compound, averaging ~12–16 words; concrete, high-frequency vocabulary
  with at most a few context-clear Tier-2 words (avoid abstract/academic Tier-3 diction); a single
  passage ≈ 150–350 words; figurative language sparing and accessible. **The reasoning must be
  grade-level too:** DOK 3 means strategic thinking *within* grade-level text, so the correct
  inference comes from concrete textual details — what a character does or says, a stated cause and
  effect — not college-style thematic or authorial-technique analysis. Keep distractor, option, and
  rationale text in the same register as the passage; a wrong answer that reads more academic than
  the text gives itself away. The compiler estimates the passage's reading level and warns when it
  runs above the target grade — treat that warning as a cue to shorten sentences and simplify
  vocabulary. Scale the figures with the grade for non-Grade-5 targets.
- Distractor rationales must state *why a student would plausibly choose the foil* (the error
  it targets). They appear in the item's `distractorAnalysis` output.
- The same passage + superset can drive several outcomes; add one `outcome` per item you want.

## Built-in enumerations

- `target`: `c1-t4`, `c1-t11`, `c1-t2`, `c1-t9`, `c1-t1`, `c1-t8`, `c1-t10` (top level; always author one — defaults to `c1-t4` if omitted)
- `grade`: a number (top level, optional; defaults to the target's grade — 5 for all current targets)
- item `type`: `ebsr`, `hot-text`, `short-text`, `multiple-choice`, `multi-select` · passage `type`: `literary`, `informational`
  (allowed per target — T4/T11: ebsr/hot-text/short-text · T2/T9: all five · T1/T8/T10: multiple-choice/multi-select/hot-text)
- `dimension` (**c1-t4**): `character`, `setting`, `event`, `point-of-view`, `theme`, `topic`, `narrators-feelings`, `character-relationship`
- `dimension` (**c1-t11**): `relationships-interactions`, `author-use-of-information`, `point-of-view`, `purpose`, `authors-opinion`
- `dimension` (**c1-t2**): `theme`, `central-idea`, `key-detail`, `summary` · (**c1-t9**): `central-idea`, `key-detail`, `summary` · (**c1-t1 / c1-t8**): `supporting-evidence` · (**c1-t10**): `word-meaning`
- claim `status`: `supported`, `distractor` · source `status`: `directly-supports`, `supports-wrong-claim`, `irrelevant` · meaning `status` (c1-t10): `correct`, `distractor`
- `error-type` (**c1-t4 / c1-t11**): `misreads-detail`, `erroneous-inference`, `faulty-reasoning` · (**c1-t2 / c1-t9**): `too-narrow`, `too-broad`, `misreads-detail`, `insignificant` · (**c1-t1 / c1-t8**): none — wrong answers are non-supporting `source`s · (**c1-t10**): `other-meaning`, `misinterprets`, `wrong-context`
- `standard` — primary companions (normally inferred from the dimension; author one only to override): (**c1-t4**) `rl-1` + `rl-2` (theme/topic) / `rl-3` / `rl-6` · (**c1-t11**) `ri-1` + `ri-3` / `ri-6` / `ri-7` / `ri-8` · (**c1-t2**) `rl-1` + `rl-2` (every dimension) · (**c1-t9**) `ri-1` + `ri-2` · (**c1-t1**) `rl-1` **alone** (no companion) · (**c1-t8**) `ri-1` + `ri-7` · (**c1-t10**) `ri-4` + `l-4` / `l-4a` / `l-4b` / `l-4c` / `l-5c`. The **full CCSS Grade-5 strand for the target's text type is accepted**: any `rl-1`–`rl-7` / `rl-9` on a literary target (c1-t4/c1-t2/c1-t1), any `ri-1`–`ri-9` on an informational target (c1-t11/t9/t8/t10), plus the `l-4` / `l-5` families on c1-t10. (`rl-2` is the theme standard — valid; there is no `rl-8`.)
- `dok`: `r-dok1`, `r-dok2`, `r-dok3` (R&E items are `r-dok3`; T2/T9 selected-response is `r-dok2`, the written response `r-dok3`; T1, T8 & T10 are `r-dok2`)

## What composition does

For each outcome the compiler takes the correct claim named by `focus`, draws that outcome's
foils from the distractors that `targets` it (selecting for error-type coverage and
plausibility), uses the authored `stem`/`stem-b`, builds the task-model item, and emits
`distractorAnalysis` (every foil's error type + rationale + the claim it ties to), an
`answerKey`, the matched `standards` and `dok`, and `warnings` when the targeted pool is thin.
It never generates content or stems — author them.

## Example (Target 4, literary)

Balance the option lengths — a correct answer noticeably longer than the foils is findable without
reading (the compiler warns past 1.35×). For EBSR, author at least **5** non-supporting evidence
lines so Part B has real foils to choose from.

```
target c1-t4
passage "The Tide Pool"
type literary
/* lines are PARAGRAPHS, auto-numbered 1..N; EBSR Part B sources `quote` the exact sentence */
lines [
  "Mara crouched at the edge of the tide pool, ignoring the picnic behind her. Her brother called twice, but she did not turn around. A tiny crab scuttled under a rock, and Mara smiled for the first time all day."
  "She traced the cold water as if the pool were the only thing that mattered. Behind her, paper plates rustled and her mother laughed. Someone asked whether she wanted a sandwich, and she said nothing at all."
  "Her brother stacked a small tower of stones near the blanket. The tide crept in and filled the pool to its rim. Only when her father folded the last chair did Mara stand up. She looked back at the water twice on the walk to the car."
]
claims [
  claim id "c1" status supported dimension character subject "Mara"
    text "Mara cares more about the tide pool than about the picnic."
    cites ["e1" "e3" "e4"] {}
  /* at least 5 viable distractors targeting q1; the item draws 3 (one per error type) */
  claim id "c2" status distractor error-type misreads-detail plausibility 0.85 targets ["q1"]
    text "Mara is angry at her brother for calling her twice."
    rationale "Not turning around shows absorption, not anger." cites ["e2"] {}
  claim id "c3" status distractor error-type misreads-detail plausibility 0.6 targets ["q1"]
    text "Mara is bored by the pool and wants to go home."
    rationale "Her stillness is focus, not boredom (the crab makes her smile)." cites ["e2"] {}
  claim id "c4" status distractor error-type erroneous-inference plausibility 0.55 targets ["q1"]
    text "Mara would rather be indoors than out at the beach."
    rationale "Over-generalizes from her quiet to a dislike the text contradicts." cites ["e3"] {}
  claim id "c5" status distractor error-type erroneous-inference plausibility 0.5 targets ["q1"]
    text "Mara is waiting for her brother to come look with her."
    rationale "Invents a goal the passage never states." cites ["e2"] {}
  claim id "c6" status distractor error-type faulty-reasoning plausibility 0.45 targets ["q1"]
    text "Mara is quiet, so something must have upset her."
    rationale "Treats quiet as upset without textual support." cites ["e2"] {}
]
evidence [
  /* `line` = the paragraph; `quote` = the exact supporting sentence shown as the Part B option */
  source id "e1" line 1 quote "Mara crouched at the edge of the tide pool, ignoring the picnic behind her." status directly-supports supports ["c1"] {}
  source id "e3" line 1 quote "A tiny crab scuttled under a rock, and Mara smiled for the first time all day." status directly-supports supports ["c1"] {}
  source id "e4" line 2 quote "She traced the cold water as if the pool were the only thing that mattered." status directly-supports supports ["c1"] {}
  source id "e8" line 3 quote "She looked back at the water twice on the walk to the car." status directly-supports supports ["c1"] {}
  /* NO-GIVEAWAY: at least one supports-wrong-claim line lists BOTH the correct claim and a
     distractor, so Part B does not telegraph Part A */
  source id "e2" line 1 quote "Her brother called twice, but she did not turn around." status supports-wrong-claim supports ["c1" "c2"] {}
  source id "e5" line 2 quote "Someone asked whether she wanted a sandwich, and she said nothing at all." status supports-wrong-claim supports ["c1" "c6"] {}
  source id "e6" line 2 quote "Behind her, paper plates rustled and her mother laughed." status irrelevant supports [] {}
  source id "e7" line 3 quote "Her brother stacked a small tower of stones near the blanket." status irrelevant supports [] {}
  source id "e9" line 3 quote "The tide crept in and filled the pool to its rim." status irrelevant supports [] {}
]
outcomes [
  outcome id "q1" type ebsr task-model tm1 dimension character subject "Mara" standard rl-1 focus "c1"
    stem "Which of these inferences about Mara is supported by the passage?"
    stem-b "Which sentence(s) from the passage best support your answer in Part A?" {}
]
{}..
```

(For **Target 11**, the same R&E shape over an *informational* passage: `target c1-t11`,
`type informational`, an RI dimension like `relationships-interactions`, `standard ri-1` + `ri-3`,
and the T11 stems from `stems.md`.)

## Example (Target 2 — Central Ideas, **literary**, theme)

Same shape as Target 9 over a story. The T2 differences: **`theme`** is the dimension of choice and
the correct answer reads as a *lesson*, not a plot event; every dimension answers to `rl-2`, so
`standards` composes to `["rl-1", "rl-2"]`. A `summary` item on T2 must be scoped to a section or
key event — never the whole text. Keep the four options about the same length.

```
target c1-t2
passage "The Blue Ribbon"
type literary
lines [
  "Every spring, Tessa entered her drawing in the county fair."
  "This year she almost did not enter at all."
  "Tessa drew the same barn eleven times before she kept one."
  "At the fair, the blue ribbon went to somebody else."
  "Then a teacher asked to hang Tessa's drawing in the hall."
]
claims [
  claim id "c1" status supported dimension theme subject "Tessa"
    text "Keeping at something can matter more than winning."
    cites ["e3" "e5"] {}
  /* T2 distractors are the SIGNIFICANCE taxonomy — usually true, just not the theme.
     Keep `insignificant` foils plausible: too trivial and no student would pick them. */
  claim id "d1" status distractor error-type too-narrow targets ["q1"]
    text "Tessa entered the county fair every single spring."
    rationale "A true detail from the opening, not the story's theme." cites ["e1"] {}
  claim id "d2" status distractor error-type too-broad targets ["q1"]
    text "Hard work always makes a person famous someday."
    rationale "Overgeneralizes far past what the story shows." cites ["e5"] {}
  claim id "d3" status distractor error-type misreads-detail targets ["q1"]
    text "Tessa gave up drawing after she lost again."
    rationale "Misreads the ending; she keeps drawing and is lifted by it." cites ["e2"] {}
  claim id "d4" status distractor error-type insignificant targets ["q1"]
    text "Tessa's grandmother owned more than one pencil."
    rationale "True but far too minor to be the theme." cites ["e1"] {}
  claim id "d5" status distractor error-type too-narrow targets ["q1"]
    text "Tessa drew a barn instead of drawing a house."
    rationale "A single detail of the drawing, not what the story means." cites ["e3"] {}
]
evidence [
  source id "e3" line 3 status directly-supports supports ["c1"] quote "Tessa drew the same barn eleven times before she kept one." {}
  source id "e5" line 5 status directly-supports supports ["c1"] quote "Then a teacher asked to hang Tessa's drawing in the hall." {}
  source id "e1" line 1 status supports-wrong-claim supports ["c1" "d1"] quote "Every spring, Tessa entered her drawing in the county fair." {}
  source id "e2" line 2 status supports-wrong-claim supports ["c1" "d3"] quote "This year she almost did not enter at all." {}
  source id "e4" line 4 status irrelevant supports [] quote "At the fair, the blue ribbon went to somebody else." {}
]
outcomes [
  outcome id "q1" type multiple-choice task-model tm1 dimension theme subject "Tessa" focus "c1"
    stem "Which sentence best tells the theme of the passage?" {}
]
{}..
```

## Example (Target 9 — Central Ideas, multiple-choice)

The OPTIONS are still `claim`s, but the skill is the **main idea** (not infer-and-justify) and the
distractors are the **significance** taxonomy — usually true statements that just aren't central.
DOK is `r-dok2`; the standards are `ri-1` + `ri-2`. (No EBSR Part B here; on T9 EBSR/Hot-Text the
correct claim's `directly-supports` sources are the supporting selection.)
Keep the four options about the same length — a longer correct answer is a giveaway.

```
target c1-t9
passage "Honeybees"
type informational
lines [
  "Honeybees live together in large groups called colonies. Worker bees gather nectar and build the hive. The queen bee lays all the eggs. By working together, the colony survives and grows."
]
claims [
  claim id "c1" status supported dimension central-idea subject "the colony" standard ri-2
    text "Honeybees survive because each bee does a job for the colony."
    cites ["e1"] {}
  /* T9 distractors are usually TRUE statements that simply aren't the central idea */
  claim id "d1" status distractor error-type too-narrow targets ["q1"]
    text "The queen bee lays all of the eggs for the colony."
    rationale "A true supporting detail, not the central idea." cites ["e1"] {}
  claim id "d2" status distractor error-type too-broad targets ["q1"]
    text "Insects are the most important animals on the planet."
    rationale "An overgeneralization beyond the passage." cites ["e1"] {}
  claim id "d3" status distractor error-type misreads-detail targets ["q1"]
    text "Each bee in the colony does every job by itself."
    rationale "Misreads the division of labor." cites ["e1"] {}
]
evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {} ]
outcomes [
  outcome id "q1" type multiple-choice task-model tm1 dimension central-idea subject "the colony" standard ri-2 focus "c1"
    stem "Which sentence best shows the main idea of the passage?" {}
]
{}..
```

## Example (Target 1 — Key Details, **literary**, evidence selection)

Same model as Target 8 over a story: the inference is **GIVEN in the stem** and the OPTIONS are
passage `source`s. The T1 difference is the standard — **`rl-1` alone**, so omit `standard` and let
the dimension resolve it. DOK `r-dok2`.

```
target c1-t1
passage "The Loose Board"
type literary
lines [
  "Nina had walked past Mr. Ruiz's crooked porch a hundred times. The third board rocked under her feet every time she crossed it. On Saturday she stopped, because someone had left a hammer on the step. She looked up and down the empty street. Then she knelt down and set the first nail without anyone asking her to. Her arm ached by the fourth nail, but she did not quit. Mr. Ruiz never learned who had fixed his porch."
]
claims [
  claim id "c1" status supported dimension supporting-evidence subject "Nina"
    text "Nina takes care of a problem on her own, without being told to." cites ["e1" "e2"] {}
]
evidence [
  source id "e1" line 1 quote "Then she knelt down and set the first nail without anyone asking her to." status directly-supports supports ["c1"] {}
  source id "e2" line 1 quote "Mr. Ruiz never learned who had fixed his porch." status directly-supports supports ["c1"] {}
  source id "e3" line 1 quote "The third board rocked under her feet every time she crossed it." status irrelevant supports [] rationale "Describes the problem, not Nina's choice to act." {}
  source id "e4" line 1 quote "On Saturday she stopped, because someone had left a hammer on the step." status irrelevant supports [] rationale "Invites the erroneous inference that she helped only because a tool was there." {}
  source id "e5" line 1 quote "Nina had walked past Mr. Ruiz's crooked porch a hundred times." status irrelevant supports [] rationale "Tells how often she passed, not that she acted on her own." {}
  source id "e6" line 1 quote "She looked up and down the empty street." status irrelevant supports [] rationale "Sets the scene; shows no action Nina took." {}
  source id "e7" line 1 quote "Her arm ached by the fourth nail, but she did not quit." status irrelevant supports [] rationale "Shows persistence once she had started, not that she started unasked." {}
]
outcomes [
  outcome id "q1" type multiple-choice task-model tm1 dimension supporting-evidence subject "Nina" focus "c1"
    stem "The reader can conclude that Nina takes care of a problem on her own, without being told to. Which line from the passage best supports this conclusion?" {}
]
{}..
```

## Example (Target 8 — Key Details, evidence selection)

The inference is **GIVEN in the stem**; the OPTIONS are passage `source`s, not claims. Author ONE
supported `claim` (the given inference, named by `focus`), state it in the `stem`, and author the
`source`s as the choices: `directly-supports` = correct evidence (give each a `quote`),
`irrelevant`/`supports-wrong-claim` = foils (give each a `rationale`). **No distractor claims.**
Standards `ri-1` + `ri-7`, DOK `r-dok2`.

**Keep the conclusion a real inference, not a paraphrase of one sentence.** The stem states the
conclusion and the key is the evidence for it, so if the conclusion just restates the correct
source, the option that echoes the stem gives itself away (the compiler warns). Pitch the claim one
step above the text — here, *careful planning*, which no single sentence says outright — and author
at least **5** non-supporting sources so the best foils can be chosen.

```
target c1-t8
passage "Aqueducts"
type informational
lines [
  "Rome needed more fresh water than its wells could give. Workers built long channels called aqueducts to carry water to the city. They tilted each channel down just a little, so the water moved on its own. Where the land dropped away, they raised the channel on tall stone arches. Some aqueducts started at springs sixty miles from the city. Crews walked the channels often and cleaned out leaves and mud. People in Rome filled their jugs at open fountains."
]
claims [
  claim id "c1" status supported dimension supporting-evidence subject "the aqueducts"
    text "Roman engineers planned the aqueducts carefully." cites ["e1" "e2"] {}
]
evidence [
  source id "e1" line 1 quote "They tilted each channel down just a little, so the water moved on its own." status directly-supports supports ["c1"] {}
  source id "e2" line 1 quote "Where the land dropped away, they raised the channel on tall stone arches." status directly-supports supports ["c1"] {}
  source id "e3" line 1 quote "Rome needed more fresh water than its wells could give." status irrelevant supports [] rationale "Gives the reason for building, not evidence that the building was planned with care." {}
  source id "e4" line 1 quote "Workers built long channels called aqueducts to carry water to the city." status irrelevant supports [] rationale "Says what was built; a student may read any construction detail as proof of planning." {}
  source id "e5" line 1 quote "Some aqueducts started at springs sixty miles from the city." status irrelevant supports [] rationale "A fact about scale — impressive, but it shows distance rather than design choices." {}
  source id "e6" line 1 quote "Crews walked the channels often and cleaned out leaves and mud." status irrelevant supports [] rationale "Describes upkeep after the aqueducts were finished, not the planning behind them." {}
  source id "e7" line 1 quote "People in Rome filled their jugs at open fountains." status irrelevant supports [] rationale "Describes how people used the water; unrelated to how the system was designed." {}
]
outcomes [
  outcome id "q1" type multiple-choice task-model tm1 dimension supporting-evidence subject "the aqueducts" standard ri-7 focus "c1"
    stem "The reader can conclude that Roman engineers planned the aqueducts carefully. Which detail from the passage best supports this conclusion?" {}
]
{}..
```

## Example (Target 10 — Word Meanings)

The OPTIONS are **meanings** of a targeted `word`, authored in a top-level `words` list — not
claims. One `status correct` meaning + `status distractor` meanings (each a T10 `error-type` +
`rationale`). The outcome's `focus` names the `word`; state the word + its sentence in the `stem`.
Standard `ri-4` + an L-4 strategy code, DOK `r-dok2`.

```
target c1-t10
passage "Aqueducts"
type informational
lines [
  "Roman engineers built aqueducts. The aqueduct carried water across long distances."
]
words [
  word id "w1" text "aqueduct" line 1 quote "The aqueduct carried water across long distances."
    meanings [
      meaning id "m1" status correct text "a channel that carries water" {}
      meaning id "m2" status distractor error-type other-meaning text "a boat that carries cargo"
        rationale "Another meaning that ignores the context." {}
      meaning id "m3" status distractor error-type misinterprets text "a tall tower made of stone"
        rationale "Misreads the sentence." {}
      meaning id "m4" status distractor error-type wrong-context text "a road that crosses a valley"
        rationale "Uses the wrong context." {}
    ] {}
]
outcomes [
  outcome id "q1" type multiple-choice task-model tm1 dimension word-meaning subject "aqueduct" standard l-4a focus "w1"
    stem "Read the sentence: \"The aqueduct carried water across long distances.\" What does the word aqueduct most likely mean?" {}
]
{}..
```

For a **click-the-word** (`hot-text`) T10 item, drop the `meanings` and instead list the clickable
candidates as bare `word`s in the same paragraph — the correct one is the outcome's `focus`, the
rest are distractor candidate words; put only the instruction + definition in the `stem`:

```
words [ word id "w1" text "aqueduct" line 1 {} word id "w2" text "engineers" {} word id "w3" text "water" {} ]
outcomes [
  outcome id "q1" type hot-text dimension word-meaning subject "aqueduct" standard l-4c focus "w1"
    stem "Read the paragraph below. Click the word that means a channel that carries water." {}
]
```
