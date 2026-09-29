# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

L0180 is a Graffiticode dialect for **web-based assessment delivery**: quizzes, tests and
practice questions that render and score in a browser with no assessment platform behind them.
It exists because the catalog had no ungated general assessment language — L0176 covers the
item types but is vendor-gated to Learnosity, and L0175 is Grade-5-ELA-only, so "make me a
five-question quiz" routed nowhere.

The central design commitment: **a compiled item is `interaction` and `validation`, kept
apart.** `interaction` is everything the candidate sees and is safe to send to a browser;
`validation` is the answer key. A practice item ships both and marks itself; a graded delivery
withholds `validation` and scores server-side. Anything that would smear the two together — a
correct flag on a rendered option, a score computed into the presentation — breaks the only
property that makes graded delivery possible.

Ported conceptually from L0179 (the `validation` model), L0176 (the attribute machinery), and
L0175 (native React item rendering). No code is inherited from L0160, the previous attempt,
which was a facade over the Learnosity Data API.

## Commands

```bash
npm run build      # core → build-static → api → view → view:embed → assemble
npm run dev        # API on :50180 (expects Firestore emulator :8080, local auth :4100)
npm run start      # the built API server
npm test           # core + view suites
npm run lint       # ESLint over the monorepo
npm run gcp:deploy # Cloud Run as l0180, us-central1, port 50180

npm run -w packages/view dev   # the /form embed app on Vite alone, no API, no auth
```

`view dev` is the fast loop for renderer work: it builds `embed/` against `src/` directly, so
a component change is visible without a compile round trip through the API.

`npm run assemble` wipes and repopulates `packages/api/static/` from `core/dist/static` and
`view/dist-embed`. It is not incremental — a stale file cannot survive it, which is the point.

Tests are Vitest, colocated as `*.test.ts`, and there is no root Vitest config — each
workspace runs its own. Run one with
`npm run -w packages/core test -- -t "the starter template compiles"` (or `-w packages/view`).
**The core suite must run with `packages/core` as the cwd**, which the workspace script does:
`docs.test.ts` reads `spec/*` by relative path.

## Architecture

Three workspaces on the published `@graffiticode/l0000` (^0.2.0) and `@graffiticode/l0000-view`.

- **`packages/core`** (`@graffiticode/l0180`) — the language. `attributes.ts` is the vocabulary
  as data; `lexicon.ts` and `compiler.ts` both generate from it; `spec/` is what agents read.
- **`packages/api`** (`@graffiticode/api-l0180`, private) — Express: `POST /compile`,
  `GET /form`, a health check at `/`, and the assembled static assets. Two placements are
  load-bearing: the static mount comes **before** the auth middleware, so `lexicon.json`,
  `schema.json`, `instructions.md` and friends need no token; and a
  `Cross-Origin-Resource-Policy: cross-origin` header goes out on everything, without which
  COEP-isolated hosts (the claude.ai and chatgpt.com widget iframes) block the `/form` frame
  outright. `GET /lexicon.js` is a hand-registered alias serving `lexicon.json` for the
  still-deployed console; no such file is emitted.
- **`packages/view`** (`@graffiticode/l0180-view`) — the `Form` and the scorer.

### The attribute table drives everything

`packages/core/src/attributes.ts` holds one row per word. The lexicon entry, the Checker method
and the Transformer method are all generated from it, arity included, so a word can never be
declared with one arity and handled with another. **Never hand-write an attribute handler.**
Only containers (`ITEM`, `PARTS`, `CHOICE`, `OPTIONS`) and `PROG` are written out, because each
has a second argument role or an assembly step the table cannot express.

The style is attribute lists, per `console/docs/language-authoring-style.md` — the canonical
spec for authoring a Graffiticode dialect. Read it before adding vocabulary.

### Value validation goes in the Transformer, never the Checker

`Checker.LIST` (inherited from L0000) visits only `elts[0]`. A validation rule written as a
Checker method therefore fires on the first element of a list and nowhere else — in a style
built on lists, that is almost nowhere. L0166 shipped a Checker rule rejecting negative points
that silently did nothing for exactly this reason. The generated Checker methods here walk the
tree and do not judge; `checkValue` runs in the Transformer, where every element is visited.

### Error messages are a product surface

The generator is an LLM that reads a compile error and tries again. `assertKnownAttributes`
names the legal set *and where the misplaced word belongs* — "`correct` is not an attribute of
option. It takes: id, text, assess. `correct` belongs inside `assess`." The tests assert on
that message text, not merely that compilation failed, because a message that stops naming the
fix is a regression even when the program still errors.

### Three words break the arity-1 rule, deliberately

- **`correct` is arity 0.** `assess [correct points 2]` folds to `[{correct: true},
  {points: 2}]` and merges. At arity 1 it would swallow `{points: 2}` as its argument and
  silently lose the score.
- **`options` and `parts` are arity 2** — member lists: homogeneous children plus the
  container's own configuration record, written `{}` when empty. Every member list added later
  takes the same shape, so the generator applies one rule rather than memorizing exceptions.

Everything else takes exactly one argument. Keep that set small and stated in
`spec/instructions.md` — whose "Writing an attribute" preamble still names only `options`, and
should name `parts` too.

