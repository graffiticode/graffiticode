<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0180 Dialect Extensions

L0180 authors **web-based assessment items**. A program compiles to one interaction plus its
answer key, ready to render and score with no vendor platform behind it. **A quiz or a test —
any request for several questions — is one program too:** wrap the questions in
`items [ … ] {}`. Several questions side by side, bracketed or not, are a compile error.

## Writing an attribute

Three rules cover the whole surface. There is no per-word syntax to memorize.

| Target shape | How it is written |
| :----------- | :---------------- |
| an object | an attribute list — `assess [correct points 2]` |
| a list of objects | a list of attribute lists — `options [[text "A"] [text "B"]] {}` |
| a scalar | the value itself — `prompt "What is 2 + 2?"`, `shuffle false` |

Every word is the kebab-case spelling of the field it emits, and means the same thing at any
depth. Lists are space-separated (`[1 2 3]`, not `[1, 2, 3]`). Every program ends with `..`.

**One word takes no value at all: `correct`.** It stands alone inside `assess`, and its
presence is what it asserts. Write `assess [correct points 2]`, never `correct true`.

**Four words take a configuration record after their argument**, written `{}` when there is
nothing to configure. `options [...] {}` and `parts [...] {}` are member lists — homogeneous
children plus the container's own settings. `navigation` and `submission` chain onto an
activity's `items [...]` list and end in that same record:
`items [ … ] navigation "linear" {}`. Every other word here takes exactly one argument.

## L0180 Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `items` | `<list record: record>` | An activity: the items a candidate works through, in order, then the activity's configuration |
| `navigation` | `<string record: record>` | QTI's navigationMode. `linear` means the candidate cannot return to an item they have left; `nonlinear` (the default) lets them move freely |
| `submission` | `<string record: record>` | QTI's submissionMode. `individual` submits each item as it is answered; `simultaneous` (the default) holds everything until the end |
| `item` | `<list: record>` | An item: an optional stimulus and one or more parts scored together |
| `parts` | `<list record: record>` | The interactions an item is made of, in order |
| `stimulus` | `<list: record>` | The passage the item's parts are about |
| `title` | `<string: record>` | The stimulus's title |
| `paragraphs` | `<list: record>` | The stimulus text, one string per paragraph |
| `scoring` | `<string: record>` | How parts combine: `additive` (default) or `conjunctive` |
| `choice` | `<list: record>` | A choice interaction: a stem and options to select from |
| `hottext` | `<list: record>` | A hottext interaction: a passage with clickable sentences or words |
| `text-entry` | `<list: record>` | A sentence with blanks the candidate types into |
| `blanks` | `<list record: record>` | The blanks in a text-entry's sentence, each named by its marker |
| `responses` | `<list record: record>` | The answers a blank recognizes, each with what it is worth |
| `response` | `<string: record>` | One answer a blank recognizes |
| `case-sensitive` | `<boolean: record>` | Whether capitals must match. Defaults to false |
| `base-type` | `<string: record>` | What a blank's answers are: `string` (default), `float` or `integer` |
| `tolerance` | `<number: record>` | How far a numeric answer may be and still count |
| `input-formats` | `<list: record>` | Which written forms a numeric blank accepts: `numeric` (any, the default), or a list of `decimal`, `fraction` and `scientific` |
| `inline-choice` | `<list: record>` | A sentence with dropdowns the candidate picks from |
| `dropdowns` | `<list record: record>` | The dropdowns in an inline-choice's sentence, each named by its marker |
| `order` | `<list: record>` | Elements the candidate puts into the right sequence |
| `match` | `<list: record>` | Each item paired with one of the targets |
| `targets` | `<list record: record>` | The things a match's items are paired with, each named by an id |
| `match-items` | `<list record: record>` | The things a match pairs off, each naming its target |
| `classification` | `<list: record>` | Each item sorted into one of the categories |
| `categories` | `<list record: record>` | The categories a classification sorts into, each named by an id |
| `classification-items` | `<list record: record>` | The things a classification sorts, each naming its category |
| `gap-match` | `<list: record>` | A sentence whose gaps are filled from a shared bank |
| `tokens` | `<list record: record>` | The bank a gap-match's gaps are filled from, each named by an id |
| `gaps` | `<list record: record>` | The gaps in a gap-match's sentence, each named by its marker |
| `target` | `<string: record>` | The id of the target an item is matched with |
| `category` | `<string: record>` | The id of the category an item belongs in |
| `token` | `<string: record>` | The id of the token that fills a gap |
| `elements` | `<list record: record>` | The things an order sequences, in the order they are presented |
| `position` | `<number: record>` | Where an element belongs in the right sequence, counting from 1 |
| `extended-text` | `<list: record>` | A written response, marked by a person against a rubric |
| `rubric` | `<list record: record>` | The bands a written response is marked against |
| `descriptor` | `<string: record>` | What a response must do to earn that band |
| `exemplar` | `<string: record>` | A response that would earn full marks |
| `selections` | `<list record: record>` | The places a hottext can select, each named by a quote |
| `quote` | `<string: record>` | The text a selection names, copied from the passage |
| `granularity` | `<string: record>` | What is clickable: `sentence` (default) or `word` |
| `within` | `<string: record>` | Select within the item's `stimulus` instead of the hottext's own text |
| `options` | `<list record: record>` | The options offered, each an attribute list |
| `prompt` | `<string: record>` | The question stem shown to the candidate |
| `text` | `<string: record>` | An option's visible text |
| `id` | `<string: record>` | An option's identifier. Derived as A, B, C… when omitted |
| `assess` | `<list: record>` | Scoring for an option. Its presence turns scoring on |
| `correct` | `<: record>` | Marks an option as a right answer. Takes no value |
| `points` | `<number: record>` | What an option is worth. Defaults to 1 with `correct` |
| `rationale` | `<string: record>` | Why an option is wrong. Shown once the candidate picks it |
| `shuffle` | `<boolean: record>` | Present the list in random order. Defaults to true |
| `min-choices` | `<number: record>` | Fewest options selectable. Defaults to 0 |
| `max-choices` | `<number: record>` | Most options selectable. Defaults to 1 (single-select) |
| `response-processing` | `<string: record>` | How the response scores: `map-response` (default) or `match-correct` |
| `upper-bound` | `<number: record>` | Cap on what the answers can earn. Below their total it means "any N of them" |

