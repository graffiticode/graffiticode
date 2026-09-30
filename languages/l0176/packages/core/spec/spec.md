<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0176 Vocabulary

This specification documents dialect-specific functions available in the
**L0176** language of Graffiticode. These functions extend the core language
with functionality for building Learnosity assessment integrations.

The core language specification including the definition of its syntax,
semantics and base library can be found here:
[Graffiticode Language Specification](./graffiticode-language-spec.html)

## Functions

| Function | Arity | Signature | Description |
| :------- | :---: | :-------- | :---------- |
| `items` | 2 | `<list: list, continuation: record>` | The top-level block: builds one Learnosity item per `item` entry and renders their questions |
| `item` | 1 | `<members: list>` | One item, for the list `items` takes: its `questions` and `metadata` |
| `questions` | 2 | `<list: list, continuation: record>` | An item's questions — or, at top level, a questions-only activity |
| `author` | 1 | `<record: record>` | Creates a Learnosity Author API request |
| `init` | 1 | `<record: record>` | Signs a bare Learnosity API session request |
| `hello` | 1 | `<string: string>` | Evaluates to its argument; a diagnostic |

### Question Type Functions

Each question type function takes a member list of attributes and produces a
Learnosity question JSON object. Attributes not provided are filled with
sensible defaults, so `mcq []` produces a complete renderable question.

| Function | Arity | Learnosity Type | Description |
| :------- | :---: | :-------------- | :---------- |
| `mcq` | 1 | `mcq` | Multiple choice question |
| `shorttext` | 1 | `shorttext` | Short typed response |
| `longtext` | 1 | `longtextV2` | Essay with rich text editor |
| `plaintext` | 1 | `plaintext` | Essay with plain text |
| `clozetext` | 1 | `clozetext` | Fill-in-the-blank (typed responses) |
| `clozeassociation` | 1 | `clozeassociation` | Fill-in-the-blank (drag and drop) |
| `clozedropdown` | 1 | `clozedropdown` | Fill-in-the-blank (dropdown select) |
| `clozeformula` | 1 | `clozeformulaV2` | Fill-in-the-blank (math/formula) |
| `choicematrix` | 1 | `choicematrix` | Grid of options by stems |
| `orderlist` | 1 | `orderlist` | Drag items into correct order |
| `classification` | 1 | `classification` | Drag items into a grid of cells |
| `bowtie` | 1 | `bowtie` | NGN/NCLEX bow-tie: 2-1-2 drag-and-drop |
| `token-highlight` | 1 | `tokenhighlight` | Highlight tokens in a passage |
| `custom` | 1 | `custom` | Embed a separately deployed Graffiticode-language interaction |

### Attributes

An attribute is named for the Learnosity field it emits, so the program reads as
a transcription of the question JSON: `case-sensitive` emits `case_sensitive`.

Every attribute is an arity-1 member. A question is a bracketed member list —
`mcq [ stimulus "..." options [...] ]` — and every object inside it is written the
same way, so the same word works at any depth: `validation [ valid-response
[score 1 value ["a"]] ]` emits `validation.valid_response.value`. An array of
objects is a list of member lists. `{}` appears only on the arity-2 blocks
(`items`, `questions`), which take a continuation record.

A member list merges into one object, so each member may appear once in it —
write one `validation` holding both `scoring-type` and `valid-response`, not two.

