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
| `init` | 1 | `<record: record>` | Initializes a Learnosity API session |
| `items` | 2 | `<list: list, continuation: record>` | Creates a Learnosity Items API request from a list of items |
| `item` | 1 | `<record: record>` | Defines a single item (for use in a list passed to `items`) |
| `questions` | 2 | `<list: list, continuation: record>` | Chainable attribute: sets the questions for an item |
| `author` | 1 | `<record: record>` | Creates a Learnosity Author API request |
| `hello` | 1 | `<string: string>` | Renders a hello message |

### Question Type Functions

Each question type function takes a record of attributes (built via chainable
attribute keywords) and produces a Learnosity question JSON object. Attributes
not provided are filled with sensible defaults, so `mcq []` produces a
complete renderable question.

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

### Attribute Keywords

An attribute keyword is named for the Learnosity field it emits, so the program
reads as a transcription of the question JSON.

Attribute keywords are arity-1 members. A question is a bracketed member list —
`mcq [ stimulus "..." options [...] ]` — and every object inside it is written the
same way, so the same keyword works at any depth. An array of objects is a list of
member lists. `{}` appears only on the arity-2 blocks (`items`, `questions`),
which take a continuation record.

| Keyword | Value Type | Learnosity Field | Used By |
| :------ | :--------- | :--------------- | :------ |
| `stimulus` | string | `stimulus` | All types |
| `options` | string[] | `options` | mcq, choicematrix |
| `valid-response` | varies | `validation.valid_response.value` | All scored types |
| `instant-feedback` | boolean | `instant_feedback` | All scorable types — needs a `valid-response` to check against |
| `is-math` | boolean | `is_math` | All types (enables MathJax for LaTeX) |
| `shuffle-options` | boolean | `shuffle_options` | mcq, choicematrix |
| `multiple-responses` | boolean | `multiple_responses` | mcq |
| `case-sensitive` | boolean | `case_sensitive` | shorttext, clozetext |
| `max-length` | number | `max_length` | shorttext |
| `placeholder` | string | `placeholder` | longtext, plaintext, shorttext |
| `possible-responses` | array | `possible_responses` | clozeassociation, clozedropdown, classification |
| `columns` | string[] | `options` | choicematrix |
| `list` | string[] | `list` | orderlist |
| `column-titles` | string[] | `ui_style.column_titles` + `possible_response_groups[].title` | bowtie |
| `template` | string | `template` | clozetext, clozeassociation, clozedropdown, clozeformula, token-highlight |
| `tokenization` | string | `tokenization` | token-highlight |
| `max-selection` | number | `max_selection` | token-highlight |
| `method` | string | `validation method` | clozeformula |
| `lang` | string | — (URL/`custom_type` synthesis) | custom |
| `model` | record or string | `data` (JSON-stringified) | custom |
| `metadata` | list | `metadata` / `tags` | item, all question types |
| `params` | record[] | `dynamic_content_data` | items list |
| `save-to-itembank` | activity | — (item-bank write) | wraps `items [...] {}` or `questions [...] {}` |

#### Scoring

Scored questions default to Learnosity's `exactMatch`: the learner must get every
response right to earn the point. `scoring-type`, inside `validation`, chooses
otherwise.