## Which words each container takes

| Container | Takes |
| :-------- | :---- |
| an activity | navigation, submission, items |
| `item` | stimulus, scoring, points, parts |
| `stimulus` | title, paragraphs |
| `choice` | prompt, shuffle, min-choices, max-choices, response-processing, upper-bound, options |
| `hottext` | prompt, text, within, granularity, min-choices, max-choices, response-processing, upper-bound, selections |
| `selection` | quote, assess |
| `text-entry` | prompt, text, case-sensitive, blanks |
| `blank` | id, responses, case-sensitive, base-type, tolerance, input-formats |
| `inline-choice` | prompt, shuffle, text, dropdowns |
| `dropdown` | id, options |
| `order` | prompt, shuffle, elements |
| `element` | id, text, assess |
| `match` | prompt, shuffle, response-processing, targets, match-items |
| `classification` | prompt, shuffle, response-processing, categories, classification-items |
| `target` | id, text |
| `category` | id, text |
| `match-item` | id, text, assess |
| `classification-item` | id, text, assess |
| `gap-match` | prompt, shuffle, response-processing, text, tokens, gaps |
| `token` | id, text |
| `gap` | id, assess |
| `response` | response, assess |
| `extended-text` | prompt, rubric, exemplar |
| `band` | points, descriptor |
| an option | id, text, assess |
| `assess` | correct, points, rationale, position, target, category, token |

A word written in the wrong container is a compile error naming where it belongs, not a
silent no-op.

## Scoring

`assess` must say what it asserts — `correct`, `points`, or `rationale`:

- `assess [correct]` — a right answer, worth 1 point.
- `assess [correct points 2]` — a right answer, worth 2.
- `assess [points -1]` — a **penalty**: selecting this distractor costs a point.
- `assess [rationale "…"]` — why this distractor is wrong. It changes no score.

The maximum sums only the options marked `correct`, so a penalty can never move the ceiling.
An item's score is floored at zero — penalties cannot drive it negative and subtract from
other items in an activity. An item with no `assess` anywhere is unscored, which is valid.

