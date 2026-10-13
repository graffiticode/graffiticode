<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0180 Usage Guide

Agent-facing guide for authoring L0180 assessment items. Read this before composing a `create_item` prompt or an `update_item` modification.

## Overview

L0180 is an authoring language for **web-based assessment items** — quizzes, tests, practice questions and self-checks that render and score in a browser with no assessment platform behind them. Input is a natural-language description of a question; output is an L0180 program whose compiled form is one interaction plus its answer key, ready to deliver — or, for a quiz or test of several questions, an activity (`items [ … ] {}`) holding one of those per question. This is the general-purpose assessment language: reach for it whenever the request is a quiz, a test, a practice question or a comprehension check and no particular vendor or platform is named. It is the right tool for "write me five questions about the water cycle" or "a multiple-choice item on the causes of the Civil War"; it has no sections or item banks, is not a gradebook, and not tied to any LMS format.

A question can stand alone, or be wrapped in an **item** when it needs a reading passage or has several parts answered together. An item says how its parts combine: `additive` sums them, while `conjunctive` awards the point only when every part is right — which is what a two-part evidence question means, where naming the right idea but citing the wrong line earns zero rather than half.

A compiled item has two halves, deliberately separate. `interaction` is everything the candidate sees — the stem and the options — and is safe to send to a browser. `validation` is the answer key and the points available. A practice item ships both and marks itself as the learner answers; a graded delivery withholds `validation` and scores on the server, so the answers never reach the page. Say which you want if it matters; practice is the default assumption.

When composing a request, name the question type first, then the stem, then the options, then which option or options are right. Say what an option is worth only if it is not worth one point — per-option scoring is the default, so partial credit needs no special request. Mention "select all that apply" or a number of answers when you want a multi-select item. Options are presented in a random order by default; say so only when you want them kept in the order you wrote them.

In scope: choice interactions — single-select multiple choice, multi-select, and true/false — with per-option points, weighted answers, penalized distractors, randomized option order by default, unscored polls, exact-set scoring for a "choose exactly these" question, and a rationale on a distractor explaining why it is wrong; hottext interactions, where the candidate clicks a sentence or a word inside the passage itself, including "click any three of these" and click-the-word vocabulary items; fill-in-the-blank, where the candidate types into blanks in a sentence, each recognized answer can carry its own score and explanation, a numeric blank is compared as a number so 0.50 and 1/2 both count as 0.5, and a blank can require a particular written form when that is what the question asks for; dropdown cloze, the same sentence with a menu at each hole for an answer to be recognized rather than recalled; word-bank cloze, where one bank of tokens is shared across every gap and each is spent once; sequencing, where the candidate puts elements in the right order, presented randomly, and the answer never ships with the question; matching, pairing each item with one of a list of targets; classification, the same pairing where several items share a category; written responses collected with their rubric and held for a person to mark; and multi-part items over a reading passage, scored additively or conjunctively. Out of scope: other interaction types (hotspot and sliders are not implemented yet), test and section wrappers, auto-scoring of prose, numeric or symbolic answer matching, media beyond passage and option text, and delivery concerns such as timing, attempts and gradebooks.

## Writing a request

- Give the stem verbatim — the exact wording you want the candidate to read.
- List every option, and say which is correct. Distractors need no annotation.
- State points only when an option is not worth 1.
- Say "select all that apply", or give a number, for a multi-select item.
- Say whether a multi-select gives partial credit. Per-option scoring is the default; ask for all-or-nothing when the question means "exactly these".
- Give a rationale for a distractor when you want the item to explain the mistake back.
- Mention shuffling explicitly; options keep their authored order otherwise.

## Vocabulary Cues

Say this to get that:

