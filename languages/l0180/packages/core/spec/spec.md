<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0180 Vocabulary

This specification documents the dialect-specific functions available in the
**L0180** language of Graffiticode. These functions extend the core language
with assessment-item authoring.

The core language specification including the definition of its syntax,
semantics and base library can be found here:
[Graffiticode Language Specification](./graffiticode-language-spec.html)

## Overview

An L0180 program is one item — an interaction, or an `item` wrapping several parts — or an
activity of several items, written `items [ … ] {}`. Each item compiles to two siblings:

- `interaction` — everything the candidate sees. Safe to send to a browser.
- `validation` — the answer key and the points available.

Keeping them apart is what lets a graded delivery withhold the key and score on the server,
while a practice item ships both and marks itself.

## Writing an attribute

Attributes are written as lists. Each word takes one value and contributes one field; a
`[...]` list of them merges into one object.

| Target shape | How it is written |
| :----------- | :---------------- |
| an object | an attribute list — `assess [correct points 2]` |
| a list of objects | a list of attribute lists — `options [[text "A"] [text "B"]] {}` |
| a scalar | the value itself — `prompt "What is 2 + 2?"` |

Two words depart from that, both deliberately:

- `correct` takes **no** value. It stands alone inside `assess`.
- `options` takes its list **and** a configuration record, written `{}` when empty.

## Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `items` | `<list record: record>` | An activity: several items delivered together |
| `navigation` | `<string record: record>` | How a candidate moves between items — linear or nonlinear |
| `submission` | `<string record: record>` | When answers are sent — individual or simultaneous |
| `item` | `<list: record>` | An item: a stimulus and one or more parts |
| `parts` | `<list record: record>` | The interactions an item is made of |
| `stimulus` | `<list: record>` | The passage the parts are about |
| `title` | `<string: record>` | The stimulus's title |
| `paragraphs` | `<list: record>` | The stimulus text, one string per paragraph |
| `scoring` | `<string: record>` | How parts combine — additive or conjunctive |
| `choice` | `<list: record>` | A choice interaction |
| `hottext` | `<list: record>` | A hottext interaction: clickable sentences or words |
| `text-entry` | `<list: record>` | A sentence with blanks to type into |
| `blanks` | `<list record: record>` | The blanks in a text-entry's sentence |
| `inline-choice` | `<list: record>` | A sentence with dropdowns to pick from |
| `dropdowns` | `<list record: record>` | The dropdowns in an inline-choice's sentence |
| `order` | `<list: record>` | Elements to put in the right sequence |
| `match` | `<list: record>` | Each item paired with one of the targets |
| `targets` | `<list record: record>` | What a match's items are paired with |
| `match-items` | `<list record: record>` | What a match pairs off |
| `classification` | `<list: record>` | Each item sorted into one of the categories |
| `categories` | `<list record: record>` | What a classification sorts into |
| `classification-items` | `<list record: record>` | What a classification sorts |
| `gap-match` | `<list: record>` | A sentence filled from a shared bank |
| `tokens` | `<list record: record>` | The bank a gap-match draws from |
| `gaps` | `<list record: record>` | The gaps in a gap-match's sentence |
| `elements` | `<list record: record>` | The things an order sequences, as presented |
| `responses` | `<list record: record>` | The answers a blank recognizes |
| `response` | `<string: record>` | One answer a blank recognizes |
| `case-sensitive` | `<boolean: record>` | Whether capitals must match |
| `base-type` | `<string: record>` | What a blank's answers are — string, float or integer |
| `tolerance` | `<number: record>` | How far a numeric answer may be and still count |
| `input-formats` | `<list: record>` | Which written forms a numeric blank accepts |
| `extended-text` | `<list: record>` | A written response, marked by a person |
| `rubric` | `<list record: record>` | The bands a written response is marked against |
| `descriptor` | `<string: record>` | What earns that band |
| `exemplar` | `<string: record>` | A response that would earn full marks |
| `selections` | `<list record: record>` | The places a hottext can select |
| `quote` | `<string: record>` | The text a selection names |
| `granularity` | `<string: record>` | What is clickable — sentence or word |
| `within` | `<string: record>` | Select within the item's stimulus |
| `options` | `<list record: record>` | The options offered |
| `prompt` | `<string: record>` | The question stem |
| `text` | `<string: record>` | An option's visible text |
| `id` | `<string: record>` | An option's identifier |
| `assess` | `<list: record>` | Scoring for an option |
| `correct` | `<: record>` | Marks a right answer |
| `points` | `<number: record>` | What an option is worth |
| `rationale` | `<string: record>` | Why an option is wrong, shown once it is picked |
| `shuffle` | `<boolean: record>` | Randomize the presented order. Defaults to true |
| `min-choices` | `<number: record>` | Fewest options selectable |
| `max-choices` | `<number: record>` | Most options selectable |
| `response-processing` | `<string: record>` | How the response scores — map-response or match-correct |
| `upper-bound` | `<number: record>` | Cap on what the answers earn — "any N of them" |