A rationale compiles into `validation`, never `interaction`, so a graded delivery withholds
it. The renderer shows it against an option only after the candidate selects that option — it
never reveals an answer they did not touch.

## Exactly these, and nothing else

`response-processing` names which rule turns a response into a score:

- **`map-response`** (the default) scores each selected option and sums them — per-option
  points, weighted answers, partial credit and penalties.
- **`match-correct`** awards the point for every `correct` option and nothing else. A subset
  scores zero and so does a superset.

Reach for `match-correct` when the question means "exactly these" — "choose the two sentences
that belong in a summary". Set `min-choices` and `max-choices` to the number wanted so the
candidate is told how many to pick. Per-option `points` is refused under `match-correct`: the
item is already worth one point for the whole set, so a per-option figure would be a second,
disagreeing answer.

```
choice [
  prompt "Choose the two sentences that belong in a summary of the passage."
  response-processing "match-correct"
  min-choices 2
  max-choices 2
  options [
    [ text "Bees live together in colonies." assess [ correct ] ]
    [ text "Every bee does a job that helps the group survive." assess [ correct ] ]
    [ text "Some bees are yellow and black." ]
    [ text "A hive can be kept in a wooden box." ]
  ] {}
]..
```

## Clicking inside the text

`hottext` makes a passage itself the answer: the candidate clicks a sentence, or a word. Each
`selection` names its target with a `quote` copied from the passage — the compiler finds it, so
you never write an id. A quote that is not in the text is a compile error naming the closest
sentence, and so is one that matches two places.

Say where the text comes from, exactly once:

- **`within "stimulus"`** — the passage of the item this hottext is a part of. The passage
  renders once, at the top of the item, with its sentences clickable.
- **`text "…"`** — its own passage, for a hottext standing alone.

`granularity` picks the unit. `sentence` (the default) makes every sentence clickable.
`word` makes clickable only the words a selection names, so the distractor words are authored
rather than guessed.

### Click the sentence that supports the answer

```
item [
  stimulus [
    title "The Tide Pool"
    paragraphs [
      "Mara crouched at the edge of the tide pool, ignoring the picnic behind her."
      "Her brother called twice. She did not turn around."
    ]
  ]
  scoring "conjunctive"
  parts [
    choice [
      prompt "Click on the statement that best describes Mara."
      options [
        [ text "She is absorbed by the tide pool." assess [ correct ] ]
        [ text "She is angry at her brother." ]
      ] {}
    ]
    hottext [
      prompt "Click the sentence that best supports your answer to Part A."
      within "stimulus"
      selections [
        [ quote "She did not turn around." assess [ correct ] ]
      ] {}
    ]
  ] {}
]..
```

### Any three of these, not all of them

`upper-bound` caps what the correct selections can earn, which is how you ask for *some* of
them. Four sentences below are right and the candidate clicks three; picking any three earns
the item.

```
item [
  stimulus [
    paragraphs [
      "Bees live in colonies. Every bee does a job. Workers gather nectar."
      "Guard bees defend the entrance. The queen lays every egg."
    ]
  ]
  scoring "conjunctive"
  points 1
  parts [
    hottext [
      prompt "Click the three sentences that show how the colony works together."
      within "stimulus"
      upper-bound 3
      selections [
        [ quote "Every bee does a job." assess [ correct ] ]
        [ quote "Workers gather nectar." assess [ correct ] ]
        [ quote "Guard bees defend the entrance." assess [ correct ] ]
        [ quote "The queen lays every egg." assess [ correct ] ]
      ] {}
    ]
  ] {}
]..
```

Without `upper-bound` every correct selection must be clicked. With it, the candidate is asked
for exactly that many, and the item is worth that many points — wrap it in a conjunctive item
to make the whole thing worth one.

### Click the word

```
hottext [
  prompt "Read the sentence. Click the word that means a channel that carries water."
  text "The aqueduct carried water across long distances."
  granularity "word"
  selections [
    [ quote "aqueduct" assess [ correct ] ]
    [ quote "water" assess [ rationale "Water is what it carries, not what the word means." ] ]
    [ quote "distances" ]
  ] {}
]..
```

Only the three named words are clickable. A wrong candidate needs no `assess` at all; give it
one with a `rationale` to explain the mistake back.