- **Multiple choice** — `choice [prompt "…" options [[text "A"] [text "B" assess [correct]]] {}]`. The default: one right answer, one point.
- **True/false** — the same shape with two options. There is no separate word for it.
- **Select all that apply** — adds `max-choices N`, and more than one option carries `assess [correct]`.
- **Exactly these, no partial credit** — `response-processing "match-correct"`, with `min-choices` and `max-choices` both set to the number wanted. Every correct option and nothing else earns the point; a subset or a superset earns zero. This is what "choose the two sentences that belong in a summary" means.
- **Why a wrong answer is wrong** — `assess [rationale "…"]` on the distractor. It scores nothing on its own and is shown only after the candidate picks that option.
- **Worth N points** — `assess [correct points N]`. Only needed when N is not 1.
- **Penalty for a distractor** — `assess [points -1]` with no `correct`. Selecting it subtracts.
- **Keep the options in the order I wrote them** — `shuffle false`. Randomizing is the default for a choice's options, each dropdown's menu and an order's elements. Numbers in sequence and True/False keep their order on their own, and "All of the above" is always pinned last.
- **A named option** — `id "…"` on the option. Ids are otherwise derived as A, B, C…
- **An unscored poll** — omit `assess` everywhere. The item renders and collects but scores nothing.
- **A passage to read** — `item [ stimulus [ title "…" paragraphs [ "…" "…" ] ] parts [ … ] {} ]`. Paragraphs are numbered for the reader, so a stem can refer to them by line.
- **Click a sentence in the passage** — `hottext [ prompt "…" within "stimulus" selections [[quote "…" assess [correct]]] {} ]` as a part of an item. The passage renders once, at the top, with its sentences clickable.
- **Click any N of several right sentences** — add `upper-bound N`. Without it every correct sentence must be clicked.
- **Click the word** — `granularity "word"` with its own `text`. Only the words a selection names are clickable, so author the distractor words too.
- **Fill in the blank** — `text-entry [ text "The capital of France is {{capital}}." blanks [[id "capital" responses [[response "Paris" assess [correct]]] {}]] {} ]`. The `{{id}}` marker positions the blank and names it. Each answer a blank recognizes carries its own `assess`, exactly as a choice option does.
- **Alternate spellings** — one `response` entry each, all `assess [correct]`.
- **Partial credit for a near-miss** — `assess [correct points 1]` beside the full-credit answer.
- **Explain a wrong answer** — `assess [rationale "…"]` on an answer you expect students to type. Shown only once they type it.
- **A numeric answer** — `base-type "float"` on the blank. The answer is compared as a number, so `0.5`, `0.50`, `.5` and `1/2` all count. Use `base-type "integer"` when only a whole number makes sense.
- **A rounded or measured answer** — add `tolerance 0.005`. Absolute and symmetric, evaluated in decimal.
- **"Express your answer as a fraction"** — `input-formats [ "fraction" ]` on the blank. The value is still compared in base 10; only the written form is constrained. `decimal`, `fraction` and `scientific` may be combined; the default accepts all three.
- **A repeating answer such as 1/3** — no decimal equals it, so the blank must either ask for a fraction with `input-formats [ "fraction" ]` or carry a `tolerance`. Anything else is a compile error rather than a blank that marks every decimal wrong in silence.
- **Several blanks** — one marker and one blank each. A blank is worth its best correct answer and the item is their sum, so several blanks give partial credit; wrap it in a conjunctive item for all-or-nothing.
- **A dropdown inside the sentence** — `inline-choice [ text "Plants absorb {{gas}}." dropdowns [[id "gas" options [[text "carbon dioxide" assess [correct]] [text "oxygen"]] {}]] {} ]`. The marker model is text-entry's; the options are a choice's, with the same `assess`. Use it when the answer should be recognized rather than recalled — a menu gives it away, a blank does not.
- **A cloze the student picks rather than types** — the same thing said another way. A sentence is one or the other: a typed blank and a dropdown cannot share an interaction.
- **Put these in order** — `order [ prompt "…" elements [[text "First" assess [position 1]] [text "Second" assess [position 2]]] {} ]`. Write the elements in the order the candidate should see them, never in the right order — `position` is the answer, and the list is the presentation. All or nothing, worth one point.
- **Fill the gaps from a word bank** — `gap-match [ text "The {{a}} orbits the {{b}}." tokens [[id "moon" text "Moon"] [id "earth" text "Earth"]] {} gaps [[id "a" assess [token "moon"]] [id "b" assess [token "earth"]]] {} ]`. One bank shared by every gap, and a token placed in one is spent. Use `inline-choice` instead when each hole has its own menu and an answer may repeat.
- **Match these to those** — `match [ targets [[id "paris" text "Paris"] [id "tokyo" text "Tokyo"]] {} match-items [[text "France" assess [target "paris"]]] {} ]`. Every target needs an `id`, because that is what an item names; item ids derive. A target nobody names is a distractor. One target to one item — if they are meant to be shared, it is a classification.
- **Sort these into groups** — `classification [ categories [[id "mammal" text "Mammal"]] {} classification-items [[text "Whale" assess [category "mammal"]]] {} ]`. The same shape, and the one where several items share a group.
- **A written answer** — `extended-text [ prompt "…" rubric [[points 2 descriptor "…"] [points 0 descriptor "…"]] {} ]`. Nothing scores it; the rubric ships with it and a person marks it. Put it in an additive item so the rest still scores.
- **Two parts, both required** — `scoring "conjunctive"` on the item. Every part must be right for the point.
- **Two parts, scored separately** — the default `additive`; the item is worth the sum of its parts.
- **Program terminator** — every L0180 program ends with `..`.

## Example Prompts

- *"A multiple-choice question asking what 2 + 2 is, with options 3, 4 and 5, where 4 is correct."* → `choice`
- *"Which planet is closest to the Sun? Mercury is right and worth 2 points; penalize 'The Moon' by a point."* → `choice`
- *"Select all the prime numbers from 2, 4, 5, 9 and 11 — 2, 5 and 11 are correct. Shuffle the options."* → `choice`
- *"True or false: the Pacific is the largest ocean. True is correct."* → `choice`
- *"Ask which of four animals is a mammal — blue whale, great white shark, sea turtle, octopus — and give the options readable ids."* → `choice`
- *"An ungraded poll asking which topic students found hardest: fractions, decimals or percentages."* → `choice`
- *"Choose the two sentences that belong in a summary of the passage — all or nothing, no partial credit."* → `choice`
- *"Which gas do plants absorb? Explain to a student who picks oxygen why that is the gas plants release."* → `choice`
- *"A two-part reading question about a short passage: first what the reader can conclude, then which line supports it. Both parts must be right for the point."* → `item`
- *"Show a passage and ask the student to click the sentence that best supports the inference."* → `hottext`
- *"A fill-in-the-blank: 'The ___ is the powerhouse of the cell', answer mitochondria."* → `text-entry`
- *"Read the sentence and click the word that means 'a channel that carries water'."* → `hottext`

## Out of Scope

- **Other interaction types** — ordering, matching, classification, inline dropdowns, hotspot and sliders are not implemented yet. A request for one should not be answered with a choice item that approximates it.
- **Expressions, units and symbolic answers** — a numeric blank understands whole numbers, decimals, simple fractions and scientific notation. `1/2 + 1/3`, `5 cm` and `x/2` are not evaluated, and nothing judges algebraic equivalence. It also does not judge whether a fraction is in lowest terms: `2/4` counts as `1/2`.
- **Tests and sections** — L0180 authors single items, not test packages, navigation or sequencing.
- **Auto-scoring prose** — `extended-text` collects a written response and ships its rubric, but nothing here judges the writing. The score comes back pending, for a person to settle.
- **Delivery policy** — timing, attempt limits, feedback timing, and gradebooks belong to the host, not the item.