### items

An activity: several items delivered together, each scored on its own. `item` is the level
below — parts scored *together* over one stimulus; `items` is a quiz or a test made of those.
The list comes first, then the activity's settings, ending in a record.

Members mix freely: a bare interaction is an item, and so is an `item [ … ]` with a passage and
several parts. Each keeps its own key. Items are numbered by position from 0, and a response is
keyed by that number.

```
items [
  choice [
    prompt "What is the capital of France?"
    options [ [ text "Paris" assess [ correct ] ] [ text "Lyon" ] ] {}
  ]
  item [
    stimulus [ paragraphs [ "The Seine runs west across the city and out to the sea." ] ]
    parts [
      choice [
        prompt "Which direction does the river run?"
        options [ [ text "West." assess [ correct ] ] [ text "North." ] ] {}
      ]
    ] {}
  ]
] navigation "linear" submission "individual" {}..
```

### navigation

QTI's `navigationMode`, set on an activity. `nonlinear` (the default) lets the candidate move
freely between items; `linear` means they cannot return to one they have left. The default is
what L0180 already does — every item is laid out on one screen — rather than what reads best on
paper.

### submission

QTI's `submissionMode`, set on an activity. `simultaneous` (the default) holds every answer
until the candidate finishes; `individual` submits each item as it is answered, which is what a
delivery that can be resumed needs.

### item

A stimulus and one or more parts, scored together. A bare interaction is already a complete
program, so reach for `item` when the question needs a passage, or when one question has
several parts answered together.

`scoring` decides how the parts combine. `additive` (the default) sums them. `conjunctive`
awards the item's points only when every part is fully correct and nothing otherwise, which
is what a two-part evidence question means by "one point" — naming the right idea while
citing the wrong line earns zero, not half. A conjunctive item is worth 1 unless `points`
says otherwise, and every part must be scoreable.

```
item [
  stimulus [
    title "The Loose Board"
    paragraphs [
      "Nina had walked past the crooked porch a hundred times."
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
      ] {}
    ]
    choice [
      prompt "Which line best supports your answer to Part A?"
      options [
        [ text "Nina had walked past the crooked porch a hundred times." ]
        [ text "Then she knelt down and set the first nail." assess [ correct ] ]
      ] {}
    ]
  ] {}
]..
```

### stimulus

The passage the item's parts are about. Paragraphs are addressed `p1`, `p2`, … and are
numbered for the reader, so a stem can refer to them by line.

### choice

A stem and a list of options. Single-select by default; raise `max-choices` for multi-select.

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

### options

A list of options, each an attribute list, followed by a configuration record. An option's
`id` is derived as A, B, C… unless written.

```
choice [
  options [
    [ id "whale" text "Blue whale" assess [ correct ] ]
    [ id "shark" text "Great white shark" ]
  ] {}
]..
```

### assess