## Filling in a blank

`text-entry` puts blanks in a sentence. A marker `{{id}}` says where each one goes, and the
matching entry in `blanks` says what that blank recognizes:

```
text-entry [
  prompt "Complete the sentence."
  text "The capital of France is {{capital}}."
  blanks [
    [ id "capital"
      responses [
        [ response "Paris" assess [ correct ] ]
      ] {} ]
  ] {}
]..
```

**The marker names the blank, and the answer binds to that name.** Move the clause, rename
nothing, and the answer still belongs to its blank. The id is yours to choose — `{{capital}}`
reads better than `{{1}}`, and both work.

**Each answer carries its own `assess`, exactly as an option does.** That is what lets a blank
give partial credit for a near-miss, penalize a known wrong answer, and explain one back:

```
text-entry [
  text "The capital of France is {{capital}}."
  blanks [
    [ id "capital"
      responses [
        [ response "Paris" assess [ correct ] ]
        [ response "Paree" assess [ correct points 1 ] ]
        [ response "Lyon" assess [ rationale "The largest city after Paris, not the capital." ] ]
      ] {} ]
  ] {}
]..
```

A blank is worth its **best** correct answer, not their sum — only one thing can be typed into
it. The interaction is worth the sum of its blanks, which makes several blanks partial credit;
wrap it in a conjunctive item to make the whole sentence worth one point.

Capitals are ignored by default. `case-sensitive true` on the interaction changes that for all
of its blanks, and a single blank can override it:

```
text-entry [
  text "The agency {{agency}} launched the probe from {{place}}."
  blanks [
    [ id "agency" case-sensitive true
      responses [ [ response "NASA" assess [ correct ] ] ] {} ]
    [ id "place"
      responses [
        [ response "Cape Canaveral" assess [ correct ] ]
        [ response "Cape Canaveral, Florida" assess [ correct ] ]
      ] {} ]
  ] {}
]..
```

Surrounding and repeated spaces never cost a mark. Punctuation does count — `cant` is not
`can't`.

### Numbers

A blank whose answer is a number should say so. `base-type "float"` compares the answer **as a
number**, so every way of writing it counts:

```
text-entry [
  prompt "Complete the sentence."
  text "Half of one is {{half}}."
  blanks [
    [ id "half" base-type "float"
      responses [ [ response "0.5" assess [ correct ] ] ] {} ]
  ] {}
]..
```

`0.5`, `0.50`, `.5`, `+0.5` and `1/2` all earn the point. Without `base-type` they are five
different strings and four of them are marked wrong — which is why a numeric answer should never
be left as text.

Whole numbers, decimals, a leading sign, simple fractions and scientific notation are
understood, and `1,000` may be written with its comma. Expressions (`1/2 + 1/3`), units (`5 cm`)
and symbols (`x/2`) are not; ask for the form you want.

`base-type "integer"` is the same but refuses an authored answer that is not whole — useful when
"how many" is the question.

`tolerance` accepts an answer near the expected one, which is what a rounded or measured answer
needs:

```
text-entry [
  text "Pi to two decimal places is {{pi}}."
  blanks [
    [ id "pi" base-type "float" tolerance 0.005
      responses [ [ response "3.14" assess [ correct ] ] ] {} ]
  ] {}
]..
```

Arithmetic is decimal, not binary, so a tolerance means exactly what it says at its edge.

### Asking for a particular form

Sometimes the form *is* the question — "express your answer as a fraction" is asking for
something a decimal does not demonstrate. `input-formats` says which written forms count:

```
text-entry [
  prompt "Express your answer as a fraction in lowest terms."
  text "Half of one is {{half}}."
  blanks [
    [ id "half" base-type "float" input-formats [ "fraction" ]
      responses [ [ response "0.5" assess [ correct ] ] ] {} ]
  ] {}
]..
```

`1/2` earns the point; `0.5` does not, and the candidate is told a fraction was wanted rather
than simply marked wrong. The forms are `decimal` (which covers whole numbers and `1,000`),
`fraction` and `scientific`, and more than one may be listed.

The default is `numeric`, which means **any** of them — so leaving `input-formats` off accepts
every form, and that is right whenever the value is what is being asked for. Writing `numeric`
beside a particular form is a compile error, since it says two different things.