### The item wrapper, and why conjunctive scoring exists

A bare interaction is a whole program. `item` wraps one or more of them with an optional
`stimulus`, and its `scoring` decides how they combine. `additive` sums the parts.
**`conjunctive` awards the item's points only when every part is fully correct** — the shape a
two-part evidence question needs, where naming the right idea while citing the wrong line
earns zero rather than half. That is the requirement L0175's EBSR imposes, and it is why the
wrapper is not just a container.

Two consequences worth keeping:

- A conjunctive item refuses to compile if any part is unscoreable, because "every part
  correct" is meaningless over a part that cannot be correct.
- `points` is rejected on an additive item. The item is already worth the sum of its parts, so
  an authored figure would be a second, disagreeing answer to what a correct response earns.

Part ids are numeric (`"1"`, `"2"`) and option ids are letters, deliberately: the response is
keyed by part id, and a part could otherwise be mistaken for an option. `ItemView` passes each
part only its own slice and merges on the way back up, so a part component is identical
standing alone or nested.

Only the item reports a score — parts render with `showResult={false}`. A per-part "Correct"
while a conjunctive item earns nothing is actively misleading. Option-level ✓/✗ still show.

### The activity level, back-ported from L0182

`items [ … ] navigation "linear" submission "individual" {}` is the level ABOVE `item`. An
`item` groups interactions over one stimulus and scores them **together**; an activity groups
several of those, scored independently — which is what a quiz or a test actually is. L0176
already establishes the family's shape (an activity IS a list of items) and QTI supplies the
delivery vocabulary, so nothing here was invented for L0180.

L0182 built it first and this is a port, not a shared module — the two languages stay
independent on purpose. `activity.ts` is kept free of L0180's own concepts for the same reason
it was kept free of L0182's: that is what let it move, and what will let it move again.

**One word from the contract could not come.** The back-port surface named `title` at arity 2
for the activity. L0180 already has `title` at arity 1 inside `stimulus`, and the lexicon gives
a word exactly one arity, so taking it would have broken every stimulus in the corpus. It was
left out rather than renamed; an activity that needs a name can gain its own word later, and
naming is not what the level is for. `items`, `navigation` and `submission` were all free.

**The defaults are what L0180 already does, not what reads best on paper**: `nonlinear` and
`simultaneous`, because every item is laid out on one screen and nothing is submitted anywhere
in between. L0182 defaults the other way — `linear`, `individual` — because its delivery
genuinely is a per-item flow with a server behind it. A default that contradicts the renderer
would be a statement the language cannot keep.

Which is also why `submission` changes nothing in the renderer and says so. There is no server
in this loop, so every answer is already submitted the moment it is given; the word is carried
in the compiled output for a delivery host to act on. `navigation` **is** honoured — `linear`
shows one item at a time with no Back control, because QTI's word means the candidate cannot
return to one they have left, and offering the button only to refuse it is worse than not
offering it. The last item has no Next either: a control that cannot advance is a dead button.

**The activity cursor is local React state, unlike L0182's.** There it must survive a reload,
because a participation lives on a server and a participant may come back to it. Here nothing
is persisted mid-activity, so the cursor has no reason to enter the model — and keeping it out
means answering an item cannot move it. This is *not* the shuffling hazard that `order` and
`shuffling.ts` document: that is about a value the COMPILER would recompute on every response,
and nothing recomputes a cursor.

**`isAnswered` was extracted rather than copied.** `ItemView` needed it per part and
`ActivityView` needs the same question one level up. A second copy would have drifted, and the
drift would show as a result banner appearing at one level and not the other for the same
response. The rule is not "the key is present": a text-entry, a pairing and a gap-match all
answer with a container that exists from the first click, so a half-finished response is short
rather than absent and has to be counted against the holes the interaction actually has.

`scoreActivity` sums the items and there is deliberately no activity-level scoring mode.
`conjunctive` binds the PARTS of one item together; nothing binds items to each other, so an
authored mode would be a second, disagreeing answer to what the items already say. It sums the
FLOORED per-item scores, so a penalized distractor in one item cannot subtract from another —
which is the case `Score.points` was already floored for.

**Several questions without `items` are refused in `PROG`, bracketed or not.** Both shapes used
to compile clean and deliver wrong: `[ choice … choice … ]` to a bare array no renderer reads,
and `choice … choice …` to the LAST question alone, the rest dropped by `v0.pop()`. It was found
live — asked for a five-question quiz before the activity level was deployed, the generator
wrote the bracketed form and got no error to retry from. The refusal names `items [ … ] {}`
because that message is the generator's only route to the fix. A "question" here is anything
carrying `interaction`, `pending` or `activity`, so a single item and a real activity pass
untouched. The spec says the same thing up front, in `instructions.md`'s opening paragraph,
because a quiz is the request most likely to arrive and least likely to look like one program.

### Every choice needs its own radio group

`ChoiceItem` takes its group name from `useId()`. A fixed name put both parts of a two-part
item into one native radio group, where the browser enforces mutual exclusion across the whole
group — answering Part B silently unchecked Part A. Unit tests cannot see this; it took
rendering a real two-part item to catch. Any future interaction using radios needs the same
treatment.

### One way to say what something is worth