Turns scoring on for the option that carries it. It must say what it asserts — `correct`,
`points`, or both — so an assessed option is never ambiguous.

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

`assess [points -1]` is a penalty: no `correct`, so selecting it subtracts. The maximum sums
only the `correct` options — a penalty cannot move the ceiling, and an item's score is
floored at zero rather than going negative.

### rationale

Why an option is wrong. It rides in `assess` and compiles into `validation`, not
`interaction`, so a graded delivery withholds it; the renderer shows it against an option
only once the candidate has selected that option, so it never reveals an untouched answer.
`assess [rationale "…"]` on its own is valid — explaining a distractor asserts something real
without changing what it scores.

```
choice [
  prompt "What can the reader conclude about Mara?"
  options [
    [ text "She is absorbed by the tide pool." assess [ correct ] ]
    [ text "She is angry at her brother."
      assess [ rationale "Not turning around shows absorption, not anger." ] ]
  ] {}
]..
```

### hottext

A passage whose sentences or words the candidate clicks. It takes its text from the item's
`stimulus` (`within "stimulus"`) or carries its own (`text`) — exactly one of the two.
Selections name their target by `quote`; the compiler resolves it against the segmented
passage, so a quote that is missing or ambiguous is a compile error rather than a silent miss.

```
hottext [
  prompt "Click the sentence that states the central idea."
  text "Bees live in colonies. Every bee does a job that helps the group survive."
  selections [
    [ quote "Every bee does a job that helps the group survive." assess [ correct ] ]
  ] {}
]..
```

### granularity

`sentence` (the default) makes every sentence of the passage clickable. `word` makes clickable
only the words a selection names, so the candidate words are authored rather than inferred.

```
hottext [
  prompt "Click the word that means a channel that carries water."
  text "The aqueduct carried water across long distances."
  granularity "word"
  selections [
    [ quote "aqueduct" assess [ correct ] ]
    [ quote "water" assess [ rationale "Water is what it carries, not what the word means." ] ]
  ] {}
]..
```

### upper-bound

Caps what the correct answers can earn. Below their total it asks for *some* of them — five
valid sentences with `upper-bound 3` means any three are right. Without it, every correct
answer must be selected.

```
hottext [
  prompt "Click the two sentences that belong in a summary."
  text "Bees live in colonies. Every bee does a job. Workers gather nectar. Guard bees defend the hive."
  upper-bound 2
  selections [
    [ quote "Every bee does a job." assess [ correct ] ]
    [ quote "Workers gather nectar." assess [ correct ] ]
    [ quote "Guard bees defend the hive." assess [ correct ] ]
  ] {}
]..
```

### text-entry

A sentence with blanks. `{{id}}` positions a blank and names it; the matching entry in `blanks`
says what that blank recognizes. The answer binds to the name, so moving a clause cannot
rebind it.

Each recognized answer carries its own `assess`, the same as a choice option — so a blank can
give partial credit, penalize, and explain a wrong answer back.

```
text-entry [
  prompt "Complete the sentence."
  text "The capital of France is {{capital}}."
  blanks [
    [ id "capital"
      responses [
        [ response "Paris" assess [ correct ] ]
        [ response "Lyon" assess [ rationale "The largest city after Paris, not the capital." ] ]
      ] {} ]
  ] {}
]..
```

A blank is worth its best correct answer; the interaction is worth the sum of its blanks.
Capitals are ignored unless `case-sensitive true` is set, on the interaction or on one blank.

`base-type "float"` compares a blank's answers as numbers, so `0.5`, `0.50`, `.5`, `1/2` and
`5e-1` are one answer rather than five. `tolerance` widens that to accept a rounded one.

`input-formats` narrows which of those written forms count, for a question where the form is
what is being asked. The forms are `decimal`, `fraction` and `scientific`; the default is
`numeric`, meaning any of them. A right value in a form the blank does not accept scores zero
and is reported as a form problem rather than as a wrong answer.

