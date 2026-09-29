<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0181 Usage Guide

Agent-facing guide for authoring flashcard decks in L0181. Read this before composing a
`create_item` prompt or an `update_item` modification.

## Overview

L0181 is an authoring language for **flashcard study decks** — a deck of two-sided cards that
a learner flips one at a time, rating each as *I got this* or *I need more practice*. Those
ratings sort the deck into stacks, so a second pass can be just the cards that did not stick.
Input is a natural-language description of the deck (the subject and the pairs, plus any title
or instructions); output is an L0181 program whose compiled value is a deck the player renders
and the learner studies. Every program is a `cards` list of two-element `["front" "back"]`
pairs followed by optional `title`, `instructions` and `theme`, ending in a record literal:
`cards [...] title "..." {}..`. A side may be prose, LaTeX math wrapped in `$…$`, or an image
URL — so L0181 suits vocabulary, historical dates, formula drills and picture identification
equally. It is the right tool when the job is "a studyable deck of two-sided cards"; it is not
a scored assessment (use L0180 for quizzes and answer keys), a spaced-repetition scheduler, or
a matching or memory game.

When composing a request, name the subject first, then the pairs, then any title,
instructions or theme. Put the term on the front and what the learner is trying to recall on
the back. Both sides of every pair must be text, and the deck needs at least one pair. Do not
ask for a particular card order or shuffle — the player shuffles, and the learner's ratings
decide what comes back.

## Vocabulary Cues

Say this to get that:

- **The deck** — `cards [["front" "back"] ...]`. "Flashcards for…", "a deck of…", "cards
  with X on the front and Y on the back".
- **Title** — `title "Spanish Vocab"`. "Title it…", "called…".
- **Instructions** — `instructions "Flip each card to check yourself."`. "With the
  instruction…", "tell the learner to…".
- **Theme** — `theme DARK` or `theme LIGHT`. "A dark deck", "on a light background". Written
  as a bare tag, never as a string.
- **Math** — wrap it in `$…$`. "The front is $x^2$, the back is 'x squared'" →
  `["$x^2$" "x squared"]`. Text outside the delimiters stays prose.
- **Images** — put the URL in place of the text. "The front is the flag at X, the back is
  'Japan'" → `["https://…" "Japan"]`. There is no separate word for images. Give the URLs
  yourself: an invented one renders as a broken card, and no error says so. A URL you supply
  is used exactly as you wrote it, whatever the host — it is your link, and it is not second-
  guessed. Ask for pictures without URLs and you get the description as text instead.
- **The trailing record** — every program ends `{}..`. Don't drop it.

## Example Prompts

- *"Make a flashcard deck titled 'Spanish Vocab' with five pairs: hola/hello, adiós/goodbye,
  por favor/please, gracias/thank you, agua/water."* → `flashcards_deck`
- *"Flashcards for LaTeX-rendered math: $x^2 + 2x + 1$ / $(x+1)^2$; $a^2 - b^2$ /
  $(a+b)(a-b)$."* → `flashcards_deck`
- *"Biology vocab flashcards: photosynthesis, mitosis, osmosis and respiration, each with its
  definition on the back. Add the instruction 'Flip each card to check yourself.'"* →
  `flashcards_deck`
- *"A dark-themed deck of state capitals: California/Sacramento, Texas/Austin,
  Florida/Tallahassee, New York/Albany, Illinois/Springfield."* → `flashcards_deck`
- *"Flashcards titled 'Flags' with the country name on the back and the flag on the front,
  from https://flagcdn.com/w320/jp.png for Japan and https://flagcdn.com/w320/br.png for
  Brazil."* → `flashcards_deck`
- *"Times tables flashcards for the sevens, 7×1 through 7×12, with the product on the
  back."* → `flashcards_deck`

## Out of Scope

- **Matching and memory games** — pairing terms against definitions on a board, or
  concentration-style pair-finding. L0181 is flashcards only.
- **Scored assessments** — quizzes, tests, answer keys, rubrics, partial credit. Use L0180.
  A flashcard rating is the learner's own judgement, not a grade.
- **Spaced repetition** — L0181 configures a deck and records how the learner rated it; it
  does not schedule reviews or model retention over time.
- **Dynamic deck generation** — the cards are literal in the program. L0181 does not fetch
  them from a data source at run time.
- **Card shapes other than two sides** — no three-sided cards, no several answers to one
  prompt, no hints as a separate field.
- **Ordering and shuffling policy** — the player shuffles; the program emits the deck, not
  the order it is studied in.