Every word, what it emits, what it takes and which types accept it is listed in
the [Attribute Reference](#sec-Attribute-Reference).

### Scoring Types

Scored questions default to Learnosity's `exactMatch`: the learner must get every
response right to earn the point. `scoring-type`, inside `validation`, chooses
otherwise.

```
mcq [
  stimulus "Select all the prime numbers."
  options [
    [label "2" value "2"]
    [label "4" value "4"]
    [label "7" value "7"]
  ]
  multiple-responses true
  validation [
    scoring-type "partialMatch"
    valid-response [score 1 value ["2", "7"]]
  ]
]
```

| value | meaning | accepted by |
| :---- | :------ | :---------- |
| `exactMatch` | every part must be right | every scored type |
| `partialMatch` | a cumulative score per correct part | multi-response types |
| `partialMatchV2` | the question's score divided between the parts | multi-response types |
| `partialMatchPairwise` | adjacent entries compared in pairs | `orderlist` |
| `partialMatchElement`, `partialMatchElementV2` | per response element rather than per cell | `classification`, `bowtie` |

The accepted set is per type, taken from that type's Learnosity article, and a
value the widget does not document is a compile error — Learnosity would silently
fall back to `exactMatch`, mis-scoring the question without saying so.


## Function Reference

### items

Builds one Learnosity item record per `item` entry and renders their questions.

The list holds two kinds of thing: `item` entries, and members that belong to
the activity as a whole — `params`, the dynamic-content table. The trailing
record is program metadata and travels onto the compiled output.

```
items [
  item [
    questions [
      mcq [
        stimulus "What is the capital of France?"
        options [
          [label "Paris" value "0"]
          [label "London" value "1"]
          [label "Berlin" value "2"]
          [label "Madrid" value "3"]
        ]
        validation [
          valid-response [score 1 value ["0"]]
        ]
      ]
    ] {}
  ]
] {}
```

Every item's questions flatten into one rendered list, because rendering goes
through the Questions API with inline question data — item grouping is not
visible in the preview.

Item references are `graffiticode-{lrn-id}-{n}`, numbered from zero, and the
question references beneath them carry the same ordinal. **Changing the number
or order of items changes the references**, so an item whose position moves is
written to the bank as a new item rather than updated in place.

By default `items` emits a preview: the items and their questions render
inline through Questions API without being written to the Learnosity
item bank. Wrap the activity in `save-to-itembank` to persist it:
`save-to-itembank items [...] {}`. Saved items always land as `status: "unpublished"`
(draft) — publishing is an Author Site concern, not a DSL one.

The write happens only in a compile that selects a connection, through the
credential broker. Without one, the save is checked but not run: the result
carries `itemBank: { skipped: "no-connection", fn, occurrence }` beside the
activity, the preview still renders, and it is not an error. Programs do not
carry Learnosity credentials (`set-var "learnosity-key"`/`"learnosity-secret"`
are ignored): the selected connection signs the preview and performs the
write, and without one the preview is signed by Graffiticode's own system
connection, which can sign previews and nothing else. If no preview signing
is available the activity comes back unsigned with a
`signing: { unsigned, message }` note, and that is not an error either.

```
set-var "lrn-id" "mitochondria-mcq"
save-to-itembank items [
  item [questions [mcq [ ... ]] {}]
] {}
```

`params` gives the activity a table of variable values. Each session draws one
row and substitutes its columns into `{{column}}` placeholders in the questions:

```
set-var "lrn-id" get-val-public "itemId"
items [
  params [
    { A1: "50", A2: "25" }
    { A1: "100", A2: "75" }
  ]
  item [
    questions [
      shorttext [stimulus "What is {{A1}} + {{A2}}?"]
    ] {}
  ]
] {}..
```

An embedded L0179 `custom` question whose output carries its own table supplies
it instead, and wins over `params`.

The older member form, `items [save-to-itembank true ...] {}`, is still
accepted and is rewritten to the wrapper before compiling. Any other way of
setting the flag is an error.

### item

Defines a single item, for the list `items` takes. Its members are `questions`
and `metadata`; `params` belongs to `items` rather than to any one item, since
Learnosity attaches one dynamic-content table per rendered activity.

```
item [
  metadata [ tags { NGSS: "MS-LS1-2" } notes "Variant A" ]
  questions [mcq []] {}
]
```

### questions

An item's questions: a list of question type calls and a continuation record.
Used inside `item`, or on its own at top level for a questions-only activity.

```
questions [
  mcq [
    stimulus "What is 2 + 2?"
    options [
      [label "3" value "0"]
      [label "4" value "1"]
      [label "5" value "2"]
    ]
    validation [
      valid-response [score 1 value ["1"]]
    ]
  ]
] {}
```

### author

Creates a Learnosity Author API request from the given configuration record.
Like `items`, it needs `set-var "lrn-id"`, which names the item being authored.
An Author session is signed only in a compile that selects a connection; without
one the request is returned unsigned, and the system preview signing never signs it.

```
set-var "lrn-id" "mitochondria-mcq"
author { "mode": "item_edit" }..
```

### init

Signs a bare Learnosity session request built from the given record, whose
`type` — `"items"`, `"questions"` or `"author"` — selects the API. Rarely
needed: `items` and `questions` produce signed requests themselves.

```
init { "type": "items" }
```

### hello

Evaluates to its argument. A diagnostic for checking that the language server
responds; it renders nothing useful.

```
hello "world"
```

### mcq

Select one or more answers from a list. Each option is a `{label, value}` object:
the label is shown, the value is what a response records, so it is yours to
choose. `valid-response` lists the values of the correct options.

```
mcq [
  stimulus "Which planet is closest to the Sun?"
  options [
    [label "Mercury" value "mercury"]
    [label "Venus" value "venus"]
    [label "Earth" value "earth"]
  ]
  instant-feedback true
  validation [
    valid-response [score 1 value ["mercury"]]
  ]
]
```

Set `multiple-responses true` to turn the radio buttons into checkboxes, then
`min-selection` / `max-selection` to bound how many may be picked.

### shorttext

A short typed answer — a word or two, or a number. Note `valid-response`'s
`value` is a bare string here, not a list: this type has one response box.

```
shorttext [
  stimulus "What is the chemical symbol for water?"
  case-sensitive false
  validation [
    valid-response [score 1 value "H2O"]
  ]
]
```

### longtext

Creates an essay question with a rich text editor. No auto-scoring.

```
longtext [
  stimulus "Describe the water cycle in your own words."
  max-length 300
  placeholder "Write your essay here..."
  show-word-count true
]
```

### plaintext

Creates an essay question with a plain text editor. No auto-scoring.

```
plaintext [
  stimulus "Explain your reasoning."
  max-length 200
]
```

### clozetext

Fill-in-the-blank: the learner types into response boxes placed in a passage.

`stimulus` is the prompt shown above the response area; `template` is the passage,
with `{{response}}` marking each blank.

```
clozetext [
  stimulus "Fill in the blanks."
  template "The {{response}} is the {{response}}."
  case-sensitive false
  validation [
    scoring-type "partialMatch"
    valid-response [score 1 value ["cat", "mat"]]
  ]
]
```

`valid-response` holds one answer per blank, in order. Its `score` and `value` are
arity-1 members: a list of them merges into the single `valid_response` object.

#### Accepted alternate answers

`valid-response` is one answer set, so a second accepted answer for a blank is not
another entry in it — it is a whole alternate set under `alt-responses`. Each entry
is its own member list, and each must cover every `{{response}}` marker:

```
clozetext [
  template "The capital of France is {{response}}."
  validation [
    valid-response [score 1 value ["Paris"]]
    alt-responses [[score 1 value ["Paree"]]]
  ]
]
```

`score` may be omitted from a member list, in which case Learnosity's default
applies. For case variants prefer `case-sensitive false` over listing spellings.

#### Scoring

`scoring-type` takes `exactMatch` (the default), `partialMatch` (a cumulative score
per correct blank) or `partialMatchV2` (the question score divided between blanks).
Any other value is a compile error: Learnosity silently falls back to `exactMatch`
on an unrecognized one, which would mis-score the question without saying so.

#### Response length

`max-length` caps the characters a learner may type **per blank**. Learnosity's
default is `15`, so an answer longer than fifteen characters cannot be entered
unless this is raised. The maximum is 250.

### clozeassociation

Fill-in-the-blank where the learner drags responses from a pool into blanks.
`stimulus` is the prompt, `template` the passage carrying the `{{response}}`
markers, and `possible-responses` the draggable choices.

```
clozeassociation [
  stimulus "Drag the correct answer into the blank."
  template "{{response}} is the capital of France."
  possible-responses ["Paris", "London", "Berlin"]
  validation [
    valid-response [score 1 value ["Paris"]]
  ]
]
```

### clozedropdown

Fill-in-the-blank with drop-down selects. `stimulus` is the prompt and
`template` the passage. Each drop-down gets its own list of choices, in order of
appearance, so `possible-responses` is a list of lists.

```
clozedropdown [
  stimulus "Select the answer."
  template "The sky is {{response}}."
  possible-responses [["blue", "red", "green"]]
  validation [
    valid-response [score 1 value ["blue"]]
  ]
]
```

### clozeformula

Math input into one or more response boxes. The keyword is `clozeformula` but the
emitted type is `clozeformulaV2` — Learnosity calls it "Math"; its own
`clozeformula` ("Cloze math") is an older, different type.

This is the deepest nesting in the language. `validation.valid_response.value` is
an array per blank of arrays of **rule objects**, each with a `method`, usually a
`value`, and optionally `options`:

```
clozeformula [
  stimulus "It takes 25 minutes to walk and 45 to drive."
  template "{{response}} minutes = {{response}} hour and {{response}} minutes"
  is-math true
  ui-style [type "block-on-focus-keyboard"]
  validation [
    scoring-type "exactMatch"
    valid-response [
      score 1
      value [ [[method "equivLiteral" value "70"]]
              [[method "equivValue" value "1" options [decimal-places 2]]]
              [[method "equivLiteral" value "10"]] ]
    ]
  ]
]
```

A rule may carry a `method` and no `value` at all — `isExpanded`, `isSimplified`
and `isTrue` are predicates on the response rather than comparisons against an
answer.

Accepting several different expressions for one blank is what `alt-responses` is
for: each entry is a complete answer set covering every blank.

```
clozeformula [
  template "Simplify 4/8: {{response}}"
  validation [
    valid-response [value [[[method "equivLiteral" value "1/2"]]]]
    alt-responses [[value [[[method "equivLiteral" value "0.5"]]]]
                   [value [[[method "equivLiteral" value "2/4"]]]]]
  ]
]
```

Notation never needs enumerating — `1/2`, `1 / 2` and `\frac{1}{2}` are one
expression under every method. Only genuinely different expressions do.

#### Methods and options are not checked

Nothing constrains `method` or the keys of `options`, deliberately. The
documentation does not settle either question: the full method list appears on
exactly one of Learnosity's 51 articles, and the `options` bag is documented as
two disjoint sets with neither matching its own examples. See C1 and C2 in
`conflict-resolution.md`. Rather than encode a guess, the compiler passes both
through and the author writes what Learnosity accepts.

Note the `options` keys are camelCase — `decimal-places` emits `decimalPlaces` —
alone among Learnosity's fields.

### choicematrix

A grid of prompts and choices. Learnosity's names: `stems` are the row prompts,
`options` the column choices. Set `multiple-responses true` to turn each row's
radio buttons into checkboxes.

```
choicematrix [
  stimulus "Classify each statement as true or false."
  stems ["The sun is a star", "The moon is a planet"]
  options ["True", "False"]
  validation [
    valid-response [score 1 value [[0], [1]]]
  ]
]
```

### orderlist

Drag items into the correct order. Alone among the types, its `scoring-type`
reaches `partialMatchPairwise`, which compares adjacent entries rather than
scoring each position outright.

```
orderlist [
  stimulus "Arrange these events in chronological order."
  list ["World War II", "World War I", "Moon Landing", "Internet"]
  validation [
    scoring-type "partialMatchPairwise"
    valid-response [score 1 value [1, 0, 2, 3]]
  ]
]
```

### classification

Drag items into a grid of cells. The layout lives in `ui-style`, where Learnosity
puts it: `column-count` and `column-titles`, plus `row-count` and `row-titles` for
a two-dimensional grid. `valid-response`'s value is one array of
`possible-responses` indices per cell, in reading order.

```
classification [
  stimulus "Sort the animals into the correct categories."
  possible-responses ["Dog", "Snake", "Cat", "Lizard"]
  ui-style [
    column-count 2
    column-titles ["Mammals", "Reptiles"]
  ]
  validation [
    valid-response [score 1 value [[0, 2], [1, 3]]]
  ]
]
```

`possible-responses` is absent from Learnosity's own attribute table for this
type even though the type cannot work without it — see C9 in
`conflict-resolution.md`.

### bowtie

A Next-Gen NCLEX bow-tie: source pools feed the drop zones of a bow-tie diagram.
`possible-response-groups` gives each pool a `title` and its `responses`, and
`ui-style` carries the `column-titles` shown above the drop zones.

`valid-response`'s value is one array of indices per drop zone, indexing into the
groups flattened in order — so with pools of 4, 3 and 4, the second pool occupies
indices 4 to 6.

```
bowtie [
  stimulus "65-year-old male presents with chest pain and diaphoresis."
  group-possible-responses true
  possible-response-groups [
    [title "Actions to Take"
     responses ["give aspirin", "give nitro", "call cardiology", "obtain 12-lead ECG"]]
    [title "Condition Most Likely"
     responses ["myocardial infarction", "pulmonary embolism", "pericarditis"]]
    [title "Parameters to Monitor"
     responses ["ST segment changes", "blood pressure", "troponin", "respiratory rate"]]
  ]
  ui-style [
    column-titles ["Actions to Take", "Condition Most Likely", "Parameters to Monitor"]
  ]
  validation [
    valid-response [score 1 value [[0, 3], [4], [7, 9]]]
  ]
]
```

Nothing checks those indices. Learnosity documents no numbering scheme beyond
"an array with three elements representing each drop zone", and the indices in
its own worked example do not decode under any scheme — see C8 in
`conflict-resolution.md`. Until a bow-tie has been rendered and inspected, a
wrong index produces a wrong question silently.

### token-highlight

The learner clicks words, sentences or paragraphs in a passage. `template` is the
passage with each clickable token wrapped in `<span class="lrn_token">`, and
`valid-response`'s value is the indices of the correct spans in document order,
counting from zero.

```
token-highlight [
  stimulus "Highlight the verbs."
  template "The <span class=\"lrn_token\">cat</span> <span class=\"lrn_token\">runs</span> then <span class=\"lrn_token\">jumps</span>."
  tokenization "custom"
  validation [
    scoring-type "partialMatch"
    valid-response [score 1 value [1, 2]]
  ]
]
```

`tokenization` selects how the passage is split: `"custom"` honours the spans you
wrote, while `"word"`, `"sentence"` and `"paragraph"` let Learnosity split the
passage for you, in which case the template needs no spans at all.

### custom

Embeds a separately deployed Graffiticode-language interaction as a Learnosity
custom question. `lang` is required and identifies the deployed interaction;
the compiler synthesizes `custom_type` and the question / scorer / CSS
URLs from `https://l<lang>.graffiticode.org/...`.

`model` carries the interaction's content and is emitted unchanged as the
question's `data` field — Learnosity's per-question payload, read by the
interaction's own script. Its shape is determined by the deployed interaction at
`l<lang>.graffiticode.org`; consult that integration's docs for the fields it
expects. Any other member, such as `stimulus`, passes through onto the question.

```
custom [
  lang "0179"
  stimulus "..."
  model { ...interaction-specific fields... }
]
```

Compiles to:

```json
{
  "type": "custom",
  "custom_type": "custom_question_l0179",
  "stimulus": "...",
  "js": {
    "question": "https://l0179.graffiticode.org/question.js",
    "scorer":   "https://l0179.graffiticode.org/scorer.js"
  },
  "css": "https://l0179.graffiticode.org/question.css",
  "data": { ...interaction-specific fields... }
}
```

#### Pipeline composition

When an L0176 program is wired downstream of another Graffiticode task in
the console pipeline, the upstream task's compiled output is read via the
base-language `data` primitive and passed to the `custom` question through
its `model` member. There are two equivalent forms:

```
custom [
  lang "0179"
  stimulus "Use the spreadsheet to compute the column totals."
  model data use "0179"
]
```

```
custom [
  lang "0179"
  stimulus "Use the spreadsheet to compute the column totals."
  model data {}
]
```

- **`data use "<lang>"`** (preferred) declares the upstream language
  explicitly. The console reads this annotation at write time, fetches
  `L<lang>/schema.json`, and reactively generates the upstream task to
  chain. Falls back to `{}` if no upstream is bound at runtime.
- **`data {default}`** is the untyped form: returns the upstream's
  compiled output if a producer is wired, or the supplied default
  otherwise. No language hint, so the console will not auto-discover
  an upstream — the chain must be assembled manually.
- For both forms, the `lang` of the surrounding `custom` should match
  the upstream dialect.
- Wiring of producer task ID to consumer is set in the console's pipeline
  editor (or assembled reactively from the `use` hint), not by hand in
  source.
- An L0176 program has at most one upstream. Multiple `custom` questions
  in the same program all read the same upstream value.
- Scoring is the deployed interaction's own concern (`scorer.js`).
  `valid-response` is not used with `custom`.
- `save-to-itembank` freezes the upstream value at compile time into
  the saved item — the bank entry is a snapshot, not a live reference.
  Re-authoring the upstream after save does not update the bank entry.

<!-- BEGIN attribute-reference -->
## Attribute Reference

Every attribute the language accepts: the Learnosity field it emits, the value it
takes and where it goes. Generated by `tools/gen-attribute-reference.mjs` from
the registries in `question-types.ts` and the descriptions in
`tools/attribute-docs.mjs` — if a word is missing here it is missing from the
language, not from the documentation.

Every attribute is an arity-1 member, and an object is written as a member list,
so a question nests the way its JSON does:

```
clozetext [
  stimulus "Complete the sentence."
  template "The {{response}} is the powerhouse of the cell."
  max-length 20
  validation [
    scoring-type "exactMatch"
    valid-response [score 1 value ["mitochondria"]]
  ]
]
```

### Question Attributes

Written directly in a question's member list. Each question type accepts only the attributes Learnosity documents for it; any other is a compile error naming the ones it does take.

| keyword | Learnosity field | accepted by |
|---|---|---|
| `case-sensitive` | `case_sensitive` | shorttext, clozetext, clozedropdown |
| `character-map` | `character_map` | shorttext, longtext, plaintext, clozetext |
| `disable-auto-link` | `disable_auto_link` | longtext |
| `duplicate-responses` | `duplicate_responses` | clozeassociation, classification |
| `feedback-attempts` | `feedback_attempts` | mcq, shorttext, clozetext, clozeassociation, clozedropdown, clozeformula, choicematrix, orderlist, classification, bowtie, token-highlight |
| `formatting-options` | `formatting_options` | longtext |
| `group-possible-responses` | `group_possible_responses` | clozeassociation, classification, bowtie |
| `handwriting-recognises` | `handwriting_recognises` | clozeformula |
| `hints` | `hints` | clozeformula |
| `horizontal-layout` | `horizontal_layout` | longtext, clozeformula |
| `ignore-leading-and-trailing-spaces` | `ignore_leading_and_trailing_spaces` | shorttext, clozetext |
| `instant-feedback` | `instant_feedback` | mcq, shorttext, clozetext, clozeassociation, clozedropdown, clozeformula, choicematrix, orderlist, classification, bowtie, token-highlight |
| `instructor-stimulus` | `instructor_stimulus` | all types |
| `is-dynamic-content` | `is_dynamic_content` | clozeformula |
| `is-math` | `is_math` | all types |
| `list` | `list` | orderlist |
| `match-all-possible-responses` | `match_all_possible_responses` | clozetext, clozeassociation, clozedropdown |
| `math-image-capture` | `math_image_capture` | clozeformula |
| `max-length` | `max_length` | shorttext, longtext, plaintext, clozetext |
| `max-response-per-cell` | `max_response_per_cell` | classification |
| `max-selection` | `max_selection` | mcq, token-highlight |
| `metadata` | `metadata` | all types |
| `min-selection` | `min_selection` | mcq |
| `multiple-line` | `multiple_line` | clozetext |
| `multiple-responses` | `multiple_responses` | mcq, choicematrix |
| `options` | `options` | mcq, choicematrix |
| `placeholder` | `placeholder` | shorttext, longtext, plaintext |
| `possible-response-groups` | `possible_response_groups` | bowtie |
| `possible-responses` | `possible_responses` | clozeassociation, clozedropdown, classification |
| `response-container` | `response_container` | shorttext, clozetext, clozeassociation, clozedropdown, clozeformula |
| `response-containers` | `response_containers` | clozetext, clozeassociation, clozedropdown, clozeformula |
| `show-copy` | `show_copy` | plaintext |
| `show-cut` | `show_cut` | plaintext |
| `show-hints-button` | `show_hints_button` | clozeformula |
| `show-paste` | `show_paste` | plaintext |
| `show-word-count` | `show_word_count` | longtext |
| `show-word-limit` | `show_word_limit` | longtext |
| `shuffle-options` | `shuffle_options` | mcq, clozeassociation, clozedropdown, choicematrix, orderlist, classification |
| `spellcheck` | `spellcheck` | shorttext, longtext, plaintext, clozetext |
| `stems` | `stems` | choicematrix |
| `stimulus` | `stimulus` | all types |
| `stimulus-review` | `stimulus_review` | all types |
| `submit-over-limit` | `submit_over_limit` | longtext, plaintext |
| `template` | `template` | clozetext, clozeassociation, clozedropdown, clozeformula, token-highlight |
| `text-blocks` | `text_blocks` | longtext, clozeformula |
| `tokenization` | `tokenization` | token-highlight |
| `ui-style` | `ui_style` | all types |
| `validation` | `validation` | all types |

#### case-sensitive

Emits `case_sensitive` · boolean · shorttext, clozetext, clozedropdown

Whether letter case counts when comparing the response with the answer. Learnosity's default is `false`. Prefer `case-sensitive false` to listing case variants as alternates.

#### character-map

Emits `character_map` · boolean or list of strings · shorttext, longtext, plaintext, clozetext

Shows a special-character button. `true` gives Learnosity's default set; a list shows exactly those characters.

#### disable-auto-link

Emits `disable_auto_link` · boolean · longtext

Stops the rich text editor turning typed URLs into links.

#### duplicate-responses

Emits `duplicate_responses` · boolean · clozeassociation, classification

Lets each possible response be used any number of times.

#### feedback-attempts

Emits `feedback_attempts` · number · mcq, shorttext, clozetext, clozeassociation, clozedropdown, clozeformula, choicematrix, orderlist, classification, bowtie, token-highlight

How many times the learner may press Check Answer; `0` (the default) is unlimited. Needs `instant-feedback true`.

#### formatting-options

Emits `formatting_options` · list of strings · longtext

The rich text editor's toolbar buttons, e.g. `["bold", "italic", "unorderedList"]`.

#### group-possible-responses

Emits `group_possible_responses` · boolean · clozeassociation, classification, bowtie

Sorts the possible responses into groups, each under its own heading. `bowtie` groups come from `possible-response-groups`.

#### handwriting-recognises

Emits `handwriting_recognises` · string · clozeformula

The math grammar set handwriting input recognises. Learnosity's default is `"standard"`.

#### hints

Emits `hints` · member list · clozeformula

Hints the learner can reveal, shown by `show-hints-button` (Learnosity v2025.1.LTS and later). Holds `items-list`, a list of `[content "..."]` entries.

#### horizontal-layout

Emits `horizontal_layout` · boolean · longtext, clozeformula

Uses a compact horizontal keypad of two rows instead of the standard one — for `longtext`, its formula keypad.

#### ignore-leading-and-trailing-spaces

Emits `ignore_leading_and_trailing_spaces` · boolean · shorttext, clozetext

Trims the response before comparing. Learnosity's default is `true`. (Inside a scoring rule's `options`, use `ignore-leading-and-trailing-spaces-rule`.)