**Every scoring statement in the language is an `assess` on the thing being scored.** An option
has one, a hottext selection has one, and each answer a text-entry blank recognizes has one.
`assess` says `correct`, `points`, `rationale`, or a combination, and it means the same thing
everywhere.

`text-entry` shipped without this and it showed: `accept` was a bare list of strings with
`{correct: true, points: 1}` hard-coded, so a language that could explain a wrong multiple-choice
option could not explain a wrong typed one, or give a near-miss partial credit. Adding an
interaction whose key does not fit this shape is the mistake to avoid — it is the fourth
breaking change to compiled output and every one of them was this.

Rubric bands are the one scoring statement with no `assess`, because a band **is** an assessment
rather than a thing being assessed. They still say `points`, not `score` — one word per concept.

### A blank is worth its BEST answer, not their sum

`choice` sums, because several options can be selected. A blank is single-cardinality: only one
answer can be typed into it, so summing would let it claim points nobody can earn. The
interaction is worth the sum of its blanks. The difference is cardinality, not inconsistency.

### `baseType` decides what a key is made of, and it lives per response variable

`validation` is QTI's response declaration, so it carries `cardinality` and `baseType` — not the
interaction, which carries `maxChoices`. Both are derived rather than authored.

`identifier` means the response is things the candidate selected, and a `mapping` key names an
option or a unit. `string`, `float` and `integer` mean the response is what they typed, and the
key names a blank.

**On a text-entry, `baseType` sits on each mapping entry rather than at the top**, because a
text-entry has one response variable per blank and QTI gives each its own declaration. A numeric
blank can sit beside a text one in the same sentence, so a single top-level value would be a
claim that is false. `cardinality` stays at the top because it does not vary: every blank takes
one typed value. **Move what varies, keep what does not.**

The consequence is that the scorer cannot dispatch on a declared field. `scorePart` branches on
the mapping entries carrying a `responses` array, which only a typed key has — structural rather
than declared, and worth knowing before wondering why.

### Arithmetic is decimal

Numeric answers go through **decimal.js**, matching L0179 and L0166. Not a preference: `0.1` has
no exact binary representation, `0.1 + 0.2 !== 0.3`, and a tolerance comparison at its boundary
would land either side of the line depending on the values. An assessment scorer is the wrong
place for that.

`base-type "float"` with no tolerance already makes `0.50`, `.5`, `1/2` and `5e-1` equal `0.5`,
because all five parse to the same number. Tolerance is for rounding on top of that, and it is
absolute and symmetric — QTI's `absolute` mode.

Whole numbers, decimals, a sign, simple fractions and scientific notation are understood.
Expressions, units and symbols are not, and that boundary is deliberate: it is where L0176
reaches for Learnosity's math engine.

### `input-formats` constrains the writing, never the value

`parseNumber` returns both what a number is worth and **how it was written**, because "express
your answer as a fraction" is a real question and a decimal does not answer it. `input-formats`
lists the accepted forms; the comparison is still base 10, so `2/4` counts for `1/2` and the
form check is a separate gate on top of a match.

Three rules keep it from becoming a second answer key:

- **The default is `numeric`, the umbrella meaning all forms,** and it *expands at compile time*.
  `permittedFormats` turns it into the concrete list, and `inputFormats` is emitted only when it
  is a strict subset — the same rule `tolerance` and `upperBound` follow. A field always present
  says nothing; a field present only when it constrains is readable. `numeric` beside a
  particular form is refused as a contradiction rather than silently widened.
- **It constrains what is typed, not what is authored.** The key for a fraction question is
  ordinarily written `0.5`. Constraining the author too would force keys that mean something
  other than what they say, and the word says *input*.
- **A right value in the wrong form is its own outcome**, `wrongFormat`, not a bare zero. The
  candidate did the arithmetic; a report that cannot tell that apart from not knowing the answer
  is reporting the wrong thing. The scorer returns the accepted forms and the renderer names
  them in English — the phrasing is presentation, so it stays out of the DOM-free module.

### A repeating answer is refused, because nobody can type it

`1/3` divides to twenty threes at decimal.js's precision, and `0.333`, `0.3333` and every decimal
a student would actually write compare unequal — including, for `2/3`, the twenty-digit
truncation, since it rounds up. So a key that repeats grades silently: right answer, no mark, no
explanation. That is precisely the failure numeric blanks were built to remove, so `cut` refuses
it unless the blank asks for a fraction or carries a `tolerance`.

`matching.ts` decides this with `terminates()` — reduce the fraction and check that its
denominator is built only from 2s and 5s, the factors of ten. Two rules it follows:

- **Reduce first.** `100/300` repeats and `4/2` does not; testing the written denominator gets
  both backwards.
- **Anything it cannot analyze answers `true`.** It decides whether to REFUSE a program, and a
  check that is unsure must not be the one doing that.

Accepting decimals *alongside* fractions is not a way out and is refused too — the decimal half
stays unreachable, so half the accepted forms would still grade in silence.

### Two response-processing templates, named for QTI's

`validation.responseProcessing` decides how a response scores, and it decides the SHAPE of the
key. QTI treats `correctResponse` and `mapping` as alternatives; so do we, so no field's
meaning depends on another field's presence.

- **`map_response`** (the default) carries `mapping` — per option, `{correct?, points}`. Score
  is the sum of the selected options' points.