An answer that repeats — `1/3`, `2/3`, `5/12` — is a compile error unless the blank either asks
for a fraction or carries a `tolerance`. No decimal equals a repeating value, so accepting one
would mark every decimal a student types wrong without saying why.

```
text-entry [
  text "Pi to two decimal places is {{pi}}, and half of one is {{half}}."
  blanks [
    [ id "pi" base-type "float" tolerance 0.005
      responses [ [ response "3.14" assess [ correct ] ] ] {} ]
    [ id "half" base-type "float" input-formats [ "fraction" ]
      responses [ [ response "1/2" assess [ correct ] ] ] {} ]
  ] {}
]..
```

### inline-choice

The same sentence as `text-entry`, with a dropdown at each hole instead of a blank. `{{id}}`
positions a dropdown and names it, and the matching entry in `dropdowns` says what its menu
offers.

A dropdown's `options` are a choice's options — the same `id`, `text` and `assess`, deriving the
same A, B, C ids and meaning the same things. Option ids are scoped to their dropdown, so the
same id in two holes names two different options.

```
inline-choice [
  prompt "Complete the sentence."
  text "Plants absorb {{in}} and release {{out}}."
  dropdowns [
    [ id "in"
      options [
        [ text "carbon dioxide" assess [ correct ] ]
        [ text "oxygen" assess [ rationale "Oxygen is what plants release, not what they take in." ] ]
      ] {} ]
    [ id "out" options [ [ text "oxygen" assess [ correct ] ] [ text "nitrogen" ] ] {} ]
  ] {}
]..
```

A dropdown is worth its best correct option; the interaction is worth the sum of its dropdowns,
so two holes are two points and half the sentence is half the marks. A conjunctive item around
it makes the whole sentence worth one.

Use `inline-choice` when the answer should be recognized and `text-entry` when it should be
recalled — a menu gives the answer to anyone who reads it. The two do not mix in one sentence;
a question needing both is two parts of an item.

### order

Elements the candidate puts in sequence. Each carries `assess [position N]` saying where it
belongs, counting from 1.

```
order [
  prompt "Put the stages of the water cycle in order."
  elements [
    [ text "Condensation" assess [ position 2 ] ]
    [ text "Evaporation" assess [ position 1 ] ]
    [ text "Precipitation" assess [ position 3 ] ]
  ] {}
]..
```

The elements are authored in the order they are **presented**, never in the right one: the
compiled `interaction` is the half a graded delivery ships, and elements in their correct order
would be the answer key sitting inside it. The key is `responseProcessing "match_correct"` with
`cardinality "ordered"` and a `correctResponse` listing the ids in sequence.

All or nothing, worth one point. One pair swapped earns zero — unless the two read the same
thing, in which case they are one answer. Repeated text (the two "the"s of *the cat sat on the
mat*) produces an `interchangeable` group in the key, and either arrangement scores; the field
is absent when every element reads differently.

### position

Where an element belongs in an `order`, counting from 1. Positions are whole, unique, and run
from 1 to the number of elements; anything else is a compile error.

It is the only word an order element's `assess` takes, and it is refused in any other `assess` —
a `position` on a choice option would otherwise merge and be read by nobody.

### shuffle

Whether a list is presented in a random order. **The default is true** for a `choice`'s options,
an `inline-choice`'s menus and an `order`'s elements; `shuffle false` keeps the authored order.

Two lists keep their order without being asked: numbers in sequence (`2, 4, 5, 9, 11`), and the
two-option pairs True/False and Yes/No. In both the order is information, and scrambling it
makes the item worse. An authored `shuffle` overrides that in either direction.

An option reading "All of the above", "None of the above" or a close variant is **anchored**: it
carries `anchored: true` in the compiled option and stays last however the rest is shuffled.

```
choice [
  shuffle false
  options [
    [ text "Wet your hands" assess [ correct ] ]
    [ text "Apply soap" ]
  ] {}
]..
```