`input-formats` constrains what a candidate may type, not what you may author: the answer above
is written `0.5` and still asks for a fraction.

### A repeating answer

`1/3` is not any decimal — it repeats — so no decimal a student would type can equal it. `0.333`
and `0.3333` are both wrong, and left alone the blank would say nothing about why. So an answer
that repeats is a compile error unless you say which way out you want:

```
text-entry [
  prompt "Give your answer as a fraction."
  text "One divided by three is {{third}}."
  blanks [
    [ id "third" base-type "float" input-formats [ "fraction" ]
      responses [ [ response "1/3" assess [ correct ] ] ] {} ]
  ] {}
]..
```

Either ask for a fraction, as above — a student typing `0.33` is then told a fraction is wanted
rather than simply marked wrong — or add a `tolerance` saying how close a decimal has to be.
Accepting decimals *and* fractions is not a way out, since the decimal half stays unreachable.

Only a fraction can repeat. `1/2`, `3/4` and `7/20` are exact decimals and need nothing.

`case-sensitive` and `input-formats` have no meaning on the blank the other belongs to —
numbers have no case, and text has no form — and `tolerance` none on a text one; any such
combination is a compile error rather than a setting that quietly does nothing.

Every mismatch is a compile error: a marker no blank declares, a blank with no marker, a marker
used twice, text with no marker at all, a blank with nothing marked `correct`, or two responses
that would recognize the same typed answer.

## Picking inside the sentence

`inline-choice` is the same sentence with dropdowns instead of blanks. The marker model is
text-entry's — `{{id}}` positions a hole and names it — and what fills the hole is `choice`'s:

```
inline-choice [
  prompt "Complete the sentence."
  text "Plants absorb {{gas}} during photosynthesis."
  dropdowns [
    [ id "gas"
      options [
        [ text "carbon dioxide" assess [ correct ] ]
        [ text "oxygen" assess [ rationale "Oxygen is what plants release, not what they take in." ] ]
        [ text "nitrogen" ]
      ] {} ]
  ] {}
]..
```

**A dropdown's options are a choice's options.** They take the same `id`, `text` and `assess`,
they derive the same A, B, C ids, and they mean the same things: `assess [correct]` marks the
answer, `assess [points -1]` penalizes a distractor, `assess [rationale "…"]` explains one once
the candidate has picked it. An option with no `assess` is simply a distractor worth nothing.

Ids are scoped to their dropdown, so `A` in one hole and `A` in the next are different options.
That is why nothing is keyed flat here the way `choice` keys its feedback.

A dropdown is worth its **best** correct option — only one thing can be chosen in it — and the
interaction is worth the sum of its dropdowns:

```
inline-choice [
  text "Plants absorb {{in}} and release {{out}}."
  dropdowns [
    [ id "in" options [ [ text "carbon dioxide" assess [ correct ] ] [ text "oxygen" ] ] {} ]
    [ id "out" options [ [ text "oxygen" assess [ correct ] ] [ text "nitrogen" ] ] {} ]
  ] {}
]..
```

Two holes, two points, and half of it is half the marks. Wrap it in a conjunctive item to make
the whole sentence worth one.

**Use `inline-choice` when the answer should be recognizable and `text-entry` when it should be
recalled.** A dropdown gives the answer away to anyone who reads the menu; a blank does not.

A sentence is one or the other. A typed blank and a dropdown cannot be mixed in one
interaction — put them in two parts of an item if a question needs both.

The same cross-checks apply, in the dropdown's own words: a marker no dropdown declares, a
dropdown with no marker, a marker used twice, text with no marker at all, and a dropdown with
nothing marked `correct` are each a compile error naming the fix.

## Putting things in order

`order` asks the candidate to sequence things. Each element says where it belongs, with
`position` inside its `assess`:

```
order [
  prompt "Put the stages of the water cycle in order."
  elements [
    [ text "Condensation" assess [ position 2 ] ]
    [ text "Evaporation" assess [ position 1 ] ]
    [ text "Collection" assess [ position 4 ] ]
    [ text "Precipitation" assess [ position 3 ] ]
  ] {}
]..
```