- **`match_correct`** carries `correctResponse` — the set that must be selected exactly. A
  subset scores zero and so does a superset. Per-option `points` is a compile error under it.

This pair is why exact-set scoring was never the conflict it was long taken for. Per-option
points and all-or-nothing are not competing models of the same thing; they are QTI's two
standard templates, and the language names which is in force rather than picking a winner.

Read the correct set through `correctIds(validation)` rather than reaching into either field —
the renderer's ✓/✗ and the scorer must not be able to disagree.

`validation.feedback` is a third, separate map: option id → rationale. Separate because QTI
keeps feedback apart from scoring, and because it has to work under `match_correct`, where
there is no `mapping` to hang it on. It is in `validation`, so a graded delivery withholds it,
and the renderer shows it only under an option the candidate actually selected.

### Scoring

`packages/view/src/scoring/` has **no React and no DOM anywhere in its import graph**, because
the same module has to run server-side to score without shipping the key to the browser. L0166
exported its scorer from the same entry as its Form and could not be loaded in bare Node. It
has exactly one import — `@graffiticode/l0180/matching`, which is DOM-free — which is what lets
`conformance.test.ts` over in `packages/core` import it by relative path and score what it just
compiled. Anything heavier would break that, and would ship the compiler to the browser besides.

Points resolve at compile time, so the scorer does arithmetic and nothing else. Under
`map_response`, `validation.points` sums only the `correct` options — a penalty must not be
able to move the ceiling, or a fully correct response could never equal it. An item's score is
floored at zero; `Score.rawPoints` carries the unclamped sum for a host that wants signed item
scores.

### PROG spreads `data` first, unlike L0179

`resume(e0, { ...data, ...val })` — the fresh compile wins. `data` carries the learner's
response, but after one round trip it also carries the *previous* compile's `interaction` and
`validation`, because the View merges each compile result back into the model. Letting those
shadow the newly compiled ones would render a stale item forever. L0179 spreads the other way
on purpose: its learner edits live inside `interaction.cells` and must survive. Here a response
is a separate key and needs no such protection.

### The View harness is not ours

It lives in `@graffiticode/l0000-view` and owns the URL params (`id`, `access_token`, `origin`,
`data`), the `postMessage` contract with the parent window, and the recompile loop. L0180
supplies only `Form`. Its action protocol already carries a `response` action that triggers
recompile — that is the learner-response channel, so scoring needs no transport of its own.

L0180 uses the default `formModel: "live"`. The `"loaded"` mode exists for L0166's uncontrolled
ProseMirror grid and does not apply here; the choice renderer is fully controlled, holding no
answer state of its own.

### Preflight is off, and one rule has to come back

`tailwind.config.js` disables preflight so this published component never injects a global
reset into a consumer app or the page hosting the `/form` iframe. But preflight is also what
sets `border-style: solid; border-width: 0` on every element — without it, Tailwind's
`border-*` utilities set a colour and a width against CSS's default `border-style: none`, and
every bordered card renders with no border at all. `src/index.css` restores that one
declaration, scoped to `.l0180-item` rather than the document. The Form's root carries that
class; a new component tree that wants borders must sit inside it.

## Spec is tested, not decorative

`docs.test.ts` is the gate on `spec/`, and it checks six separate things. A wrong example is
not a documentation nit — the generator writes from `instructions.md` and retrieves from
`examples.md`, so it is reproduced verbatim into generated programs.

- Every fenced program in `spec/spec.md` and `spec/instructions.md`, plus `spec/template.gc`,
  **compiles** — not merely parses. A stale example parses fine and dies in the builder, which
  is exactly how one survives behind a parse-only guard.