```
mcq [
  stimulus "Select all the prime numbers."
  options [
    [label [label "2" value "2"] [label "4" value "4"] [label "7" value "7"] value "0"]
  ]
  multiple-responses true
  validation [
    scoring-type "partialMatch"
  ]
  validation [
    valid-response [score 1 value ["score 1 value ["2", "7""]]
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

#### Metadata Member Constructors

The `metadata` keyword takes a list whose members are arity-1 constructor
calls. Each member tags its payload with a `kind`, so the compiler can route
faceted fields to `tags` and free-form fields to `metadata` in the Learnosity
output.

| Keyword | Value Type | Level | Notes |
| :------ | :--------- | :---- | :---- |
| `tags` | record `{ Type: string \| string[] }` | item | Each record value is a string or array of strings. Bare strings are normalized to a single-element array. Faceted-only conventions like `Difficulty` and `DOK` are written here directly (e.g. `tags { Difficulty: "medium", DOK: 2 }`) — there are no dedicated Learnosity fields for them. |
| `notes` | string | item | Free-form author note emitted as the item's top-level `note` field, which backs the Notes field on the Author Site item details page. |
| `description` | string | item | Emitted as the item's top-level `description` field (Author Site item details page Description). |
| `source` | string | item | Emitted as the item's top-level `source` field (Author Site item details page Source). |
| `difficulty-level` | integer | item | Emitted as `adaptive.difficulty` — the integer Rasch calibration backing the Author Site item details page Difficulty level spinner. Distinct from the `difficulty` tag (which is a text label like "medium"). |
| `distractor-rationale` | string | question | Emitted as `metadata.distractor_rationale`, unchanged. |
| `distractor-rationale-response-level` | string[] | question | Emitted as `metadata.distractor_rationale_response_level` — one rationale per response, which is the field Learnosity documents for per-option intent. |
| `rubric-reference` | string | question | Identifier of the rubric to use. |
| `sample-answer` | string | question | Shown in Reports API. |
| `response-shuffle-seed` | string | question | mcq only; fixes the shuffled option order across learners. |
| `acknowledgements` | string | question | Attribution. |

<!-- BEGIN attribute-reference -->
### Attribute reference

Every attribute the compiler accepts, the Learnosity field it emits, and the
question types that take it. Generated from the registries in
`question-types.ts` — if a word is missing here it is missing from the
language, not from the documentation.

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

**Rule options.** These sit inside a `validation` rule's `options`, not on the
question, and are the only words in the language that emit camelCase.

| keyword | Learnosity key |
|---|---|
| `allow-decimal` | `allowDecimal` |
| `allow-thousands-separator` | `allowThousandsSeparator` |
| `compare-sides` | `compareSides` |
| `decimal-places` | `decimalPlaces` |
| `ignore-leading-and-trailing-spaces-rule` | `ignoreLeadingAndTrailingSpaces` |
| `ignore-order` | `ignoreOrder` |
| `ignore-text` | `ignoreText` |
| `inverse-result` | `inverseResult` |
| `set-decimal-separator` | `setDecimalSeparator` |
| `set-thousands-separator` | `setThousandsSeparator` |
| `syntax` | `syntax` |
| `treat-letters-as-variables` | `treatLettersAsVariables` |
| `treat-multiple-spaces-as-one` | `treatMultipleSpacesAsOne` |

**Nested members.** These belong inside another member — `validation`,
`ui-style`, `response-container`, `metadata` — rather than on the question
itself.

| keyword | Learnosity field |
|---|---|
| `accent-penalty-points` | `accent_penalty_points` |
| `accent-sensitivity` | `accent_sensitivity` |
| `acknowledgements` | `acknowledgements` |
| `allow-negative-scores` | `allow_negative_scores` |
| `alt-responses` | `alt_responses` |
| `aria-label` | `aria_label` |
| `assistive-label` | `assistive_label` |
| `automarkable` | `automarkable` |
| `choice-label` | `choice_label` |
| `column-count` | `column_count` |
| `column-titles` | `column_titles` |
| `columns` | `columns` |
| `content` | `content` |
| `model` | `data` |
| `description` | `description` |
| `difficulty-level` | `difficulty_level` |
| `distractor-rationale` | `distractor_rationale` |
| `distractor-rationale-response-level` | `distractor_rationale_response_level` |
| `enable-fullwidth-scoring` | `enable_fullwidth_scoring` |
| `enabled` | `enabled` |
| `exposed-visible-label` | `exposed_visible_label` |
| `feedbackaide-passages` | `feedbackaide_passages` |
| `fontsize` | `fontsize` |
| `height` | `height` |
| `horizontal-lines` | `horizontal_lines` |
| `input-type` | `input_type` |
| `items-list` | `items` |
| `keyboard-below-response-area` | `keyboard_below_response_area` |
| `label` | `label` |
| `lang` | `lang` |
| `matching-rule` | `matching_rule` |
| `max-height` | `max_height` |
| `max-score` | `max_score` |
| `method` | `method` |
| `min-height` | `min_height` |
| `min-score-if-attempted` | `min_score_if_attempted` |
| `min-width` | `min_width` |
| `notes` | `notes` |
| `option-row-title` | `option_row_title` |
| `option-width` | `option_width` |
| `orientation` | `orientation` |
| `params` | `params` |
| `penalty` | `penalty` |
| `possibility-list-position` | `possibility_list_position` |
| `response-font-scale` | `response_font_scale` |
| `response-shuffle-seed` | `response_shuffle_seed` |
| `responses` | `responses` |
| `row-count` | `row_count` |
| `row-header` | `row_header` |
| `row-min-height` | `row_min_height` |
| `row-titles` | `row_titles` |
| `row-titles-width` | `row_titles_width` |
| `rubric-reference` | `rubric_reference` |
| `sample-answer` | `sample_answer` |
| `score` | `score` |
| `score-with-feedbackaide` | `score_with_feedbackaide` |
| `scoring-type` | `scoring_type` |
| `show-drag-handle` | `show_drag_handle` |
| `source` | `source` |
| `stem-title` | `stem_title` |
| `stem-width` | `stem_width` |
| `tags` | `tags` |
| `title` | `title` |
| `type` | `type` |
| `unscored` | `unscored` |
| `valid-response` | `valid_response` |
| `validation-stem-numeration` | `validation_stem_numeration` |
| `value` | `value` |
| `width` | `width` |
| `wordwrap` | `wordwrap` |
<!-- END attribute-reference -->

## Function Reference

### init

Initializes a Learnosity API session for items, questions, or author mode
based on the `type` field in the given record.

```
init { "type": "items" }
```

### items

Builds one Learnosity item record per `item` entry and renders their questions.

The list holds two kinds of thing: `item` entries, and members that belong to
the program as a whole — `params`. The trailing record is
program metadata and travels onto the compiled output.

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
]
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
activity, the preview still renders, and it is not an error. Programs may set
`set-var "learnosity-key" ...` and `set-var "learnosity-secret" ...` before
`items` (both or neither; only one is an error) to sign the preview with their
own account; when absent, previews use the server's default credentials.
These credentials never write and never sign an Author session.

```
set-var "lrn-id" "mitochondria-mcq"
set-var "learnosity-key" get-val-public "learnosityKey"
set-var "learnosity-secret" get-val-private "learnositySecret"
save-to-itembank items [
  item [questions [mcq [ ... ]] {}]
] {}
```

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

Chainable arity-2 attribute that sets the questions for an item. Takes a
list of question objects and a continuation.

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

```
author { "mode": "item_edit" }
```

### hello

Renders a hello message that includes the given string.

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
  ]
  validation [
    valid-response [score 1 value [score 1 value "H2O"]]
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
  ]
  validation [
    valid-response [score 1 value [score 1 value ["cat", "mat"]]]
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
    alt-responses [[score 1 value ["Paree"]]]
  ]
  validation [
    valid-response [score 1 value [score 1 value ["Paris"]]]
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
  ]
  validation [
    valid-response [score 1 value [score 1 value ["Paris"]]]
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
  ]
  validation [
    valid-response [score 1 value [score 1 value ["blue"]]]
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
      score 1
      value [ [[method "equivLiteral" value "70"]]
              [[method "equivValue" value "1" options [decimal-places 2]]]
              [[method "equivLiteral" value "10"]] ]
    ]
  ]
  validation [
    valid-response [score 1 value []
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
    alt-responses [[value [[[method "equivLiteral" value "0.5"]]]]
                   [value [[[method "equivLiteral" value "2/4"]]]]]
  ]
  validation [
    valid-response [score 1 value [value [[[method "equivLiteral" value "1/2"]]]]]
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
  ]
  validation [
    valid-response [score 1 value [score 1 value [[0], [1]]]]
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
  ]
  validation [
    valid-response [score 1 value [score 1 value [1, 0, 2, 3]]]
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
  ]
  validation [
    valid-response [score 1 value [score 1 value [[0, 2], [1, 3]]]]
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
  ]
  validation [
    valid-response [score 1 value [score 1 value [[0, 3], [4], [7, 9]]]]
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
  ]
  validation [
    valid-response [score 1 value [score 1 value [1, 2]]]
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

The continuation record passes through onto the emitted question object
as peers of `type` and `response_id`. The
`data` field — Learnosity's per-question payload string — is special-
cased: a record value is JSON-stringified for the SDK; a string passes
through as-is.

The `data` field is most cleanly set with the chained `model` attribute
(arity 2), which folds its value into the continuation's `data:`. The
record-literal form (`{ data: ... }` in the terminator) also works; if
both are present the chained `model` wins.

The exact shape of the model is determined by the deployed interaction
at `l<lang>.graffiticode.org` — consult that integration's docs for the
fields it expects.

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
  "data": "<JSON-stringified interaction data>"
}
```

#### Pipeline composition

When an L0176 program is wired downstream of another Graffiticode task in
the console pipeline, the upstream task's compiled output is read via the
base-language `data` primitive and threaded into the `custom` question's
`data:` field via the `model` attribute. There are two equivalent forms:

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