#### instant-feedback

Emits `instant_feedback` · boolean · mcq, shorttext, clozetext, clozeassociation, clozedropdown, clozeformula, choicematrix, orderlist, classification, bowtie, token-highlight

Adds a Check Answer button. It needs `validation` with a `valid-response` to check against, or the button marks nothing.

#### instructor-stimulus

Emits `instructor_stimulus` · string · all types

Notes for the educator, shown above the stimulus only when the host sets Learnosity's `showInstructorStimulus` option — never to learners otherwise.

#### is-dynamic-content

Emits `is_dynamic_content` · boolean · clozeformula

Set by Learnosity when the question was made by its Math Question Generator. Not related to `params`; leave it unset.

#### is-math

Emits `is_math` · boolean · all types

Renders LaTeX in the question with MathJax. Write every backslash doubled — `\\frac{1}{2}`.

#### list

Emits `list` · list of strings · orderlist

The statements to be ordered, in the order shown. `valid-response`'s value gives their correct order as indices into this list.

#### match-all-possible-responses

Emits `match_all_possible_responses` · boolean · clozetext, clozeassociation, clozedropdown

Allows more than one valid response for a given blank. Learnosity's default is `false`.

#### math-image-capture

Emits `math_image_capture` · boolean · clozeformula

Lets the learner answer by photographing handwritten math.