- Every documented word exists in the lexicon with the signature the docs claim, and every
  L0180 word (derived as `lexicon` minus L0000's) is documented. Adding a word cannot escape
  the documentation gate by being left out of a list.
- **`spec/schema.json` is validated against real compiled output** — every spec program's
  result, plus both interaction shapes and both response shapes. It is draft 2020-12, so the
  test imports `ajv/dist/2020.js`; the hoisted ajv 6 cannot read it. Nothing checked the schema
  against reality until an item shipped whose `parts` carried an `id` the schema forbade.
- The `## Which words each container takes` table in `instructions.md` must equal
  `validAttributes` exactly, container for container. If they disagree the docs teach a program
  the compiler refuses.
- `examples.md`'s numbering is coherent: prompts run `1..N` with no gaps, category ranges tile
  the whole list in order, and the count stated in the preamble is the count present.
- **`scope.json` and `language-info.json` agree with the lexicon about which interactions
  exist.** Both are copied to `dist/static` and read by an agent deciding whether a request
  routes here at all, so a stale one does not merely misinform — it sends the work elsewhere.
  Untested, `scope.json` had already drifted: it went on ruling out multi-part items — "one
  interaction per program" — for two releases after the `item` wrapper shipped. The test
  derives the interaction set (dialect containers of arity 1, less `item`), reads the
  `out_of_scope` sentence naming what exists and what does not, and fails if either half
  disagrees — so adding an interaction fails the suite until both files know about it.

Prose, though, is still prose. Nothing can check that an `in_scope` line describes a capability
accurately, so **re-read `scope.json` whenever the language gains one**; the derived gate only
catches a whole missing interaction.

`spec/usage-guide.md`'s `## Overview` section is extracted into `dist/static/language-info.json`
as `authoring_guide`, and the build **fails** if it is missing or under 100 chars. Edit the
Overview, not the JSON — `language-info.json` must not carry that key itself.

## Adding an interaction type

1. Add its words to `attributeFields`, and its container to `lexicon.ts`.
2. Add the container's allowed set to `validAttributes`, block levels included.
3. Write the container's Transformer method; assemble `interaction` and `validation`.
4. Add a scorer case, keeping the module DOM-free.
5. Add a renderer and register it in the `RENDERERS` map in `interactions.tsx` — not in
   `Form.tsx`, which only chooses between an activity, an item and a bare interaction.
   **If its response is a container rather than a value** — a map of holes, a list of pairings —
   give it a case in `answered.ts`, or a half-finished answer counts as done and a result shows
   over it, at both the item and the activity level.
6. Extend `spec/schema.json` — a `$defs` entry plus the `oneOf` in `anyInteraction`, **and the
   one inside `itemInteraction.parts`**, which is a separate union and the easy one to miss.
   An activity's members reference `anyInteraction`, so they need no third edit.
   `validation` needs nothing: `responseValidation` is interaction-agnostic, keyed by
   identifier, and already shared. `docs.test.ts` validates every spec program's output against
   the schema, so a new type fails the suite until it knows about it.
7. Document it in `spec/instructions.md` (the Functions signature table **and** the container
   table — both are asserted) and in `spec/spec.md`, each with a compiling example.
8. Add prompts to `examples.md` as a new numbered category, updating the range in the category
   header and the count in the preamble.
9. Extend `supported_item_types` in `spec/language-info.json`, and move the type out of
   `spec/scope.json`'s `out_of_scope` sentence into `in_scope` — it is listed there as not
   implemented, and `docs.test.ts` fails until both files agree with the lexicon.

## L0175 conformance

**`L0175-CONFORMANCE.md` at the repo root is the design record** — the QTI ontology and where
it came from, and the R1–R9 requirement set, now complete. What follows is the summary.

L0175 is a *content* language — it composes the passage, the claims and the error-typed
distractors. L0180 delivers the result, and the bar is that any item an L0175 spec describes is
expressible here and **scores identically**. `conformance.test.ts` is that gate: it compiles a
program per delivered shape and asserts the scorer against L0175's own `SCORING` map
(`l0175/packages/core/src/compiler.ts:1257-1263`). It asserts on behaviour rather than shape
because L0175's own coverage check substring-matches string literals — an EBSR item collapsed
into a single choice passes it.

### The round trip asks the other half of the question

`conformance.test.ts` proves L0180 *can* express each shape — the programs in it were written by
hand. `packages/core/tools/roundtrip/` asks whether a **generated** one scores the same, over
five real L0175 items covering every type in `SCORING`. `npm run roundtrip:fixtures` compiles
them with L0175's own compiler (the sibling repo, loaded by path — it must never become a
dependency), `npm run roundtrip:prompts` prints each as English, and `npm run roundtrip` scores
both sides of whatever was generated into `generated/*.gc`.

Two rules make a comparison across the language boundary mean anything:

- **A case says what was picked, not which id.** L0175 keys `A`, `B`, `C` and L0180 derives its
  own, so `compare.ts` aligns by normalized text — hottext's rule, for hottext's reason. An
  option with no counterpart is a finding, never a silently skipped case.
- **The expectation is L0175's rule, not L0180's output.** One point, all or nothing, so the
  battery is mostly near-misses: a subset, a superset, one part of two. An additive EBSR out of 2
  that pays 1 for half an answer passes every shape check there is and fails this.

`compare.test.ts` gates it offline against committed fixtures — `port.ts` builds the mechanical
program for each and all five score identically, and five negative controls prove the comparison
bites. The first live run scored 4/5; the fifth request was routed by the platform to L0175 and
never reached this language, which the report says as `ROUTED` rather than as a compile error.

**Every L0175 item type is covered**: `multiple-choice`, `multi-select` (exact-set), `ebsr`,
all three `hot-text` shapes, and `short-text`. `conformance.test.ts` asserts each against
L0175's rules, and its last test lists the words that must exist — the place a new L0175 item
type would land.

### `human` is not "unscored", and the difference is a lie if collapsed

An unscored poll has nothing to earn (`points: 0`). An `extended-text` has points that nobody
has awarded yet. Reporting the second as `0 / 2` would tell a candidate they earned nothing on
work no one has read, so `Score.pending` keeps them apart: an item holding a written part
reports what its other parts earned, says the rest is pending, and is never `correct`.

`conjunctive` refuses a written part at compile time — "every part correct" cannot be decided
over one — so a written response belongs in an additive item, where the rest still scores.

### Typed answers keep local state; clicks do not

`ExtendedTextItem` and `TextEntryItem` are the two renderers that hold answer state of their
own, and they have to. Every other interaction is fully controlled, which is cheap because a
click is discrete: report it, read the model back, one recompile. An input reporting every
keystroke would recompile the item per character.

