<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0178 Boundary tests

Prompts that must be TURNED AWAY, not answered. They are the counterpart to `examples.md`, and
they are kept apart from it on purpose: that file's contract is that every prompt in it yields a
program worth retrieving, and these yield no program at all. Marking one of their outputs as
training data would teach the generator to answer a request it is supposed to decline.

Run them to check the boundary holds; discard whatever they produce. Two prompts (the first section below) moved here from examples.md's advisory-warning section for the same reason — their programs would bake a value the
vocabulary says not to author (an over-maximum `limit`, a hand-authored `next`) into a RAG row
that carries no warning to explain it.

## Anti-pattern values (a correct program cannot demonstrate these)

1. Pull all Items from bank 4021 with a page size of 200 so it goes faster.
2. Continue the Item read from cursor 1445216251.1165015, all remaining pages.

## Not built yet (should be declined, not designed)

Only 30 of the Data API's 57 operations are modelled. A request for an unbuilt one must be turned
away rather than answered with the nearest thing — see `coverage.md`.

3. Duplicate Items 1-50 from bank 4021 into bank 386. *(itembank/items/duplicate — unbuilt. Note itembank/items + set IS built; it is duplication that is missing.)*
4. Duplicate activity unit-3-quiz into our sandbox bank. *(itembank/activities/duplicate — unbuilt)*
5. Kick off a subscore recalculation for these sessions and poll it until it finishes. *(jobs/sessions/scores/subscores — unbuilt. Note the POLLING half is now built as `jobs-get`, and `offlinepackage-get` is a built async producer; it is this particular producer that is missing, so decline the recalculation rather than the polling.)*
6. Pull the score summary for every session in activity numeracy. *(sessions/scores — unbuilt; sessions/responses is the one modelled read)*
7. Clear out every session from last school year in bank 386. *(sessions + delete IS built, but accepts ONE session per request and is scoped to right-to-be-forgotten deletions. Bulk cleanup is not this operation — Learnosity directs it to support. Decline rather than emitting a loop.)*

## Must not produce a composition

L0178 is atomic. These read as though content has to be authored first, which is what led a
generated program to emit `data use "0176"` and the console to obey it — the reactive
composition path does not consult `composesWith`. The correct output is a plain `data-job`
that describes the write; the payload is the caller's to supply.

1. Publish item alg-quad-3 into bank 386. *(a bare imperative — must still yield an atomic program, never `data use "0176"`)*
2. Write a new multiple-choice item into bank 386 and make it live. *(authoring AND moving — the authoring half is not this dialect's, and is not an upstream to call)*

## Out of scope (should be redirected, not designed)

8. Write me a multiple-choice question about photosynthesis with four options. *(item content → L0176)*
9. Embed the Learnosity item editor so our authors can edit these Items. *(a UX over the data → L0177)*
10. Build me a dashboard that charts these session scores by class. *(a rendered report — the UX view of results; no dialect covers it yet)*
11. Give me the Node.js code to page through the Item bank. *(the recipe is language-neutral; it describes the procedure, it doesn't emit code)*