Shuffling happens when the item is rendered, never in the compiled output — the elements of an
`order` ship in the order they were authored, which is why the key is `position` and not that
order. `hottext` and an item's `parts` are never shuffled.

### match

Each item is paired with one of the targets. Targets carry authored ids, because an item's
`assess [ target "…" ]` names one; item ids derive as A, B, C.

```
match [
  prompt "Match each country to its capital."
  targets [ [ id "paris" text "Paris" ] [ id "tokyo" text "Tokyo" ] ] {}
  match-items [
    [ text "France" assess [ target "paris" ] ]
    [ text "Japan" assess [ target "tokyo" ] ]
  ] {}
]..
```

The key is a mapping over PAIRS — `"A paris"`, QTI's `directedPair` and its spelling — with
`baseType "directedPair"`. Worth one point per item and summed, so several pairings give partial
credit; `response-processing "match-correct"` makes it all-or-nothing at one point.

A target no item names is a distractor. Two items naming the same target is an error: a match
pairs each target with one item, and a shared target means the question is a `classification`.

### classification

The same key with categories, and the one where sharing is the point.

```
classification [
  prompt "Sort each animal into its class."
  categories [ [ id "mammal" text "Mammal" ] [ id "reptile" text "Reptile" ] ] {}
  classification-items [
    [ text "Blue whale" assess [ category "mammal" ] ]
    [ text "Bat" assess [ category "mammal" ] ]
  ] {}
]..
```

### target

The id of the target an item is matched with, inside its `assess`. Refused in any other
`assess`, and in a `classification`, which says `category`.

### category

The id of the category an item belongs in, inside its `assess`. Refused anywhere else.

### gap-match

A sentence whose gaps are filled from one bank shared across all of them.

```
gap-match [
  prompt "Complete the sentence."
  text "The {{a}} orbits the {{b}}."
  tokens [ [ id "moon" text "Moon" ] [ id "earth" text "Earth" ] [ id "sun" text "Sun" ] ] {}
  gaps [ [ id "a" assess [ token "moon" ] ] [ id "b" assess [ token "earth" ] ] ] {}
]..
```

The sentence is cut at its markers as a `text-entry`'s is, and the key is a `match`'s — a
mapping over pairs, `"<gap> <token>"`, with `baseType "directedPair"`. Worth a point per gap and
summed.

A token no gap names is a distractor. A token is spent once placed, so two gaps naming the same
one is a compile error: an answer that really does repeat belongs in an `inline-choice`, where
each hole has its own menu.

### token

The id of the token that fills a gap, inside its `assess`. Refused in any other `assess`.

### extended-text

A written response. Nothing here scores it: the key says `responseProcessing "human"` and
carries the rubric a person marks against, and the item reports its score as pending rather
than as zero. Needs at least two rubric bands; the item is worth the top one.

```
extended-text [
  prompt "What inference can be made about Mara? Explain using key details from the passage."
  rubric [
    [ points 2 descriptor "Makes a valid inference and cites two supporting details." ]
    [ points 1 descriptor "Makes a valid inference with one detail." ]
    [ points 0 descriptor "No valid inference, or no support from the text." ]
  ] {}
  exemplar "Mara is absorbed by the tide pool — she ignores the picnic and does not turn around."
]..
```

### response-processing

Which rule turns a response into a score. Two templates, named for QTI's own:

- **`map-response`** (the default) scores each selected option and sums them. This is
  per-option scoring: weighted answers, partial credit and penalties all live here.
- **`match-correct`** is all-or-nothing — every `correct` option and nothing else earns the
  point; a subset or a superset earns zero.

Choose `match-correct` when the question means "exactly these", as a select-the-two-sentences
item does. Per-option `points` is a compile error under it, because the item is already worth
one point for the whole set.

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

### max-choices

Raising it makes the item multi-select, and permits more than one option to be `correct`.
Marking more options correct than `max-choices` allows is a compile error.

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