#### max-length

Emits `max_length` · number · shorttext, longtext, plaintext, clozetext

The longest answer the learner can enter. Characters for `shorttext` (default 50) and per blank for `clozetext` (default 15 — raise it for long answers), both capped at 250; words for `longtext` and `plaintext` (default 10000).

#### max-response-per-cell

Emits `max_response_per_cell` · number · classification

The most responses a single cell accepts; `0` or unset is no limit.

#### max-selection

Emits `max_selection` · number · mcq, token-highlight

The most choices the learner may select: on `mcq` it takes effect only with `multiple-responses true`; also `token-highlight`.

#### metadata

Emits `metadata` · member list · all types

Question-level metadata — see [Metadata Members](#sec-Metadata-Members). The same word at item level carries the item's tags and Author Site fields.

#### min-selection

Emits `min_selection` · number · mcq

The fewest choices the learner must select. Takes effect only with `multiple-responses true`.

#### multiple-line

Emits `multiple_line` · boolean · clozetext

Makes each blank a multi-line text area instead of a one-line input.

#### multiple-responses

Emits `multiple_responses` · boolean · mcq, choicematrix

Turns radio buttons into checkboxes, so more than one option — per row, on `choicematrix` — may be chosen.

#### options

Emits `options` · list of member lists, list of strings, or member list · mcq, choicematrix

For `mcq`, the choices, each `[label "..." value "..."]` — the value is what a response records and what `valid-response` names. For `choicematrix`, the column headings as strings. Inside a `clozeformula` scoring rule, a member list of [Rule Options](#sec-Rule-Options). The element types tell the three apart.

#### placeholder

Emits `placeholder` · string · shorttext, longtext, plaintext

Text shown in an empty response box (on `clozedropdown`, in every unselected menu). Also a `response-container` member, per box.

#### possible-response-groups

Emits `possible_response_groups` · list of member lists · bowtie

The titled source pools, each `[title "..." responses ["...", ...]]`. Answer indices count through the pools in order.

#### possible-responses

Emits `possible_responses` · list · clozeassociation, clozedropdown, classification

The draggable or selectable responses. A list of strings, except `clozedropdown`, which takes one list per drop-down in order of appearance.

#### response-container

Emits `response_container` · member list · shorttext, clozetext, clozeassociation, clozedropdown, clozeformula

Sizing and input settings applied to every response box — see [Response Container Members](#sec-Response-Container-Members).

#### response-containers

Emits `response_containers` · list of member lists · clozetext, clozeassociation, clozedropdown, clozeformula

The same settings per response box, one entry per `{{response}}` in order.

#### show-copy

Emits `show_copy` · boolean · plaintext

Shows a copy button in the plain text editor.

#### show-cut

Emits `show_cut` · boolean · plaintext

Shows a cut button in the plain text editor.

#### show-hints-button

Emits `show_hints_button` · boolean · clozeformula

Shows the button that reveals `hints`.

#### show-paste

Emits `show_paste` · boolean · plaintext

Shows a paste button in the plain text editor.

#### show-word-count

Emits `show_word_count` · boolean · longtext

Shows the current word count under the text box. Learnosity's default is `true`.

#### show-word-limit

Emits `show_word_limit` · string · longtext

How the `max-length` word limit is shown: `"always"` (the default), `"on-limit"` (only once exceeded) or `"off"`.

#### shuffle-options

Emits `shuffle_options` · boolean · mcq, clozeassociation, clozedropdown, choicematrix, orderlist, classification

Shuffles the order of the choices, stems or entries for each learner.

#### spellcheck

Emits `spellcheck` · boolean · shorttext, longtext, plaintext, clozetext

Sets the input's spellcheck, autocapitalize, autocomplete and autocorrect browser attributes. Learnosity's default is `false`.

#### stems

Emits `stems` · list of strings · choicematrix

The row prompts. `valid-response`'s value has one entry per stem.

#### stimulus

Emits `stimulus` · string · all types

The prompt the learner reads. On cloze types it sits above the `template`, and never carries a `{{response}}` blank.

#### stimulus-review

Emits `stimulus_review` · string · all types

A stimulus shown only in review mode, in place of `stimulus`.

#### submit-over-limit

Emits `submit_over_limit` · boolean · longtext, plaintext

Whether the learner may save or submit once the word limit is exceeded. Learnosity's default is `false`.

#### template

Emits `template` · string · clozetext, clozeassociation, clozedropdown, clozeformula, token-highlight

The passage. On cloze types, `{{response}}` marks each blank; on `token-highlight`, each clickable token is wrapped in `<span class="lrn_token">` when `tokenization` is `"custom"`.

#### text-blocks

Emits `text_blocks` · list of strings · longtext, clozeformula

Character sequences the formula keypad treats as text rather than math — `"cm"` rather than c × m. Each at most 9 characters.

#### tokenization

Emits `tokenization` · string · token-highlight

How the passage is split into tokens: `"custom"` (the spans in `template`), `"word"`, `"sentence"` or `"paragraph"`.

#### ui-style

Emits `ui_style` · member list · all types

Layout and display settings — see [Layout Members](#sec-Layout-Members).

#### validation

Emits `validation` · member list · all types

How the question is scored — see [Validation Members](#sec-Validation-Members). Write one `validation` per question: a member given twice is a compile error.

### Validation Members

Written inside `validation [ ... ]`, which emits the question's `validation` object.

#### accent-penalty-points

Emits `accent_penalty_points` · number

Inside `accent-sensitivity`: points deducted when a response is accepted despite its accents differing.

#### accent-sensitivity

Emits `accent_sensitivity` · member list

Accepts responses whose accents differ from the answer: `accent-sensitivity [enabled true accent-penalty-points 0.5]` marks "cafe" correct against "café", less the penalty.

#### allow-negative-scores

Emits `allow_negative_scores` · boolean

Lets a `penalty` take the score below zero.

#### alt-responses

Emits `alt_responses` · list of member lists

Alternate correct answers, each a complete answer set covering every blank, e.g. `alt-responses [[score 1 value ["Paree"]]]`.

#### automarkable

Emits `automarkable` · boolean

Whether Learnosity scores the question automatically (the default) or it must be marked manually.

#### enable-fullwidth-scoring

Emits `enable_fullwidth_scoring` · boolean

Treats full-width characters (as typed in CJK input modes) as their ordinary equivalents when comparing.

#### enabled

Emits `enabled` · boolean

Inside `accent-sensitivity`: when `true`, accents are ignored when checking the response. Learnosity's default is `false`.

#### feedbackaide-passages

Emits `feedbackaide_passages` · boolean

Includes shared passage content in the same item in Feedback Aide scoring. A premium feature.

#### max-score

Emits `max_score` · number

The most points the question can award — for the manually scored `longtext` and `plaintext`.

#### min-score-if-attempted

Emits `min_score_if_attempted` · number

The least a learner scores for any attempt.

#### penalty

Emits `penalty` · number

Points deducted for an incorrect response.

#### score-with-feedbackaide

Emits `score_with_feedbackaide` · boolean

Scores the essay with Learnosity Feedback Aide, its AI scoring engine, against a rubric. A premium feature.

#### scoring-type

Emits `scoring_type` · string

`exactMatch` (the default), or a partial-scoring mode the type accepts — see [Scoring Types](#sec-Scoring-Types). An unaccepted value is a compile error.

#### unscored

Emits `unscored` · boolean

Excludes the question from scoring — a practice or survey question.

#### valid-response

Emits `valid_response` · member list

The correct answer: `[score 1 value ...]`. The shape of `value` is per type, and shown in each type's section of the Function Reference.

### Answer Members

Written inside an answer set — `valid-response [ ... ]` or one entry of `alt-responses [[ ... ] [ ... ]]` — and, for `clozeformula`, inside each scoring rule of the answer's `value`.

#### matching-rule

Emits `matching_rule` · string

For `shorttext`: `"exactMatch"`, or `"contains"` to accept the answer appearing as a whole word anywhere in the response.

#### method

Emits `method` · string

A `clozeformula` scoring rule's comparison: `equivLiteral` (the form must match), `equivSymbolic` (any equivalent expression), `equivValue` (the same value), `equivSyntax` (the shape of the answer), `stringMatch` (the characters), or a predicate taking no `value` — `isSimplified`, `isFactorised`, `isExpanded`, `isTrue` — or `isUnit`. Not checked by the compiler; an unknown method errors in Learnosity and scores 0.

#### score

Emits `score` · number

The points the answer set is worth. When omitted, Learnosity's default applies.

#### value

Emits `value` · string, number or list

The answer itself. Its shape is per type: option values for `mcq`, one string per blank for cloze types, one index list per row, cell or zone for grid types, and for `clozeformula` a list per blank of scoring rules, each `[method "..." value "..."]`. Never a member list — `value [score 1 value ...]` is a compile error. Also `mcq`'s option value — see `options`.

### Rule Options

Written inside a `clozeformula` scoring rule's `options [ ... ]`. They are the only words in the language that emit camelCase. None is checked against the rule's `method`: Learnosity documents options per method but accepts, and sometimes ignores, any of them on any method — see C2 in `conflict-resolution.md`.

#### allow-decimal

Emits `allowDecimal` · boolean

Allows decimal marks in the response.

#### allow-thousands-separator

Emits `allowThousandsSeparator` · boolean

Allows a thousands separator in numbers.

#### compare-sides

Emits `compareSides` · boolean

Compares the two sides of an equation separately rather than as a whole.

#### decimal-places

Emits `decimalPlaces` · number

Significant decimal places compared by `equivValue` and `equivSymbolic` (default 10).

#### ignore-leading-and-trailing-spaces-rule

Emits `ignoreLeadingAndTrailingSpaces` · boolean

For `stringMatch`: trims the response before comparing. Emits `ignoreLeadingAndTrailingSpaces`.

#### ignore-order

Emits `ignoreOrder` · boolean

Ignores the order of terms. Documented for `equivLiteral`, but discarded by Learnosity's scorer — see C2.

#### ignore-text

Emits `ignoreText` · boolean

Discards LaTeX `\\text{...}` the learner types beside the answer, so `1.23\\text{ cm}` still counts as a decimal.

#### inverse-result

Emits `inverseResult` · boolean

Inverts the rule: a response that matches scores wrong.

#### set-decimal-separator

Emits `setDecimalSeparator` · string

The character used as the decimal mark.

#### set-thousands-separator

Emits `setThousandsSeparator` · list of strings

The characters accepted as thousands separators.

#### syntax

Emits `syntax` · string

For `equivSyntax`: the form the response must take, written as a LaTeX-style command with an optional digit count — `"\\number"`, `"\\integer"`, `"\\decimal3"`, `"\\scientific"`, `"\\variable"`, `"\\fraction"`, `"\\simpleFraction"`, `"\\mixedFraction"` or `"\\fractionOrDecimal"`.

#### treat-letters-as-variables

Emits `treatLettersAsVariables` · boolean

For `equivSymbolic`: treats letters as algebraic variables.

#### treat-multiple-spaces-as-one

Emits `treatMultipleSpacesAsOne` · boolean

For `stringMatch`: collapses runs of spaces before comparing.

### Layout Members

Written inside `ui-style [ ... ]`, which emits the question's `ui_style` object. Which keys a widget honours is set by Learnosity per type; L0176 does not check them.

#### choice-label

Emits `choice_label` · string

For `mcq` in the `"block"` style: the numbering beside each option — `"number"`, `"upper-alpha"` or `"lower-alpha"`.

#### column-count

Emits `column_count` · number

For `classification`: the number of columns in the grid (default 1).

#### column-titles

Emits `column_titles` · list of strings

Column headings: the `classification` categories, or the `bowtie` drop zones.

#### columns

Emits `columns` · number

For `mcq`: the number of columns the options are divided across (default 1).

#### fontsize

Emits `fontsize` · string

Text size: `"small"`, `"normal"`, `"large"`, `"xlarge"` or `"xxlarge"`.

#### horizontal-lines

Emits `horizontal_lines` · boolean

For `choicematrix`: draws a line under each prompt row.

#### keyboard-below-response-area

Emits `keyboard_below_response_area` · boolean

For `clozeformula`: places the floating keypad below the last line of the response area instead of partly over it.

#### max-height

Emits `max_height` · string

For `longtext`: the greatest height of the text box before it scrolls; unset, it grows with the text.

#### min-height

Emits `min_height` · string

For `longtext`: the least height of the text box in pixels, e.g. `"50px"`.

#### min-width

Emits `min_width` · string

For `clozeformula`: the least width of the response input area, e.g. `"550px"`.

#### option-row-title

Emits `option_row_title` · string

For `choicematrix`: an extra title above the response columns.

#### option-width

Emits `option_width` · string

For `choicematrix`: the width of each response column in pixels.

#### orientation

Emits `orientation` · string

For `mcq` with several `columns`: order the options `"vertical"`ly (the default) or `"horizontal"`ly.

#### possibility-list-position

Emits `possibility_list_position` · string

Where the pool of draggable responses sits: `"bottom"` (the default), `"top"`, `"left"` or `"right"`.

#### response-font-scale

Emits `response_font_scale` · string

For `clozeformula`: the response font relative to the question's — `"boosted"` (150%, the default) or `"normal"`.

#### row-count

Emits `row_count` · number

For `classification`: the number of rows (default 1), for a two-dimensional grid.

#### row-header

Emits `row_header` · string

For `classification`: the content of the table's top-left cell.

#### row-min-height

Emits `row_min_height` · string

For `classification`: the least height of a row in pixels (default `"60px"`).

#### row-titles

Emits `row_titles` · list of strings

For `classification`: row headings.

#### row-titles-width

Emits `row_titles_width` · string

For `classification`: the width of the row-title column in pixels, e.g. `"120px"` (default `"60px"`).

#### show-drag-handle

Emits `show_drag_handle` · boolean

Shows the indicator that responses are draggable. Learnosity's default is `true`.

#### stem-title

Emits `stem_title` · string

For `choicematrix`: the title of the prompt column.

#### stem-width

Emits `stem_width` · string

For `choicematrix`: the width of the prompt column in pixels, e.g. `"120px"`.

#### type

Emits `type` · string

The widget's display variant: for `mcq` `"horizontal"` (the default) or `"block"`; for `choicematrix` `"table"` or `"inline"`; for `orderlist` `"button"`, `"list"` or `"inline"`; for `clozeformula` the keypad — `"floating-keyboard"`, `"block-keyboard"`, `"block-on-focus-keyboard"` (the default) or `"no-input-ui"`. The question's own `type` is emitted by the compiler, never written.

#### validation-stem-numeration

Emits `validation_stem_numeration` · string

The numbering beside each validation label: `"number"` (the default), `"upper-alpha"` or `"lower-alpha"`.

### Response Container Members

Written inside `response-container [ ... ]` (every response box) or one entry of `response-containers [[ ... ] [ ... ]]` (one box each, in order).

#### aria-label

Emits `aria_label` · string

Custom aria-label text for the box, read by screen readers.

#### height

Emits `height` · string

The box height in pixels.

#### input-type

Emits `input_type` · string

The kind of input the box takes. Learnosity's default is `"text"`.

#### width

Emits `width` · string

The box width in pixels, e.g. `"150px"`.

#### wordwrap

Emits `wordwrap` · boolean

Whether a dragged response wraps inside its box or is cut off with an ellipsis. Learnosity's default is `false`.

### Option and Group Members

The members of the objects that make up a question's content: `mcq` options, `bowtie` response groups, and `clozeformula` hints.

#### assistive-label

Emits `assistive_label` · member list

An `mcq` option's alternate label for screen readers, with `label` (plain text) and `exposed-visible-label`.

#### content

Emits `content` · string

Inside a hint: the text displayed. HTML is allowed.

#### exposed-visible-label

Emits `exposed_visible_label` · boolean

Inside `assistive-label`: whether screen readers can navigate to the assistive label. By default it is hidden and the option's own label is read.

#### items-list

Emits `items` · list of member lists

Inside `hints`: the hints, in the order they are revealed, each `[content "..."]`. Emits `items`.

#### label

Emits `label` · string

An `mcq` option's displayed text, beside its `value`.

#### responses

Emits `responses` · list of strings

A `bowtie` response group's choices.

#### title

Emits `title` · string

A `bowtie` response group's heading, shown over its column below the diagram.

### Metadata Members

Written inside `metadata [ ... ]`. At question level they emit the question's `metadata` object. At item level the compiler routes each to where the Learnosity Author Site reads it, as noted per word.

#### acknowledgements

Emits `acknowledgements` · string

Question level. References for passages, documents or images the question uses.

#### description

Emits `description` · string

Item level. Emitted as the item's `description`.

#### difficulty-level

Emits `adaptive.difficulty` (item level) · integer

Item level. Emitted as `adaptive.difficulty`, the integer calibration behind the Author Site's Difficulty level. Distinct from a `Difficulty` tag such as `"medium"`.

#### distractor-rationale

Emits `distractor_rationale` · string

Question level. Why the distractors are wrong, as one note.

#### distractor-rationale-response-level

Emits `distractor_rationale_response_level` · list of strings

Question level. One rationale per option, in order — the field the Author Site shows beside each distractor. The Questions API does not display it to learners.

#### notes

Emits `note` (item level) · string

Item level. Emitted as the item's `note`, the Author Site's Notes field.

#### response-shuffle-seed

Emits `response_shuffle_seed` · string

Question level. A seed for shuffling the options: every learner sees the same shuffled order.

#### rubric-reference

Emits `rubric_reference` · string

Question level. The identifier of the rubric to mark with; defaults to the course rubric when the activity assigns one.

#### sample-answer

Emits `sample_answer` · string

Question level. A model answer, shown in the Reports API. HTML is allowed.

#### source

Emits `source` · string

Item level. Emitted as the item's `source`.

#### tags

Emits `tags` (item level) · record `{ Type: string | string[] }`

Item level. Faceted tags the Author Site filters on, e.g. `tags { NGSS: "MS-LS1-2", DOK: 2 }`. A bare string becomes a one-element list. Difficulty and DOK labels go here — Learnosity has no dedicated field for them.

### Block and Custom Members

Members of the `items` list and of the `custom` question type.

#### lang

Emits `lang` · string

For `custom`: the deployed Graffiticode language to embed, e.g. `"0179"`. Required. The compiler derives `custom_type` and the script URLs from it.

#### model

Emits `data` · record, string, or `data use "<lang>"`

For `custom`: the embedded interaction's content, emitted unchanged as the question's `data`. Write `model data use "0179"` to read an upstream pipeline task.

#### params

Emits `dynamic_content_data` · list of records

In the `items` list: the dynamic-content table, one record per row, e.g. `params [{ A1: "50" } { A1: "100" }]`. Each session draws a row and fills `{{A1}}`-style placeholders. An embedded L0179 question's own table takes precedence.

#### save-to-itembank

Emits — (the item-bank write) · the activity

Wraps the activity to persist it: `save-to-itembank items [...] {}`. Items land as `status: "unpublished"`. The write runs only in a compile that selects a connection; without one the result carries `itemBank: { skipped: "no-connection", ... }` and the preview still renders. See [items](#sec-items).
<!-- END attribute-reference -->

## Program Examples

Multiple choice assessment:

```
set-var "lrn-id" get-val-public "itemId"
items [
  item [
    questions [
      mcq [
        stimulus "What color means go?"
        options [
          [label "Red" value "0"]
          [label "Yellow" value "1"]
          [label "Green" value "2"]
        ]
        instant-feedback true
        validation [
          valid-response [score 1 value ["2"]]
        ]
      ]
    ] {}
  ]
] {}..
```

Multiple questions in one item:

```
set-var "lrn-id" get-val-public "itemId"
items [
  item [
    questions [
      mcq [
        stimulus "What is 2 + 2?"
        options [
          [label "3" value "0"]
          [label "4" value "1"]
          [label "5" value "2"]
        ]
        validation [
          valid-response [score 1 value ["1"]]
        ]
      ],
      shorttext [
        stimulus "Spell the word for the number 4."
        case-sensitive false
        validation [
          valid-response [score 1 value "four"]
        ]
      ]
    ] {}
  ]
] {}..
```

Question with all defaults (renders a mock MCQ):

```
set-var "lrn-id" get-val-public "itemId"
items [item [questions [mcq []] {}]] {}..
```

Multiple items:

```
set-var "lrn-id" get-val-public "itemId"
items [
  item [questions [mcq []] {}],
  item [questions [shorttext []] {}]
] {}..
```

Spreadsheet question reading an upstream L0179 task:

```
set-var "lrn-id" get-val-public "itemId"
items [
  item [
    questions [
      custom [
        lang "0179"
        stimulus "Use the spreadsheet to compute the column totals."
        model data use "0179"
      ]
    ] {}
  ]
] {}..
```
