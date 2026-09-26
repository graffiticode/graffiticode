<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Dialect L0176 Specific Instructions

L0176 is a Graffiticode dialect for building Learnosity assessment integrations.
It compiles programs into Learnosity API requests (Items, Questions, Author APIs)
and renders them via a React frontend.

## L0176 Specific Guidelines

- **CRITICAL**: The first line of every program MUST be exactly `set-var "lrn-id" get-val-public "itemId"`. This captures the caller-supplied item ID. NEVER use `set-var "lrn-id" ""` or any other value — the program will fail if `lrn-id` is empty. Copy this line verbatim from the template; do not simplify or omit `get-val-public "itemId"`. Write the call, never a literal id: the item ID does not exist until the item does, so the platform substitutes the real value at parse time. A hard-coded id would pin every item you generate to one Learnosity reference.
- **CRITICAL**: `..` terminates a top-level definition or the program's final expression — a program with `let` definitions has one per definition plus one at the end. It must NEVER terminate the preamble. `set-var "lrn-id" get-val-public "itemId"` is the head of the program expression, not a standalone statement, so `set-var "lrn-id" get-val-public "itemId"..` is a complete program that compiles and renders nothing. The preamble runs straight into the `items` expression with no terminator between them.
- Use `items` to create Items API requests for rendering assessments
- Use `item` to define individual items when building a list for `items`
- Use `questions` as a chainable attribute to set questions on an item
- Use `author` to create Author API requests for item authoring
- Use `init` to initialize a Learnosity API session by type
- Use `hello` to display simple text output: `hello "Hello, world!"..`
- `items` always takes a list of `item` objects: `items [item [questions [...] {}]]..`
- When an assessment has multiple questions, place all questions in the same `item` rather than creating separate items: `items [item [questions [mcq [], shorttext []] {}]]..`

### Question Type Functions

Instead of writing raw Learnosity JSON, use the question type functions which
provide a higher-level interface with sensible defaults:

- `mcq` — Multiple choice; options are `{label, value}` objects
- `shorttext` — Short typed responses
- `longtext` — Rich text essays, manually scored
- `plaintext` — Plain text essays, manually scored
- `clozetext` — Fill-in-the-blank with typed responses
- `clozeassociation` — Fill-in-the-blank with drag and drop
- `clozedropdown` — Fill-in-the-blank with dropdown select
- `clozeformula` — Fill-in-the-blank with math/formula input
- `choicematrix` — Grid of prompts (`stems`) by choices (`options`)
- `orderlist` — Drag items into correct order
- `classification` — Drag items into a grid; layout lives in `ui-style`
- `bowtie` — NGN/NCLEX bow-tie: source pools feeding a bow-tie diagram
- `token-highlight` — Click tokens in a passage; `template` carries the `lrn_token` spans
- `custom` — Embed a separately deployed Graffiticode-language interaction (e.g. an L0179 spreadsheet). Set the interaction payload with the chained `model` attribute (preferred); see Pipeline Composition

Each function takes a record built from chainable attribute keywords.
All attributes have defaults, so `mcq []` produces a complete question.

### Question Type Templates

- `mcq` — Multiple choice. Options are `{label, value}` objects: the label is
  shown, the value is what a response records. `valid-response` lists the values
  of the correct options:
  ```
  mcq [
    stimulus "What is 2 + 2?"
    options [
      [label [label "3" value "0" value "0"]
    ]
      [label "4" value "1"]
      [label "5" value "2"]
    ]
    validation [
    ]
    validation [
      valid-response [score 1 value ["score 1 value ["1""]]
    ]
  ]
  ```
  `multiple-responses true` turns the radio buttons into checkboxes;
  `min-selection` and `max-selection` then bound how many may be picked.

- `shorttext` — Short typed response. `valid-response`'s
  `value` is a bare string here, not a list — the type has one response box:
  ```
  shorttext [
    stimulus "What is the capital of France?"
    validation [
    ]
    validation [
      valid-response [score 1 value [score 1 value "Paris"]]
    ]
  ]
  ```

- `longtext` — Rich text essay (manually scored). Emits
  Learnosity's `longtextV2`; `max-length` counts words:
  ```
  longtext [
    stimulus "Explain the water cycle."
    max-length 500
    placeholder "Start writing here..."
  ]
  ```

- `plaintext` — Plain text essay (manually scored):
  ```
  plaintext [
    stimulus "Describe your favorite book."
    max-length 300
    placeholder "Start writing here..."
  ]
  ```

- `clozetext` — Fill-in-the-blank with typed responses. `stimulus` is the prompt, `template` is the passage
  carrying the `{{response}}` blanks, and scoring sits inside `validation`:
  ```
  clozetext [
    stimulus "Complete the sentence."
    template "The {{response}} is the powerhouse of the cell."
    validation [
      valid-response [score 1 value ["mitochondria"]]
    ]
  ]
  ```
  One `valid-response` entry per `{{response}}` blank, in order. Do not list
  multiple accepted answers for one blank — each alternate is a complete answer
  set under `alt-responses`. `max-length` defaults to **15 characters per blank**,
  so raise it for longer answers.