**Write the elements in the order the candidate should SEE them, not the right order.** The
list is the presentation; `position` is the answer. This is not a style preference: the two
halves of a compiled item are separate so a graded delivery can withhold the key, and elements
emitted in their correct order would be the key, sitting in the half that ships to the browser.

Scoring is all or nothing — a sequence with one pair swapped is not most of the way right — and
the interaction is worth one point. Wrap it in a conjunctive item to combine it with another
part; put it in an additive item to have it scored beside one.

Positions count from 1 and each element holds one. A repeat, a gap, a fraction, a position past
the end, or an element with no position at all is a compile error naming the fix.

**Two elements that read the same thing are one answer.** A sentence-building item —
*the / cat / sat / on / the / mat* — has two elements reading "the", and a candidate who builds
the identical sentence with the other one first is right. The compiler works that out and the
key carries an `interchangeable` group, so both arrangements score. Nothing needs writing for
it, and the field appears only when a text actually repeats. Case matters: "The" and "the" are
not interchangeable, because swapping them would capitalize the wrong word.

`position` is the only thing an order element's `assess` takes: it is the answer, so `correct`
would say nothing further and `points` would disagree with the item's own. It is equally an
error anywhere else — on a choice option, a hottext selection or a typed response — rather than
a word that merges and is read by nobody.

## The order things are presented in

**Every list a candidate picks from is presented in a random order.** A `choice`'s options, each
dropdown's menu in an `inline-choice`, and an `order`'s elements: all three shuffle, and none of
them needs asking for. A fixed order is a scoring artifact — candidates favour the first
plausible option, and a key that sits in the same slot across an activity is learnable.

`shuffle false` keeps the authored order:

```
choice [
  prompt "Which step comes first when washing hands?"
  shuffle false
  options [
    [ text "Wet your hands" assess [ correct ] ]
    [ text "Apply soap" ]
    [ text "Rinse" ]
  ] {}
]..
```

Two kinds of list keep their order without being asked, because in them the order is
information rather than an accident:

- **Numbers in sequence.** `2, 4, 5, 9, 11` reads as a set to scan; scrambled it reads as a
  trick. Ascending or descending both count; a list that is not sorted is evidence nobody
  chose an order, and it shuffles.
- **True/false and yes/no.** A two-option item written in that order is conventional, and
  reversed it looks like a mistake rather than a randomization.

An **anchored** option — "All of the above", "None of the above" and their kin — is pinned last
however the rest is shuffled, and the compiled option carries `anchored: true` to say so. Nothing
needs writing for that either. The phrases are a closed English list, so a near-miss like "None
of these apply", which is an ordinary answer, shuffles like any other option.

Writing `shuffle` yourself always wins, in either direction: `shuffle true` randomizes a numeric
list, `shuffle false` fixes an ordinary one.

Hot text is never shuffled — it is a passage, and sentences in a random order are not prose —
and neither are an item's parts, since Part A before Part B is the question's structure.

## Pairing things up, and sorting them

`match` pairs each item with one of a list of targets. Every target carries an `id`, because
that is what an item names; the items' own ids derive, since nothing refers to them:

```
match [
  prompt "Match each country to its capital."
  targets [
    [ id "paris" text "Paris" ]
    [ id "tokyo" text "Tokyo" ]
    [ id "lima" text "Lima" ]
  ] {}
  match-items [
    [ text "France" assess [ target "paris" ] ]
    [ text "Japan" assess [ target "tokyo" ] ]
  ] {}
]..
```

A target no item names is a **distractor** — Lima above. Nothing marks it as one.

`classification` is the same thing with categories, and is the one where several items share:

```
classification [
  prompt "Sort each animal into its class."
  categories [
    [ id "mammal" text "Mammal" ]
    [ id "reptile" text "Reptile" ]
  ] {}
  classification-items [
    [ text "Blue whale" assess [ category "mammal" ] ]
    [ text "Iguana" assess [ category "reptile" ] ]
    [ text "Bat" assess [ category "mammal" ] ]
  ] {}
]..
```

**A match is one-to-one and a classification is many-to-one.** Two items naming the same target
is a compile error under `match`, and the message says that a shared target means the question
is a `classification`. That is the only rule that separates the two words.