So both draft locally and commit on **blur**, with a `useRef` guarding the effect that adopts an
externally changed response, so a fresh compile never clobbers live typing. `TextEntryItem`
compares the committed response as a serialized string rather than by identity — the model hands
down a fresh object every render, and an identity check would reset the draft under whoever is
typing.

### `text-entry`: the marker names the blank

`{{<id>}}` positions a blank and names it, and the answer binds to the name. That is QTI's
`response-identifier` model, where an inline interaction binds to a sibling response
declaration. Learnosity's `{{response}}` carries no identity and its answers are a parallel array
matched by order of appearance, so reordering a clause silently rebinds every answer after it —
and L0176 has no check that the two counts even agree. **The delimiters are theirs; the binding
is not**, and that is the whole difference.

Named binding is also what makes the cross-checks expressible: a marker no blank declares, a
blank with no marker, a marker used twice. `textentry.ts` owns them, and a positional model could
not report any of them. It also refuses **two responses that normalize alike** — both would claim
the same typed input, and the scorer would silently take whichever came first.

`blanks` holds the holes; `responses` inside a blank holds the answers it recognizes, each with
its own `assess`. **Relative to QTI those two words trade places** — QTI makes the blank the
response variable and the answers `qti-map-entry`s — and that is deliberate. L0180 has never used
QTI's element names, and the fidelity lives in the compiled shape, which still carries `mapping`,
`cardinality` and `baseType` under QTI's own names.

The value word is `response`, not `text`, because `text-entry` already has a `text` attribute —
the sentence — and one word meaning two things a level apart is what the 1:1 word-to-field rule
exists to prevent.

A rationale sits **on the response**, not in the top-level `feedback` map that `choice` uses. A
typed answer's identifier is its own text, which can repeat across blanks — `"Paris"` may be
wrong in one and right in another — so a flat map cannot key it. Asymmetry with a reason.

Comparison is deliberately gentler than hottext's quote matching, which strips all punctuation
so a quote can find its sentence. Here the typed string IS the answer, so only whitespace is
normalized — `cant` must not pass for `can't`.

**`core/src/matching.ts` owns every comparison rule, and is published as
`@graffiticode/l0180/matching`.** The compiler parses authored answers to validate them and to
refuse two that would recognize the same input; the scorer parses what the candidate types. Those
must agree exactly, or a collision the compiler refuses becomes a silent first-match at score
time. The rule used to be written twice with a test asserting they agreed; one implementation
cannot disagree with itself.

The **subpath** is what makes this safe for the browser: importing `@graffiticode/l0180` would
drag the compiler and `@graffiticode/l0000` in, while `./matching` brings only the parser and
decimal.js. It is `score.ts`'s one and only import, and vitest in both packages aliases it to
source so tests never require a build first.

### `inline-choice` is text-entry's sentence with choice's answers

A dropdown and a typed blank are the same construct — a named hole a `{{id}}` marker positions —
so the marker model is shared rather than copied. `cutMarkers` in `textentry.ts` owns the cutting
and the three cross-checks (a marker no hole declares, a hole with no marker, a marker used
twice), and takes the nouns to use in its errors, so somebody writing dropdowns is never told
about blanks. Everything below the hole differs and lives in `inlinechoice.ts`.

**What fills the hole is a choice option, unchanged.** Same `id`, `text` and `assess`, same
meanings, same derived A, B, C — `optionLabel` moved to `labels.ts` for that, because the two
derivations were written separately and agreed only for the first twenty-six options. An author
who can explain a wrong multiple-choice option explains a wrong dropdown option identically.

**Option ids are scoped to their dropdown**, so `A` in one hole and `A` in the next are different
options. That is why the key nests — `mapping[hole].options[id]` — and why a rationale sits on the
option rather than in the flat `feedback` map `choice` uses. Same shape of answer as text-entry's
rationale-on-the-response, and the same reason: a flat map cannot key an identifier that repeats.

The scorer's dispatch is structural, as `isTyped` already was: a mapping entry carrying
`responses` is typed, one carrying `options` is picked, and a `choice` key maps ids straight to
values and carries neither. Nothing in `validation` names the interaction type, and nothing
should — a key says how to score, not what drew it.

**A sentence is one or the other.** A typed blank and a dropdown cannot mix in one interaction:
QTI keeps the two interactions apart, and a member word taking both `responses` and `options`
would let one blank be written half each way. A question needing both is two parts of an item.

### `order`: the authored order is never the answer

This is the one decision `order` turns on. The elements are written in an order that is NOT the
answer, and each says where it belongs with `assess [ position N ]` — key material inside
`assess`, exactly where `correct` sits on an option. (Since presentation became randomized, the
authored order is only what a candidate sees when `shuffle false` is set; the argument below is
unchanged by that, because the array still ships as authored.)

The obvious alternative, authoring them in the right order, ships the answer inside
`interaction`: the half a graded delivery sends to the browser would BE the key, in array order.
Shuffling at compile time is not a way out either. A deterministic scramble is invertible by
anyone who knows the rule, and a random one would reshuffle under the candidate on every
recompile, because `PROG` recompiles on each response.