- `clozeassociation` — Fill-in-the-blank with drag and drop. `stimulus` is the prompt, `template` the passage carrying the
  blanks, and `possible-responses` (not `options`) the draggable choices:
  ```
  clozeassociation [
    stimulus "Drag each word into place."
    template "The {{response}} sat on the mat."
    possible-responses ["cat", "dog", "hat"]
    validation [
    ]
    validation [
      valid-response [score 1 value [score 1 value ["cat"]]]
    ]
  ]
  ```

- `clozedropdown` — Fill-in-the-blank with drop-down select. One list of choices per drop-down, in order of appearance:
  ```
  clozedropdown [
    stimulus "Select the correct answer."
    template "The sky is {{response}}."
    possible-responses [["blue", "red", "green"]]
    validation [
    ]
    validation [
      valid-response [score 1 value [score 1 value ["blue"]]]
    ]
  ]
  ```

- `clozeformula` — Math input. Emits `clozeformulaV2` (Learnosity's "Math").
  `validation.valid_response.value` is an array per blank of arrays of rule
  objects, each with a `method`, usually a `value`, and optionally `options`
  (whose keys are camelCase — `decimal-places` emits `decimalPlaces`):
  ```
  clozeformula [
    template "{{response}} minutes = {{response}} hour"
    is-math true
    validation [
        score 1
        value [ [[method "equivLiteral" value "60"]]
                [[method "equivValue" value "1" options [decimal-places 2]]] ]
      ]
    ]
    validation [
      valid-response [score 1 value []
    ]
  ]
  ```
  A rule may carry a `method` and no `value`: `isExpanded`, `isSimplified` and
  `isTrue` are predicates on the response. To accept several different
  expressions for one blank, use `alt-responses` — each entry is a complete
  answer set covering every blank. Notation never needs enumerating: `1/2`,
  `1 / 2` and `\frac{1}{2}` are one expression under every method.
- `choicematrix` — Grid of prompts and choices. Learnosity's names: `stems` are the row prompts, `options` the column choices.
  `multiple-responses true` turns each row's radio buttons into checkboxes:
  ```
  choicematrix [
    stimulus "Select the correct answer for each row."
    stems ["Statement 1", "Statement 2"]
    options ["True", "False"]
    validation [
    ]
    validation [
      valid-response [score 1 value [score 1 value [[0], [1]]]]
    ]
  ]
  ```

- `orderlist` — Drag items into correct order. Alone in
  reaching `partialMatchPairwise`, which compares adjacent entries rather than
  scoring each position outright:
  ```
  orderlist [
    stimulus "Arrange in order."
    list ["First", "Second", "Third", "Fourth"]
    validation [
    ]
    validation [
      valid-response [score 1 value [score 1 value [0, 1, 2, 3]]]
    ]
  ]
  ```

- `classification` — Drag items into a grid. The layout lives in `ui-style`:
  `column-count` and `column-titles`, plus `row-count` and `row-titles` for a
  two-dimensional grid. `valid-response`'s value is one array of
  `possible-responses` indices per cell, in reading order:
  ```
  classification [
    stimulus "Sort the animals."
    possible-responses ["Dog", "Snake", "Cat", "Lizard"]
    ui-style [column-count 2 column-titles ["Mammals", "Reptiles"]]
    validation [
    ]
    validation [
      valid-response [score 1 value [score 1 value [[0, 2], [1, 3]]]]
    ]
  ]
  ```
- `bowtie` — NGN/NCLEX bow-tie. `possible-response-groups` gives each source
  pool a `title` and its `responses`; `ui-style` carries the `column-titles`
  above the drop zones. `valid-response`'s value is one array of indices per drop
  zone, indexing into the groups flattened in order:
  ```
  bowtie [
    stimulus "65-year-old with chest pain and diaphoresis."
    group-possible-responses true
    possible-response-groups [
      [title "Actions to Take" responses ["give aspirin", "give nitro"]]
      [title "Condition" responses ["myocardial infarction", "pericarditis"]]
      [title "Parameters" responses ["ST changes", "troponin"]]
    ]
    ui-style [column-titles ["Actions to Take", "Condition", "Parameters"]]
    validation [
    ]
    validation [
      valid-response [score 1 value [score 1 value [[0], [2], [4, 5]]]]
    ]
  ]
  ```
  Nothing validates those indices, and Learnosity's own worked example does not
  decode — render one before trusting it.
- `token-highlight` — Click tokens in a passage. `template` is the passage with
  each clickable token wrapped in `<span class="lrn_token">`, and
  `valid-response`'s value is the indices of the correct spans in document order,
  from zero. `max-selection` caps how many the learner may pick:
  ```
  token-highlight [
    stimulus "Highlight the verbs."
    template "The <span class=\"lrn_token\">cat</span> <span class=\"lrn_token\">runs</span>."
    tokenization "custom"
    validation [
    ]
    validation [
      valid-response [score 1 value [score 1 value [1]]]
    ]
  ]
  ```
  `tokenization` may instead be `"word"`, `"sentence"` or `"paragraph"`, in which
  case Learnosity splits the passage and the template needs no spans.
- `custom` — Embed a separately deployed Graffiticode-language interaction.
  `lang` is required and identifies the deployed interaction (the compiler
  synthesizes URLs and `custom_type` from `https://l<lang>.graffiticode.org/...`).
  Set the interaction payload with the chained `model` attribute — `model`
  is JSON-stringified for Learnosity (records → string, strings → passthrough).
  Scoring is the deployed interaction's own concern — do not add
  `valid-response`. When the item draws content from an upstream pipeline
  node, read it with `data use "<lang>"` (preferred) or `data {default}`
  and pass to `model` (see Pipeline Composition):
  ```
  custom [
    lang "0179"
    stimulus "Use the spreadsheet to compute the column totals."
    model data use "0179"
  ]
  ```

### Math Notation

Wrap mathematical notation in the LaTeX inline-math delimiters `\\(` and `\\)`
so Learnosity typesets it with MathJax. Apply this to math wherever it is
displayed — `clozeformula` stems, math MCQ stimuli and options, and any other
text that contains an expression.

**LaTeX is the only accepted encoding for math.** Not MathML — Learnosity's
question fields are HTML and MathJax is configured for LaTeX, so a `<math>`
element is not typeset. And not Unicode math characters: writing `3 × 4`,
`x ≤ 5` or `√2` as literal characters gives text that is not typeset, does not
size or align with surrounding math, and cannot be scored as an expression.
Write `\\(3 \\times 4\\)`, `\\(x \\le 5\\)`, `\\(\\sqrt{2}\\)`. The compiler rejects
MathML and Unicode math in a stimulus or template.

Backslashes are escaped inside DSL string literals, so write every backslash
doubled: `\\(` and `\\)` for the delimiters, and `\\times`, `\\frac`, `\\sqrt`,
etc. for LaTeX commands. The compiler unescapes each `\\` to a single `\`, so
the string Learnosity receives is `\(3 \times 4\)`, which MathJax then renders.

**A single backslash silently corrupts the command.** The string literal
interprets `\t`, `\n` and `\r`, so a lone backslash before a LaTeX command
starting with `t`, `n` or `r` is eaten and replaced by whitespace: `"\times"`
becomes a tab followed by `imes`, `"\neq"` a newline followed by `eq`,
`"\rightarrow"` a carriage return followed by `ightarrow`. Nothing reports it —
the question compiles, signs and renders, with the math quietly broken. Other
commands (`\frac`, `\sqrt`, `\alpha`) survive a single backslash by luck,
which is exactly why the habit is dangerous: it works until the day the
expression needs `\times`. Always double.

Keep response areas outside the delimiters. A cloze `{{response}}` blank is an
answer-entry slot, not notation to typeset, so leave it unwrapped and wrap the
surrounding expression instead. Dynamic-data `{{col}}` placeholders that stand
in for values within an expression belong inside the delimiters with the rest
of the math.

Whenever a question contains LaTeX, put `is-math true` in that question's member
list so Learnosity loads MathJax and renders the `\\( … \\)` expressions. It is a
boolean member valid on every built-in question type (`clozeformula` sets it
automatically). Example:

```
mcq [
  stimulus "Which product equals \\(3 \\times 4\\)?"
  options [
    [label "\\(10\\)" value "0"]
    [label "\\(12\\)" value "1"]
    [label "\\(14\\)" value "2"]
  ]
  is-math true
  validation [
    valid-response [score 1 value ["1"]]
  ]
]
```

```
clozeformula [
  stimulus "Solve for \\(x\\)."
  template "\\(x + 3 = 7\\). \\(x =\\) {{response}}"
  is-math true
  validation [
    valid-response [score 1 value [[[method "equivLiteral" value "4"]]]]
  ]
]
```

**The formula goes in the `template`, not the `stimulus`.** This is the mistake
worth naming, because the result still compiles and still renders — it just
renders wrong. `template` is the line the learner fills in, and each
`{{response}}` in it becomes a blank *at that position*. `stimulus` is the prompt
above it, and a `{{response}}` there is inert text — the stimulus is not scanned
for blanks.

Putting the equation in the stimulus and leaving `template "{{response}}"` gives
you the whole question as a prompt with an unlabelled box stranded underneath:

```
stimulus "Solve: \\(x + 3 = 7\\). \\(x =\\)"   ← renders as a prompt
template "{{response}}"                          ← renders as a bare box below it
```

Write the prompt in the stimulus and the equation the learner completes in the
template, so the blank sits where the answer goes:

```
stimulus "Solve for \\(x\\)."
template "\\(x + 3 = 7\\). \\(x =\\) {{response}}"
```

The same rule holds for every cloze type — `clozetext`, `clozedropdown`,
`clozeassociation` and `clozeformula` all place their blanks from the template.

The compiler rejects a cloze `stimulus` that ends mid-expression — trailing off
on `=`, `+`, `\(\lt\)` and the like — because a stimulus is a complete prompt
and is never continued by the blank. It also rejects a `{{response}}` written in
a stimulus, and a `template` with no `{{response}}` at all.

### Scoring math responses (`method`)

The response a learner types is parsed as a **math expression**, never compared as
a string. Each rule object inside `valid-response`'s `value` carries a `method`
deciding which property of that expression is compared. The choice is not
cosmetic — it decides which responses are marked correct, and the wrong choice
silently rejects answers that should score.

- **`equivLiteral`** — compares the expression *syntactically*. Notation and
  whitespace are free: against `"1/2"` a learner typing `1 / 2` or
  `\(\frac{1}{2}\)` is correct, because those are one expression written three
  ways. A *different* expression is not: `0.5` and `2/4` each fail against
  `"1/2"`. **Every expression you intend to accept must be listed** — but its
  notational variants need not be.
- **`equivSymbolic`** — accepts any expression symbolically equivalent to a listed
  one, so equivalent forms need not be enumerated.
- **`equivValue`** — accepts any expression with the same math value as a listed
  one. `options [decimal-places 2]` bounds how far that comparison looks.
- **`isSimplified`**, **`isExpanded`**, **`isFactorised`**, **`isTrue`** —
  these are predicates on the response rather than comparisons against an
  answer, so a rule using one carries no `value` at all:
  `value [[[method "isExpanded"]]]`.
- **`isUnit`** — a predicate that *does* take a `value`, naming the unit:
  `[method "isUnit" value "cm"]` accepts `5 cm`. Without a `value` it scores
  every response 0.
- **`equivSyntax`** — checks the *form* of the response rather than comparing it
  to an answer, so it carries no `value`. The form goes in `options` as
  `syntax`, one of nine rules, each written as a LaTeX-style command:

  | rule | accepts | argument |
  |---|---|---|
  | `\\number` | any integer or floating point | decimal places |
  | `\\integer` | any integer | significant figures |
  | `\\decimal` | any decimal | decimal places |
  | `\\scientific` | any number in scientific notation | decimal places |
  | `\\variable` | any single variable | — |
  | `\\fraction` | any fraction, simple or mixed | — |
  | `\\simpleFraction` | a simple fraction only | — |
  | `\\mixedFraction` | a mixed fraction only | — |
  | `\\fractionOrDecimal` | a fraction or a decimal | — |

  An argument is appended to the rule: `"\\decimal3"` accepts `1.234` and
  rejects `1.2`. `ignore-text` discards LaTeX `\\text{...}` the learner types
  alongside the answer, so `1.23\\text{ cm}` still counts as a decimal.

  ```
  clozeformula [
    stimulus "Give the mass of the Sun in scientific notation."
    template "{{response}} kg"
    validation [
      valid-response [score 1 value
        [[[method "equivSyntax" options [syntax "\\scientific" ignore-text true]]]]]
    ]
  ]
  ```

  Being purely syntactic, it is unaffected by the value of the response —
  `\\scientific` accepts any number written that way, right or wrong. Learnosity
  therefore documents it as a **supporting** method: pair it with `equivValue` or
  `equivSymbolic` as a second rule when the answer must be both correct and
  written in a particular form.
- **`stringMatch`** — the one method that is *not* a math comparison. It compares
  literal characters, so notation is no longer free: against `"1/2"` a learner
  typing `1 / 2` is **wrong**, where under `equivLiteral` it is right. Reach for
  it only when the exact characters are the thing being assessed.

**Rule: if the request names the expressions to accept, enumerate every one of
them.** A request that says "1/2, 0.5, and 2/4 are all accepted" states three
accepted expressions. Under `equivLiteral`, listing only `"1/2"` marks the other
two wrong — the item compiles, renders, and scores real learners incorrectly, and
nothing in the toolchain will warn you.

`valid-response` is one complete answer set, one rule array per `{{response}}`
blank. To accept several *different* expressions for a blank, write each
alternative as its own `alt-responses` entry — a whole answer set covering every
blank:

```
clozeformula [
  stimulus "Simplify to lowest terms."
  template "\\(\\frac{4}{8}\\) = {{response}}"
  validation [
    valid-response [score 1 value [[[method "equivLiteral" value "1/2"]]]]
    alt-responses [[value [[[method "equivLiteral" value "0.5"]]]]
                   [value [[[method "equivLiteral" value "2/4"]]]]]
  ]
]
```

**An equivalence method accepts the whole equivalence class, and you cannot
shrink it.** `equivSymbolic` on `"1/2"` accepts `0.5`, `2/4`, `4/8`, `8/16`,
`16/32`, … — every equal form, without limit. So a request that lists which
expressions count — "1/2, 0.5, and 2/4 are accepted, 4/8 is not" — is describing
an explicit set, not a mathematical class. `2/4` is in and `4/8` is out; no
equivalence rule produces that split. Use `equivLiteral` and list the accepted
expressions as alternates.

Reach for `equivSymbolic` / `equivValue` only when the request genuinely means
*any* equivalent response — "accept any correct form", "however they write it" —
where the learner is not being assessed on the form of the answer.

Choose by what the request specifies:

| the request says | method | why |
|---|---|---|
| these expressions are accepted | `equivLiteral` + every one as an alternate | the accepted set is a list, not a class |
| any equivalent form | `equivSymbolic` / `equivValue` | the class *is* the accepted set |
| it must be simplified | `isSimplified` | the form of the answer is the skill |
| it must be expanded / factorised | `isExpanded` / `isFactorised` | likewise, and neither takes a `value` |

**The full method set is ten**, one Author Guide article each — the "Legacy
Scoring Articles" the question-type pages defer to: `equivLiteral`,
`equivSymbolic`, `equivValue`, `equivSyntax`, `stringMatch`, `isSimplified`,
`isFactorised`, `isExpanded`, `isUnit` and `isTrue`.

The math engine's runtime error names six more — `validSyntax`, `simplify`,
`expand`, `variables`, `format`, `calculate`. That message lists the math API's
methods, which mix scoring with engine actions; none of the six documents a way
to score a question. A method outside the ten is **rejected by Learnosity at
render time and scores every response 0** — the item still renders, so the
failure looks like a learner getting it wrong. The compiler rejects them for
that reason.

`options` behaves the opposite way: an unrecognised key is accepted in silence,
with no error and no effect. Nothing downstream will tell you a key was
misspelled. See C1 and C2 in `conflict-resolution.md` for the measurements.

**Rule options**, with the method each is documented for:

| option | documented for | effect |
|---|---|---|
| `decimal-places` | `equivSymbolic`, `equivValue` | significant decimal places used for the comparison; default and maximum 10 |
| `ignore-text` | `equivSymbolic`, `equivValue`, `equivSyntax` | discards LaTeX `\\text{...}` in the response |
| `compare-sides` | `equivSymbolic`, `equivValue` | scores an equation when its two sides are equal, rather than matching the whole expression |
| `allow-decimal` | `equivLiteral`, `equivSymbolic`, `equivValue`, `isSimplified` | permits separators; the actual characters come from `set-decimal-separator` and `set-thousands-separator`, which must differ |
| `treat-letters-as-variables` | `equivSymbolic` | every letter is a variable rather than a unit or constant |
| `allow-thousands-separator` | `isExpanded`, `isFactorised`, `isTrue`, `isUnit` | permits a thousands separator in the response |
| `inverse-result` | `equivLiteral` | scores the *complement* — a matching response is marked wrong |
| `ignore-leading-and-trailing-spaces-rule`, `treat-multiple-spaces-as-one` | `stringMatch` | whitespace handling for the character comparison |
| `syntax` | `equivSyntax` | the form rule, as above |

**Tolerance is not an option.** `equivValue` takes it in the `value` itself with
a plus-minus: `value "10±1.5"` accepts anything from 8.5 to 11.5. It works only
with `equivValue`.

### Metadata

L0176 supports a `metadata` block at two levels: on `item` (for fields the
Learnosity Author Site indexes for search) and on each question constructor
(for fields that travel with the interaction). Both are optional and can
appear independently — items without metadata work exactly as before.

`metadata` takes a list whose members are arity-1 constructor calls
(`tags`, `notes`, `acknowledgements`, `distractor-rationale`,
`description`, `source`, `difficulty-level`). Each member tags its
payload with a kind so the compiler can route faceted fields to `tags`
and free-form fields to `metadata` in the Learnosity output.

#### Item-level metadata

Place a `metadata` block alongside `questions` inside an `item` chain. These
list members are recognized:

- `tags` — record mapping tag type to value, where each value is a string
  or an array of strings (a bare string is normalized to a single-element
  array). Faceted conventions like `Difficulty` and `DOK` go here (e.g.
  `tags { Difficulty: "medium", DOK: 2 }`) because Learnosity has no
  dedicated fields for them. Example:
  `tags { NGSS: "MS-LS1-2", "Common Core": ["Math:6.NS.A.1"] }`.
- `notes` — author-facing note attached to the item. Emitted as the
  item's top-level `note` field (what the Author Site item details
  page's Notes field reads from).
- `description` — short item description. Emitted as the item's
  top-level `description` field (Description field on the item details
  page).
- `source` — source/attribution string. Emitted as the item's top-level
  `source` field (Source field on the item details page).
- `difficulty-level` — integer Rasch calibration for adaptive sessions.
  Emitted as `adaptive.difficulty`, backing the Difficulty level spinner
  on the item details page. Distinct from the faceted `Difficulty` tag,
  which is a text label (e.g. `"medium"`) used for filtering.
- `acknowledgements` — attribution string. Emitted as
  `metadata.acknowledgements`.

```
items [
  item [
    metadata [
      tags { NGSS: "MS-LS1-2", Difficulty: "medium", DOK: 2, topic: "cellular-respiration" }
      notes "Variant A of the organelle misconception set"
    ]
    questions [
      mcq [
        stimulus "What is the primary function of the mitochondria?"
        options [
          [label "To produce energy (ATP) through cellular respiration"
          "To control what enters and exits the cell"
          "To build proteins using genetic instructions"
          "To store and protect the cell's DNA" value "0"]
        ]
        validation [
          valid-response [score 1 value ["0"]]
        ]
      ]
    ] {}
  ]
] {}..
```

#### Question-level metadata

Place a `metadata` block inside any question constructor's chain, alongside
`stimulus`, `options`, etc. These list members are recognized:

- `distractor-rationale` — a single string, emitted unchanged.
- `distractor-rationale-response-level` — a list of strings, one per response.
  This is the field Learnosity documents for per-option intent; use it rather
  than packing a list into `distractor-rationale`.
- `rubric-reference` — identifier of the rubric to use with this question.
- `sample-answer` — shown in reporting via the Reports API.
- `response-shuffle-seed` — `mcq` only; fixes the shuffled option order so every
  learner sees the same one.
- `acknowledgements` — attribution string.

```
mcq [
  stimulus "What is the primary function of the mitochondria?"
  options [
    [label "To produce energy (ATP) through cellular respiration"
    "To control what enters and exits the cell"
    "To build proteins using genetic instructions"
    "To store and protect the cell's DNA" value "0"]
  ]
  metadata [
    distractor-rationale [
      "Correct — ATP production via cellular respiration."
      "That's the role of the cell membrane."
      "That's the role of ribosomes."
      "That's the role of the nucleus."
    ]
    notes "Targets the three most common organelle confusions."
  ]
  validation [
    valid-response [score 1 value ["0"]]
  ]
]
```

#### Both levels in one item

```
items [
  item [
    metadata [
      tags { NGSS: "MS-LS1-2", Difficulty: "medium", DOK: 2 }
    ]
    questions [
      mcq [
        stimulus "..."
        options [
          [label ... value "0"]
        ]
        metadata [
          distractor-rationale ["..." "..." "..." "..."]
        ]
        validation [
          valid-response [score 1 value ["0"]]
        ]
      ]
    ] {}
  ]
] {}..
```

#### Conventions

- **Tag values** are plain strings. When one tag type has multiple values,
  pass an array (e.g., `tags { NGSS: ["MS-LS1-2", "MS-LS1-6"] }`); for a
  single value, a bare string is accepted for readability.
- **Distractor-rationale list length** should match the number of options.
- **Use item-level `tags` for faceted fields** (standards, Difficulty,
  DOK, subject, etc.) — these drive Author Site search and filtering.
- **Use question-level metadata for per-interaction fields**
  (`distractor-rationale`, `acknowledgements`, question `notes`). These
  travel with the question if it is reused in a different item.

### Member lists

A question is a **member list**: a bracketed sequence of attributes, each applied
to its value. There is no `{}` inside a question — the terminator survives only on
the blocks (`items`, `questions`), which are arity-2 and take a continuation.

```
mcq [
  stimulus "What is 2 + 2?"
  options [
    [label "3" value "0"]
    [label "4" value "1"]
    [label "5" value "2"]
  ]
  instant-feedback true
  validation [
    valid-response [score 1 value ["1"]]
  ]
]
```

Every attribute is an arity-1 member, so the same word works at any depth. Three
rules cover the whole language:

| Learnosity shape | How to write it |
| :--------------- | :-------------- |
| object | a member list — `validation [scoring-type "exactMatch"]` |
| array of objects | a list of member lists — `alt-responses [[value ["a"]] [value ["b"]]]` |
| scalar, or array of scalars | the value itself — `case-sensitive false` |

Common attributes: `stimulus`, `template`, `options`, `possible-responses`,
`list`, `stems`, `instant-feedback`, `is-math`, `shuffle-options`,
`multiple-responses`, `case-sensitive`, `max-length`, `placeholder`, `ui-style`,
`metadata`, `validation`. Which of them a given type accepts is the set
Learnosity documents for that widget, and anything else is a compile error.

#### Scoring

Scoring lives in a `validation` member mirroring Learnosity's `validation`
object:

```
clozetext [
  stimulus "Fill in the blanks."
  template "The {{response}} is the {{response}}."
  validation [
    scoring-type "partialMatch"
    alt-responses [[score 1 value ["feline", "mat"]]]
  ]
  validation [
    valid-response [score 1 value [score 1 value ["cat", "mat"]]]
  ]
]
```

`score` and `value` are members like any other. `valid_response` is a single
object, so `valid-response` takes one member list; `alt_responses` is an array, so
`alt-responses` takes a list of member lists. These types also reject attributes
that are not their own — the legal set is the one Learnosity documents for that
widget.

`scoring-type` decides how a partly-correct response scores, and which values it
takes depends on the type — the compiler rejects one the widget does not
document:

| value | meaning |
| :---- | :------ |
| `exactMatch` | every part must be right (the default) |
| `partialMatch` | a cumulative score per correct part |
| `partialMatchV2` | the question's score divided between the parts |
| `partialMatchPairwise` | `orderlist` only: adjacent entries compared in pairs |
| `partialMatchElement`, `partialMatchElementV2` | `classification` and `bowtie`: per response element rather than per cell |

When the request asks for partial credit — "give partial credit", "score each
correct answer separately", "award points per correct selection" — write
`scoring-type "partialMatch"` **inside the question's `validation` member**, never
on the question itself. `scoring-type` is an attribute of `validation` alone: a
question carrying it directly is a compile error listing that type's legal
attributes (`scoring-type is not an attribute of choicematrix`). Single-response
types document only `exactMatch` and reject the rest.

### Instant Feedback

Scored questions default to no per-response feedback. When the request asks the
learner to be able to check their answer — "add a check answer button", "let
students check their work", "show a check button", "submit for feedback",
"immediate feedback" — chain `instant-feedback true`:

```
mcq [
  stimulus "Which planet is closest to the Sun?"
  options [
    [label "Mercury" value "0"]
    [label "Venus" value "1"]
    [label "Earth" value "2"]
    [label "Mars" value "3"]
  ]
  instant-feedback true
  validation [
    valid-response [score 1 value ["0"]]
  ]
]
```

This emits Learnosity's `instant_feedback` flag, which adds a **Check Answer**
button to the rendered question. The score and the valid answer are unchanged —
only the feedback behaviour is.

**It needs a scorable question.** Confirmed by rendering: the button appears
whenever the flag is set, but pressing it does nothing unless the question can
actually be scored — Learnosity needs both a `valid-response` to check against
and a `scoring-type` to check it with. With either missing, `getScore()` returns
`null`, nothing is marked correct or incorrect, and no error is reported
anywhere. The flag reads as simply not working.

Both come from the question type's defaults, and an authored `validation` merges
into those defaults one level deep rather than replacing them — so writing

```
validation [valid-response [score 1 value ["1"]]]
```

keeps the type's `scoring-type` instead of silently dropping it. Write
`scoring-type` explicitly when you want a mode other than the default.

`longtext` and `plaintext` have no valid answer by construction, so they do not
accept `instant-feedback` at all, and say so at compile time.
request asks for partial credit on a single-answer MCQ, either the item is
really multi-select (set both) or partial credit does not apply (omit it).

### Save to Item Bank vs. Preview

By default, `items [...]` produces a **preview**: the item and its questions
render inline through Questions API without being written to the Learnosity
item bank. This is the right default for AI-authored items — the human can
eyeball the preview before deciding to persist.

Wrap the activity in `save-to-itembank` to persist the item and its
questions to the Learnosity item bank: `save-to-itembank items [...] {}`
(or `save-to-itembank questions [...] {}`). `save-to-itembank` takes the
activity as its one argument; it is not a member of the items list. Saved items always land
as `status: "unpublished"` (draft); publishing is done from the Learnosity
Author Site UI, not from the DSL.

The write happens only when the item is compiled through a connection the
caller selected. Otherwise the save is checked but not run, reported as
`itemBank: { skipped: "no-connection" }`, and the preview still renders; that
is not an error. Set the caller's Learnosity credentials with `set-var` before
`items` so the preview is signed with their account:

```
set-var "learnosity-key" get-val-public "learnosity-key"
set-var "learnosity-secret" get-val-private "learnosity-secret"
```

Use these exact credential field names: `learnosity-key` (public) and
`learnosity-secret` (private). They are the stored credential fields, named
`<backend>-<field>`, so always pass them in that kebab-case form — never
camelCase (`learnosityKey`/`learnositySecret`) or other spellings.

The two must be supplied **together** — providing only one is an error. When
present they sign the preview; when absent, previews fall back to the server's
default credentials. Neither ever writes to the bank.

Prompts that should trigger `save-to-itembank`:

- "save it to the item bank" / "write to the bank" / "persist it" → wrap
  the activity in `save-to-itembank` and include the credential `set-var`
  lines above.
- No such phrasing → preview-only; omit `save-to-itembank` (and the
  credentials).

Example — save as draft:

```
set-var "lrn-id" get-val-public "itemId"
set-var "learnosity-key" get-val-public "learnosity-key"
set-var "learnosity-secret" get-val-private "learnosity-secret"
save-to-itembank items [
  item [
    questions [
      mcq [
        stimulus "Which planet is closest to the Sun?"
        options [
          [label "Mercury" value "mercury"]
          [label "Venus" value "venus"]
          [label "Earth" value "earth"]
          [label "Mars" value "mars"]
        ]
        validation [
          valid-response [score 1 value ["mercury"]]
        ]
      ]
    ] {}
  ]
] {}..
```

### Pipeline Composition

When the prompt asks for an item whose content comes from another
Graffiticode language, emit a `custom` question whose `model` attribute
reads the upstream pipeline node via the base-language `data` primitive.

**REQUIRED — the binding is not optional.** Every `custom` question that
embeds an upstream interaction MUST include a `model data use "<lang>"`
attribute, with `<lang>` equal to that `custom`'s own `lang`. The `model`
line is what wires the upstream content in: a `custom` question that has
`lang` and `stimulus` but omits `model data use` renders an EMPTY
interaction and is invalid output. Emit all three — `lang`, `stimulus`,
and `model data use "<lang>"` — every time. Use the `data use "<lang>"`
form (not the bare `data {default}` fallback) whenever you know the
upstream language, so the console can reactively generate and chain the
upstream task.

**Composable upstreams.** Map the content type to the correct upstream
language id; use that id consistently as both the `lang` on the surrounding
`custom` and the argument to `use`:

| If the prompt asks for… | Upstream lang |
| :--- | :--- |
| Spreadsheet content ("spreadsheet question", "use this sheet", "table-based assessment") | `0179` |
| Concept-web assessment ("concept web", "concept map", "mind map", "drag terms onto a web") | `0183` |

If the prompt's content type doesn't fit any row above, do not invent
an upstream — emit a question type that L0176 authors directly (mcq,
shorttext, etc.) or, if the request is fundamentally out of L0176's
scope, emit `OUT_OF_SCOPE: <reason>` and let the router suggest the
right dialect.

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

- **`data use "<lang>"`** (preferred). Inherits from the base language.
  The `use` annotation declares the upstream language id; the console
  reads it at write time, fetches `L<lang>/schema.json`, generates the
  upstream task, and chains it. At runtime, `data` returns the upstream's
  compiled output if a producer is wired, or `{}` otherwise.
- **`data {default}`** (untyped fallback). Same runtime semantics but
  without the language hint, so the console will not auto-discover an
  upstream — the chain must be assembled manually in the pipeline editor.
  Use a small skeleton matching the interaction's expected shape so the
  program also renders in preview without an upstream.
- The `lang` on the surrounding `custom` should match the `use` argument.
- The pipeline edge can be assembled reactively from the `use` hint or
  set manually in the console's pipeline editor. Source code never
  references upstream task IDs directly.
- One L0176 program has at most one upstream. Multiple `custom` questions
  in the same program all read the same upstream value. If the prompt
  needs distinct upstreams per question, that's multiple L0176 programs.
- Scoring is the deployed interaction's `scorer.js` — do not add
  `valid-response` for `custom` questions.
- **Before finishing a composed item, verify every `custom` question has a
  `model data use "<lang>"` line whose argument equals its `lang`.** A
  dropped `model` binding is the single most common composition error and
  produces a silently empty interaction — never emit a `custom` without it.
- `save-to-itembank` freezes the upstream value at compile time into
  the saved item. The bank entry is a snapshot, not a live reference;
  edits to the upstream after save do not propagate. If the prompt asks
  to "save a live spreadsheet question to the bank", clarify or fall back
  to preview-only.

### Dynamic Data

Learnosity items can carry a table of variable values; each session
substitutes one row into the question text via `{{colname}}` placeholders.

- Embedding an L0179 custom question whose compiled output includes
  `templateVariablesRecords` automatically routes those rows into the
  item's `dynamic_content_data`. No extra keyword needed — just reference
  the variables in stems with `{{A1}}`-style placeholders.
- To declare a table directly (no L0179 upstream), chain the
  item-level `params` keyword with a list of row records:

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

- If both forms are present, the inherited L0179 table
  wins. Don't mix them unless the prompt explicitly asks for a fallback.

## Example Patterns

- Simple MCQ assessment:
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
          validation [
            valid-response [score 1 value ["2"]]
          ]
        ]
      ] {}
    ]
  ] {}..
  ```

- MCQ with all defaults:
  ```
  set-var "lrn-id" get-val-public "itemId"
  items [item [questions [mcq []] {}]] {}..
  ```

- Multiple items:
  ```
  set-var "lrn-id" get-val-public "itemId"
  items [
    item [questions [mcq []] {}],
    item [questions [shorttext []] {}]
  ] {}..
  ```

- Fill-in-the-blank:
  ```
  set-var "lrn-id" get-val-public "itemId"
  items [
    item [
      questions [
        clozetext [
          stimulus "Complete the sentence."
          template "The {{response}} is the powerhouse of the cell."
          validation [
            valid-response [score 1 value ["mitochondria"]]
          ]
        ]
      ] {}
    ]
  ] {}..
  ```

- Math question:
  ```
  set-var "lrn-id" get-val-public "itemId"
  items [
    item [
      questions [
        clozeformula [
          stimulus "Solve for \\(x\\)."
          template "\\(x + 3 = 7\\). \\(x =\\) {{response}}"
          is-math true
          validation [
            valid-response [score 1 value [[[method "equivLiteral" value "4"]]]]
          ]
        ]
      ] {}
    ]
  ] {}..
  ```

- Multiple questions in one item:
  ```
  set-var "lrn-id" get-val-public "itemId"
  items [
    item [
      questions [
        mcq [
          stimulus "Pick one"
          options [
            [label "A" value "a"]
            [label "B" value "b"]
            [label "C" value "c"]
          ]
          validation [
            valid-response [score 1 value ["a"]]
          ]
        ],
        shorttext [
          stimulus "Type the answer"
          validation [
            valid-response [score 1 value "answer"]
          ]
        ]
      ] {}
    ]
  ] {}..
  ```

- Spreadsheet question reading an upstream L0179 task:
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

- Concept web question reading an upstream L0183 task:
  ```
  set-var "lrn-id" get-val-public "itemId"
  items [
    item [
      questions [
        custom [
          lang "0183"
          stimulus "Drag each part of the cell onto the web."
          model data use "0183"
        ]
      ] {}
    ]
  ] {}..
  ```

- Initialize an items session:
  ```
  init { "type": "items" }..
  ```

- Author mode for editing items:
  ```
  author { "mode": "item_edit" }..
  ```