Each item is worth one point by default, and the interaction is worth their sum, so a four-item
match gives partial credit. `assess [ target "paris" points 2 ]` weights one pairing;
`assess [ target "paris" rationale "…" ]` explains one, shown once the candidate makes it.
`response-processing "match-correct"` makes the whole thing all-or-nothing at one point, as it
does everywhere else.

The lists are member lists named for their own container — `match-items`, not `items`. It is
redundant inside a `match`, and it is unambiguous: `item` is the multi-part wrapper, a `match`
is often a part inside one, and a program with `items` nested two lines under `item` reads as
though the two are related.

## Filling a sentence from a word bank

`gap-match` puts gaps in a sentence and fills them from one bank of tokens shared across all of
them:

```
gap-match [
  prompt "Complete the sentence."
  text "The {{a}} orbits the {{b}}."
  tokens [
    [ id "moon" text "Moon" ]
    [ id "earth" text "Earth" ]
    [ id "sun" text "Sun" ]
  ] {}
  gaps [
    [ id "a" assess [ token "moon" ] ]
    [ id "b" assess [ token "earth" ] ]
  ] {}
]..
```

**Use `gap-match` when the words come from one shared bank, and `inline-choice` when each hole
has its own menu.** That is the whole difference, and it changes the question: a token placed in
one gap is spent and cannot fill another, so the last gap is partly answered by elimination. An
`inline-choice` never uses anything up, and the same word may be the answer to two holes.

Sun above is a **distractor** — a token no gap names. Two gaps naming the same token is a
compile error, because a token is dragged rather than copied; if an answer really does repeat,
the question is an `inline-choice`.

A gap carries no `text`: it is a hole, and the sentence around it is the text. Both ids are
authored — a gap's is the marker that positions it, and a token's is what a gap names.

Each gap is worth a point by default, summed, so a three-gap sentence gives partial credit;
`response-processing "match-correct"` makes the whole sentence one point.

## A written response

`extended-text` collects writing and does **not** score it. Nothing in a browser can judge an
inference, so the compiled key says `responseProcessing "human"` and carries the `rubric` a
person marks against. The candidate is told the answer is saved and how many points are
available — never that they scored zero, which is what an unscored item would mean.

A `rubric` needs at least two bands, each with `points` and a `descriptor`. The item is worth
its top band. `exemplar` is optional: a response that would earn full marks.

```
extended-text [
  prompt "What inference can be made about Mara? Explain using key details from the passage."
  rubric [
    [ points 2 descriptor "Makes a valid inference and cites two supporting details." ]
    [ points 1 descriptor "Makes a valid inference with one detail, or a partial inference." ]
    [ points 0 descriptor "No valid inference, or no support from the text." ]
  ] {}
  exemplar "Mara is absorbed by the tide pool — she ignores the picnic and does not turn around."
]..
```

A written part belongs in an **additive** item, so the rest of it scores while that part waits
to be marked. `conjunctive` is refused with one, because "every part correct" cannot be decided
over a part nothing here can mark.

## Items with a passage, or with more than one part

A bare `choice` is a complete program. Wrap it in an `item` when the question needs a passage
to read, or when one question has several parts answered together.

`scoring` decides how the parts combine. `additive` (the default) sums them, so the item is
worth what its parts are worth. **`conjunctive` awards the item's points only when every part
is fully correct, and nothing otherwise** — a two-part evidence question where naming the
right idea but citing the wrong line earns zero, not half. A conjunctive item is worth 1
point unless `points` says otherwise, and every one of its parts must be scoreable.

Paragraphs are numbered for the reader, so a stem can refer to them ("Which line…").

### A two-part item over a passage

```
item [
  stimulus [
    title "The Loose Board"
    paragraphs [
      "Nina had walked past the crooked porch a hundred times."
      "On Saturday she stopped, because someone had left a hammer on the step."
      "Then she knelt down and set the first nail without anyone asking her to."
    ]
  ]
  scoring "conjunctive"
  parts [
    choice [
      prompt "What can the reader conclude about Nina?"
      options [
        [ text "She takes care of a problem on her own." assess [ correct ] ]
        [ text "She is afraid of her neighbours." ]
        [ text "She wants to be paid for her work." ]
      ] {}
    ]
    choice [
      prompt "Which line best supports your answer to Part A?"
      options [
        [ text "Nina had walked past the crooked porch a hundred times." ]
        [ text "Then she knelt down and set the first nail without anyone asking her to." assess [ correct ] ]
      ] {}
    ]
  ] {}
]..
```