**Two elements reading the same text are one answer**, and the key says so with an
`interchangeable` group of ids. Without it, *the cat sat on the mat* — which has two elements
reading "the" — marks a candidate wrong for building the identical sentence with the other one
first: a right answer, no mark, no explanation, which is the failure this language spends most
of its rules avoiding. Derived by the compiler, because it is the half that can see the text;
`canonicalize` in `score.ts` only applies it, and `OrderItem` uses the same canonical form for
its already-solved check, since a sentence that is correct either way is correct either way.
Absent unless a text repeats, and case-sensitive: "The" and "the" are not the same word in
position 1.

`cardinality "ordered"` is the third value of a field that only ever said `single` or
`multiple`, and it is the one thing the scorer dispatches on — deliberately, because it is a
property of the response variable rather than of the interaction that collected it, and QTI
branches in the same place. `scoreChoice` under `match_correct` compares sets; two candidates
with the same elements in different orders have not given the same answer.

Positions are whole, unique and run `1..n`, so they are a permutation and a gap is impossible —
which is why nothing checks for one. Scoring is all or nothing at one point, the figure
`match_correct` already fixes everywhere.

**`position` is refused in any other `assess`.** `validAttributes` cannot catch that: `assess`
is checked under that one name wherever it appears, so it cannot tell an order element from a
choice option. `assertAssessWords` is the check, called from all five readers, and it exists
because `assess [position 2]` on a choice option would otherwise merge, be read by nobody, and
compile clean — the silent no-op the attribute table exists to prevent.

The renderer offers two ways to move a row, and both are load-bearing. Dragging is what a mouse
expects. **The up/down buttons stay**, because dragging reaches nobody else: the HTML5 drag
events do not fire on touch, and there is no keyboard path through them at all. A candidate on
a phone, a keyboard or a screen reader has to be able to answer the question, so the buttons
are the accessible path and dragging is layered on top — not a fallback to be removed once
dragging works. Native drag events rather than a library, so the view's dependency list does
not grow for one interaction.

`reorder.ts` holds the move itself, pure and tested, because it is the half that can be wrong
without looking wrong: dropping an item BELOW its old position shifts every index between them,
and an off-by-one there mis-scores an ordering item without throwing or rendering oddly. It is
a move, not a swap — the buttons are adjacent moves, where the two coincide, but a drag across
three places is not a swap with whatever happens to be there.

**The dragged index lives in a ref as well as in state**, and the duplication is deliberate.
State is what the rendering reads; the ref is what the drop reads, because a `dragstart` state
update has not necessarily committed when `drop` fires. With real frames between them it always
has — but a drop batched with its own dragstart read `null` and silently did nothing, which is
exactly how it was found.

### Every list is randomized, and two kinds are not

A fixed option order is a scoring artifact: position bias is real, and a key that sits in the
same slot across an activity is learnable. So `shuffle` **defaults to true** — for a `choice`'s
options, each menu of an `inline-choice`, and an `order`'s elements. This diverges from QTI,
whose default is false, deliberately.

`hottext` is never shuffled (it is a passage; sentences in a random order are not prose) and
neither are an item's `parts` (Part A before Part B is the question's structure). Both still
reject `shuffle` as an unknown attribute, and the three tests asserting that are the guard that
it did not leak further.

**`anchors.ts` holds the two cases where randomizing is wrong**, and both only decide what
happens when the author wrote nothing — an explicit `shuffle` always wins, in either direction:

- **An anchored option is pinned last.** "All of the above" in position 2 is a broken item. The
  compiler marks those `anchored: true` and the renderer partitions on the flag. The phrases are
  a closed English set rather than a pattern, because the failure to avoid is catching a
  plausible answer by accident — "None of these apply" is a real answer and must shuffle.
- **A list already in an order keeps it**: numbers in sequence, or the pair True/False. Both are
  item-writing conventions, and `2, 4, 5, 9, 11` scrambled to `9, 2, 11, 4, 5` reads as a trick.
  The rule is evaluated over the UNANCHORED options, so a numeric list ending in "None of the
  above" is still a numeric list. Note where this lands: the language's own flagship example,
  "What is 2 + 2? → 3, 4, 5", keeps its order for exactly this reason.

**The shuffle happens at render, once per mount** — `packages/view/src/components/form/shuffling.ts`,
the one shuffle in the package. Not at compile time, for the reason `order` already documents:
`PROG` recompiles on every response, so a compile-time order would reshuffle under the candidate
as they answer. And it is memoized on the joined ids, because the model hands down a fresh array
every render and keying on the array itself would reshuffle continuously — moving the list under
the cursor mid-answer, which is worse than not shuffling at all.

`shuffled()` takes its RNG so it can be tested with a seeded one; `useShuffled` is the thin React
wrapper. `OrderItem` passes `correctResponse` as `avoid`, so a shuffle that lands on the answer
is redrawn — possible only in a practice delivery, since a graded one withholds the key.

### `gap-match` is assembled, not invented

The second interaction built by composing two halves that already existed, as `inline-choice`
was. The sentence and its `{{id}}` markers are `text-entry`'s, through `cutMarkers`; the key is
`match`'s, a mapping over pairs with `baseType "directedPair"`. That is not a shortcut — QTI
models `gapMatchInteraction` with a `directedPair` response too — and the proof it was the right
seam is that **`score.ts` needed no change at all**: `scorePairs` already sums per pairing and
already requires the exact set.

`pairing.ts` gave up `readPlaces` for it, the half that validates a bank of things with authored
ids. Only that half: a gap has no `text`, being a hole in a sentence rather than a thing on the
page, so its own loop stays in `gapmatch.ts`.

**The bank is the whole difference from `inline-choice`, and the renderer has to show it.** A
dropdown cloze gives every hole its own private menu and nothing is ever used up; here one bank
is shared and a token placed in one gap is spent, so the last gap is partly answered by
elimination. `GapMatchItem` renders the bank, strikes a token through once it is placed, and
disables it in every other gap's menu. Two gaps naming the same token is a compile error whose
message names `inline-choice` as the way to have an answer repeat.

Moving a token from one gap to another MOVES it — the old pairing is dropped — because a token
exists once. Cloning it would put the same word in two gaps and score both.

### `match` and `classification` are one key with one rule between them

Both ask the same question — which of these does each of those belong with — so both compile to
a mapping over PAIRS of identifiers, `"<item> <place>"`, which is QTI's `directedPair` and its
spelling. `pairing.ts` builds it for both, parameterized by vocabulary the way `cutMarkers` is,
so nobody sorting animals is told about targets.

**The one difference is checkable, which is what makes two words honest rather than
decorative.** A match pairs each target with one item; a classification is the one where
sharing is the point. Two items naming the same target is a compile error under `match`, and
the message names `classification` as the fix.

**A place carries an authored `id`; an item's derives.** Nothing the author writes refers to an
item, while every item names a place — so an id nobody wrote is an id nobody can name, and it
is refused rather than derived.

**`scorePairs` exists because `correct` could not be reused.** The arithmetic is a choice's, but
a mapping over pairs enumerates only the right few out of every item × every place, so a
candidate who makes all the correct pairings AND some wrong ones sums to the ceiling. Being
correct is the exact set, no fewer and no extra. `choice` never had to care: its mapping lists
every option and `maxChoices` bounds the UI. Outcomes cover the pairs the candidate MADE as well
as the ones the key names, so a wrong pairing has an entry for the renderer to mark rather than
nothing at all.

Dispatch is on `baseType === "directedPair"` — declared, like `order`'s `cardinality`, and on
the response declaration where QTI puts it.

**The member lists are `match-items` and `classification-items`, not a shared `items`.**
Redundant inside a container that already says which it is, and deliberately so: `item` is the
multi-part wrapper, a `match` is routinely a part inside one, and `items` nested two lines under
`item` reads as though the two are related. It would also have shadowed the wrapper's own row in
`validAttributes`, which is a duplicate object key that JavaScript resolves silently — found
exactly that way.

`PairingItem` renders both, a `<select>` per row. Two columns with lines, and buckets to drag
into, are the pictures these eventually want; the select is what works for a keyboard and a
screen reader, and is the base anything else layers over.

### A hottext resolves in two phases, and that is not optional

Children transform before parents: `PARTS` visits each interaction, then `ITEM` merges. So when
`HOTTEXT` runs **the stimulus does not exist yet** — it is a sibling of `parts` inside `item`.
An interaction saying `within "stimulus"` therefore cannot resolve its own quotes, and emits a
`pending` sibling of `interaction`/`validation` that `ITEM` completes once it has the passage.
`PROG` rejects a `pending` that survives, which is how `within "stimulus"` outside an item gets
an error rather than a half-built value.

Both paths call `hottext.ts`, which is why it is a plain module with no AST and no CPS.

### The passage renders once, unlike L0175

L0175 renders the passage twice — read-only in a "Passage" tab, clickable in the item — and
gets away with it because those are tabs. L0180 lays stimulus and parts out inline, so the same
approach would put the passage on screen twice.

Hence `HottextPassage` and `HottextPrompt` as separate exports rather than one component with a
mode flag. `ItemView` puts the passage in the **stimulus slot** — top of the item, above Part A,
replacing the static block — and the prompt in the part slot. `HottextItem` stacks both for a
hottext standing alone, and is what `RENDERERS` holds.

Selection at the ceiling **refuses** a further click, where `ChoiceItem` evicts the oldest. In a
list of options an eviction is visible; in a passage the displaced sentence may be off screen,
so the candidate would watch a selection vanish for no stated reason.

## Not built yet

Sections — QTI's `assessmentSection`, the level between an activity and its items, where a rule
over a GROUP of items belongs: drawing 10 items from a bank of 200, an ordering, a shared
rubric. An activity is a flat list of authored items until then. Hotspot, sliders. Symbolic answer
matching — expressions, units and algebraic equivalence, and whether a fraction is in lowest
terms; numbers themselves are compared as numbers. QTI export, which the `interaction`/`validation` split is deliberately shaped
to allow later; now that the compiled shape carries QTI's own field names, that is a serializer
rather than a translation.

## Related repos

- `l0000` — the base language and the View harness. Both are npm dependencies, not workspaces.
- `console/docs/language-authoring-style.md` — the style spec this dialect follows.
- `console/src/lib/languages.ts` — the catalog. **L0180 must be registered here to reach any
  user**; L0160's absence from that file is why it is invisible today.
- `l0179`, `l0176`, `l0175` — the sources of the validation model, the attribute machinery, and
  the native renderer respectively.