### A single question about a passage

```
item [
  stimulus [
    paragraphs [
      "Honeybees live together in large groups called colonies."
      "Every bee in a colony does a job that helps the group survive."
    ]
  ]
  parts [
    choice [
      prompt "Which sentence best states the central idea?"
      options [
        [ text "Every bee in a colony does a job that helps the group survive." assess [ correct ] ]
        [ text "Honeybees live in large groups." ]
      ] {}
    ]
  ] {}
]..
```

## Several questions in one activity

An `item` groups parts that are scored **together**. An **activity** is the level above: a list
of items, each scored on its own — which is what a quiz or a test actually is. Write the items
in the order they are presented, then the activity's settings, ending in a record:

```
items [
  choice [
    prompt "What is the capital of France?"
    options [ [ text "Paris" assess [ correct ] ] [ text "Lyon" ] [ text "Marseille" ] ] {}
  ]
  choice [
    prompt "Which river runs through it?"
    options [ [ text "The Seine" assess [ correct ] ] [ text "The Rhone" ] ] {}
  ]
] {}..
```

Each member is a whole item — a bare interaction, or an `item [ … ]` with a passage and several
parts. They mix freely, and each keeps its own key.

Two settings govern the delivery, both QTI's:

- **`navigation`** — `nonlinear` (the default) lets the candidate move freely between items;
  `linear` means they cannot return to one they have left.
- **`submission`** — `simultaneous` (the default) holds every answer until the end;
  `individual` submits each item as it is answered.

```
items [
  choice [
    prompt "Which word is a noun?"
    options [ [ text "river" assess [ correct ] ] [ text "quickly" ] ] {}
  ]
  item [
    stimulus [ paragraphs [ "The tide went out further than anyone remembered." ] ]
    parts [
      choice [
        prompt "What does the sentence describe?"
        options [ [ text "An unusually low tide." assess [ correct ] ] [ text "A storm." ] ] {}
      ]
    ] {}
  ]
] navigation "linear" submission "individual" {}..
```

Items are numbered by position, from 0, and a response is keyed by that number. Write `{}` when
there is nothing to configure — the record is not optional, and a settings word with nothing
after it is a parse error rather than a helpful one.

## L0180 Examples

### Multiple choice

```
choice [
  prompt "What is 2 + 2?"
  options [
    [ text "3" ]
    [ text "4" assess [ correct ] ]
    [ text "5" ]
  ] {}
]..
```

### Weighted answer and a penalized distractor

```
choice [
  prompt "Which planet is closest to the Sun?"
  options [
    [ text "Mercury" assess [ correct points 2 ] ]
    [ text "Venus" ]
    [ text "The Moon" assess [ points -1 ] ]
  ] {}
]..
```

### Multi-select

```
choice [
  prompt "Select the prime numbers."
  max-choices 3
  shuffle true
  options [
    [ text "2" assess [ correct ] ]
    [ text "4" ]
    [ text "5" assess [ correct ] ]
    [ text "9" ]
    [ text "11" assess [ correct ] ]
  ] {}
]..
```

### Explicit option ids

Ids are derived as A, B, C… Write one only when something else must reference it.

```
choice [
  prompt "Which is a mammal?"
  options [
    [ id "whale" text "Blue whale" assess [ correct ] ]
    [ id "shark" text "Great white shark" ]
  ] {}
]..
```

### A distractor that explains itself

```
choice [
  prompt "What can the reader conclude about Mara?"
  options [
    [ text "She is absorbed by the tide pool." assess [ correct ] ]
    [ text "She is angry at her brother."
      assess [ rationale "Not turning around shows absorption, not anger." ] ]
    [ text "She is bored by the beach."
      assess [ rationale "She stays at the pool by choice, which is not boredom." ] ]
  ] {}
]..
```

### An unscored poll

```
choice [
  prompt "Which did you find hardest?"
  options [
    [ text "Fractions" ]
    [ text "Decimals" ]
  ] {}
]..
```
