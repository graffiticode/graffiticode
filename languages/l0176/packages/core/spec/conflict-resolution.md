<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# L0176 conflict register — where the Learnosity docs disagree, and what was done about it

L0176 compiles to Learnosity Question JSON, so its correctness is downstream of a
documentation set that contradicts itself in places. This file records every point where the
question-type articles disagree with each other, with their own examples, or with L0176's
observed output — what the resolution was, and, where nothing resolved it, that it is still
open.

Two rules govern this file. **An unresolved conflict stays unresolved in writing.** Picking the
tidier reading and moving on is how a compiler acquires a confident wrong field. And **a
resolution records what settled it**, so a later reader can overturn it with better evidence
instead of re-litigating it from scratch.

Sources are the 51 question-type articles cached at `~/work/learnosity/question-types-docs/`
(retrieved 2026-08-20; that folder's `README.md` says how). Where an entry cites an article it
means that file.

This register is about the *sources*. Where L0176 itself diverges from documentation that is
internally consistent, that belongs in `docs/learnosity-audit.md`, which is worked one question
type at a time.

## How conflicts get resolved, in precedence order

1. **Live measurement beats documentation.** Scoped to what was actually rendered — see the
   caveat at the end, which currently swallows most of this rule.
2. **The attribute table beats the worked example beats the prose.** The tables are
   specifications. The examples are demonstrably copied between articles (C3), and the
   introductory prose drifts.
3. **Two articles that disagree are often both right about different types.** Look for a
   discriminator before declaring a conflict — Learnosity's type family is full of near-twins
   (`clozeformula` vs `clozeformulaV2`, `longtext` vs `longtextV2`) whose docs differ because
   the types differ.
4. **Otherwise, mark it OPEN** and say what L0176 should do in the meantime.

## Register

| # | Conflict | Status |
| :-: | :--- | :--- |
| C1 | The scoring-method enumeration exists on exactly one article | RESOLVED — ten, per the Author Guide |
| C2 | `validation.*.options` is documented as two disjoint sets | RESOLVED — measured; documented per method, enforced nowhere |
| C3 | Four articles' examples declare a sibling question type | RESOLVED — table wins |
| C4 | `alt_responses[ ][ ]` documents a shape that does not exist | RESOLVED — artifact |
| C5 | `orderlist`'s example contradicts its own `ui_style` table | RESOLVED — table wins |
| C6 | `custom`'s response `type` is boilerplate from another article | RESOLVED — table loses |
| C7 | `distractor_rationale_response_level` is typed three ways | RESOLVED — refinement |
| C8 | The bow-tie example's indices do not decode | RESOLVED — measured, the example is wrong |
| C9 | `classification` omits `possible_responses` from its own table | RESOLVED — omission |
| C10 | `scoring_type`'s documented default is not applied by the scorer | RESOLVED — measured, emit it explicitly |

---

### C1 — The scoring-method enumeration exists on exactly one article · RESOLVED (documented, after two wrong measurements)

`Chemistry-formula-chemistry.md` documents `validation.valid_response.value[].method` with a
*Possible values* list of six: `equivSymbolic`, `equivLiteral`, `equivValue`, `stringMatch`,
`equivSyntax`, `isTrue`. It is the **only** article in the corpus that enumerates them —
`equivSyntax` appears in one file of 51.

Eleven articles document a `method` field. Nine of them are the math and chemistry types —
`clozeformula`, `clozeformulaV2`, `imageclozeformula`, `imageclozeformulaV2`, `clozechemistry`,
`imageclozechemistry`, `multistepmath`, and the deprecated `formula` and `formulaV2` — and every
one gives only `Default: "equivLiteral"` with no enumeration at all. The remaining two document
a `method` from an entirely different vocabulary: `simpleshading` takes `byLocation` or
`byCount`, `fillshape` takes `countByValue`.

**How it was closed.** A `clozeformulaV2` scored on a method name that cannot exist
(`definitelyNotAMethod`). Learnosity refused it and printed its own enumeration:

```
10019: Failed validating math (Detail: invalid method - can be one of:
equivValue, equivLiteral, equivSyntax, equivSymbolic, isFactorised, isSimplified,
isExpanded, isUnit, isTrue, simplify, expand, variables, format, calculate, validSyntax.
```

Fifteen names, from the scorer itself. The same probe settles the question the corpus could
not: an unrecognised method **errors and scores 0**, so it never silently degrades to the
`equivLiteral` default — which is what makes every other reading below meaningful.

**Measured, one `clozeformulaV2` per method, response pre-set and `getScore()` read.** Each
equivalence probe uses a response that is correct under its own method and *wrong* under
`equivLiteral`, so a score of 1 proves the method was honoured rather than defaulted:

| probe | value | response | score |
| :-- | :-- | :-- | :-- |
| `equivLiteral` | `1/2` | `1/2` | 1 |
| `equivLiteral` | `1/2` | `0.5` | 0 |
| `equivSymbolic` | `1/2` | `0.5` | **1** |
| `equivValue` | `1/2` | `0.5` | **1** |
| `equivSyntax` | `1/2` | `1/2` | 1 |
| `isTrue` | — | `1+1=2` / `1+1=3` | 1 / 0 |
| `isSimplified` | — | `1/2` / `2/4` | 1 / 0 |
| `isExpanded` | — | `x^2+2x+1` | 1 |
| `isFactorised` | — | `(x+1)^2` | 1 |
| `isUnit` | `cm` | `5 cm` | 1 |
| `definitelyNotAMethod` | `1/2` | `1/2` | **0 + error** |

**The chemistry list is not the enumeration**, and the corpus was wrong in both directions.
`isSimplified`, `isFactorised` and `isUnit` — the three L0176 inherited from L0158 that appear
in no Learnosity enumeration and no example anywhere — are all real and all score. The
predicates take no `value`, as `Math-formula-Deprecated.md` shows; `isUnit` is the exception,
scoring 0 without one and 1 with `value: "cm"` against a response of `5 cm`.

**`stringMatch` is real but is not in the enumeration**, and it is not a math method. It scores,
and unlike every name outside the list it raises no error — because it never reaches the math
API. It is also observably *not* `equivLiteral`: against a value of `1/2`, a response of
`1 / 2` scores 1 under `equivLiteral` and **0** under `stringMatch`. Literal characters, not a
parsed expression. The one article that documents it is the chemistry one, and that is
consistent with it being handled outside the math engine.

**Superseded: the enumeration was never the authority.** This entry originally
treated the math engine's runtime error as the definitive list, because nothing in the
question-type corpus contradicted it. It is not. `Chemistry-formula-chemistry.md` says of
`method`, "See Legacy Scoring Articles for more information" — and those articles exist, on
**authorguide.learnosity.com**, a different subdomain from the question-type help centre, which
is why searching the latter never found them. They are now cached at
`~/work/learnosity/scoring-methods-docs`.

That section has **one article per scoring method, and there are ten**:

    equivLiteral  equivSymbolic  equivValue  equivSyntax  stringMatch
    isSimplified  isFactorised   isExpanded  isUnit       isTrue

The engine's error names six more — `validSyntax`, `simplify`, `expand`, `variables`,
`format`, `calculate` — and none has an article. That list is the math API's methods, which mix
scoring with engine actions. The two readings agree on everything that matters: the chemistry
article's six were an undercount, `isSimplified`/`isFactorised`/`isUnit` are real, and
`stringMatch` is a real method that never reaches the math API.

**This entry got `validSyntax` wrong twice, and the second time is the instructive one.** It
was first probed with a single well-formed response, scored 1, and written up as "behaves as a
predicate" — which one positive case cannot support. A negative case was then added (`0.5` → 1,
`((` → 0), it discriminated, and the entry was corrected to call it an engine action *while
still leaving it in the compiler's accepted set* on the grounds that the engine scores it. That
was still wrong: scoring is not the test, documentation is. A method with no article is not a
question scoring method, and the compiler now accepts exactly the ten.

The lesson generalises past the negative-case rule this register already states: **measurement
establishes behaviour, not intent.** A render can tell you what the engine does with an input;
it cannot tell you the input was ever meant to be offered to an author. For that, find the
documentation — and if a page says "see X for more information", X is worth finding before
concluding the corpus is silent.

**Consequence for L0176.** The compiler accepts exactly the ten documented methods. L0176's
inherited list of eight was wrong by omission (`equivSyntax`, `isTrue`) and
right about the three that looked invented. Nothing in the compiler checks `method` today, so
a typo reaches the learner as a rendered question that scores every response 0.
### C2 — `validation.*.options` is documented as two disjoint sets · RESOLVED (measured; the split is not real)

Every math and chemistry type nests an `options` bag inside each validation rule. Across the
corpus it is documented as two sets that do not overlap:

| Set | Articles whose attribute table documents it |
| :-- | :-- |
| `ignoreLeadingAndTrailingSpaces`, `treatMultipleSpacesAsOne` (plus `inverseResult` on the chemistry types) | `chemistry`, `clozechemistry`, `imageclozechemistry`, `clozeformula`, `imageclozeformula`, `formula`, `formulaV2` |
| `decimalPlaces`, `setDecimalSeparator` | `clozeformulaV2`, `imageclozeformulaV2`, `multistepmath` |

Neither table matches its own article's example. `clozeformula`'s example passes
`decimalPlaces` and `ignoreOrder`; `multistepmath`'s passes `setThousandsSeparator`,
`setDecimalSeparator` and `ignoreOrder`. `ignoreOrder` and `setThousandsSeparator` appear in
**no** attribute table in the corpus.

**How it was closed.** Each option was rendered on `clozeformulaV2` — a type whose table
documents only the *second* set — paired with a control differing in nothing but the option, so
that the contrast is the evidence rather than the score:

| option | documented for | pair | scores |
| :-- | :-- | :-- | :-- |
| `decimalPlaces: 2` | set 2 (this type) | `equivValue`, `1/3` vs `0.33`, with / without | **1 / 0** |
| `inverseResult: true` | set 1, *chemistry only* | `equivLiteral`, `1/2` vs `1/2`, true / false | **0 / 1** |
| `ignoreLeadingAndTrailingSpaces` | set 1 | `stringMatch`, `1/2` vs `" 1/2 "`, true / false | **1 / 0** |
| `setThousandsSeparator: [","]` | **no table anywhere** | `equivValue`, `1000` vs `1,000`, with / without | **1 / 0** |
| `notARealOption: true` | — | `equivLiteral`, exact answer | 1, **silently ignored** |

**The two-set split is a documentation artifact.** `options` is one shared bag. Keys documented
only for the chemistry family are honoured on `clozeformulaV2`, and `setThousandsSeparator` —
which no attribute table in all 51 articles documents — is honoured too. `inverseResult` is the
sharpest of these: it turns a correct answer into a 0, so it cannot have been ignored.

**Unknown keys are accepted in silence.** A key that is not an option produces no error, no
console warning, and no change in score. This is the opposite of `method`, where an
unrecognised value is rejected loudly — so an options typo is invisible at every layer,
including this one, and only shows up as scoring that quietly does not do what was asked.

**Superseded in part: the option vocabulary is documented after all.** Like C1, this entry was
written believing the question-type corpus was the only source. The Author Guide's
scoring-method section documents options per method, and it is now cached at
`~/work/learnosity/scoring-methods-docs`:

| option | documented for |
| :-- | :-- |
| `decimalPlaces` ("significant decimal places") | `equivSymbolic`, `equivValue` |
| `ignoreText` | `equivSymbolic`, `equivValue`, `equivSyntax` |
| `compareSides` | `equivSymbolic`, `equivValue` |
| `allowDecimal` ("allow decimal marks") | `equivLiteral`, `equivSymbolic`, `equivValue`, `isSimplified` |
| `treatLettersAsVariables` | `equivSymbolic` |
| `allowThousandsSeparator` | `isExpanded`, `isFactorised`, `isTrue`, `isUnit` |
| `inverseResult`, `ignoreOrder`, `allowInterval`, `ignoreTrailingZeros` | `equivLiteral` |
| `ignoreLeadingAndTrailingSpaces`, `treatMultipleSpacesAsOne` | `stringMatch` |

This does not overturn the finding — the measurements stand, and a key documented for one
method is still honoured on another (`inverseResult`, documented for `equivLiteral`, flips a
`clozeformulaV2` result). What it overturns is the claim that the split was *undocumented*.
There is a per-method vocabulary; it is simply not enforced.

**The inconclusive `ignoreOrder` probe is now explained.** It scored 0 with and without the
option, and this entry recorded that as indicting the probe. It did not: Learnosity's own
scorer configuration (`mathcore/scorerConfig.js`, cached locally) switches over the settings it
translates for the literal and syntax methods, and lists `ignoreOrder` in the branch it
discards — alongside `strict`, `normalizeArithmetic`, `ignoreCoefficientOne`,
`ignoreTrailingZeros`, `allowInterval` and `ignoreLeadingAndTrailingSpaces`. The option is
accepted, documented for `equivLiteral`, and dropped on the floor. The probe was right and the
write-up was wrong.

That is a third silent layer on top of the two this entry already names: a key can be unknown
and ignored, known and honoured, or **known, documented, and still ignored**. Only the last is
invisible to both the author and this register without reading the engine.

`setDecimalSeparator` stays inconclusive. Its probe failed to parse rather than failing to
score, and the Author Guide describes it as part of "allow decimal marks" — the separator
characters rather than a switch — which the probe did not model.

**Consequence for L0176.** The old emission was
`{ignoreOrder, setDecimalSeparator, setThousandsSeparator, inverseResult}` on every rule —
which is now known to be *valid* (all four are real keys on this type) but was hard-coded and
omitted `decimalPlaces`, the one key that governs `equivValue`. The redesign made `options` an
authored member list, so the author writes exactly the keys they mean. Given that unknown keys
vanish silently, a check against a known-key list is worth more here than it looks.
### C3 — Four articles' examples declare a sibling question type · RESOLVED (table wins)

Four worked examples set a `"type"` that contradicts their own article's normative statement:

| Article | Table says | Example says |
| :-- | :-- | :-- |
| `Cloze-chemistry-clozechemistry.md` | `clozechemistry` | `clozeformula` |
| `Cloze-chemistry-with-image-imageclozechemistry.md` | `imageclozechemistry` | `imageclozeformula` |
| `Math-essay-with-rich-text-formulaessayV2.md` | `formulaessayV2` | `longtextV2` |
| `Chemistry-essay-Deprecated.md` | `chemistryessay` | `formulaessay` |

**Resolution.** The tables. Each says *Must be set to "X" in this case* or carries it as the
`type` attribute's default; the examples are copy-pasted from the nearest sibling type and were
not updated. In the `clozechemistry` case the entire example — stimulus, template, response
containers, validation — is `clozeformula`'s, differing only by a stray newline inside the
template string.

**Why it matters beyond these four.** This is the evidence for precedence rule 2 ranking
examples below tables. An example in this corpus may not have been written for the article it
appears in, which is also the likeliest explanation for C5 and C6.

### C4 — `alt_responses[ ][ ]` documents a shape that does not exist · RESOLVED (artifact)

27 of the 51 articles document `validation.alt_responses[ ].value` **and**
`validation.alt_responses[ ][ ].value`, with identical descriptions, as though alternates
nested two levels deep.

**Resolution.** A doc-generator artifact. `alt_responses` is an array of `{score, value}`;
there is no second level. The evidence is thin but one-directional: exactly one worked example
in the corpus populates `alt_responses` at all — `shorttext`'s — and it is single-level, and
L0176 emits the single level and matched L0158 across the golden set.

Recorded because the duplicated rows are not obviously spurious on the page: a reader
implementing from the attribute table alone, without an example to hand, would produce a
wrongly-nested array.

### C5 — `orderlist`'s example contradicts its own `ui_style` table · RESOLVED (table wins)

`Order-list-orderlist.md`'s example sets `"ui_style": "button"` — a bare string. Its attribute
table declares `ui_style` an object, and puts the list style at `ui_style.type` with supported
values `button`, `list`, `inline`.

**Resolution.** The table, per rule 2, and consistently with every other article in the corpus,
where `ui_style` is an object without exception. The example is the outlier.

### C6 — `custom`'s response `type` is boilerplate from another article · RESOLVED (table loses)

`Custom-Draft.md`'s *Response attributes* says of `type`: *Informs the scoring engine about
what kind of data to expect… Must be set to `"array"`.* Its own example returns
`"type": "custom_shorttext"`, and its own prose two paragraphs earlier says the response format
*depends on the custom Question type implementation*.

**Resolution.** The `"array"` is boilerplate pasted from the array-returning types. This is the
one entry where rule 2 is overridden: the table is contradicted by both the example and the
prose in the same article, and by the nature of the type — a custom question's response shape
is defined by the custom scorer, which is the entire point of the type.

**Depends on it:** L0176's `buildCustom` emits no response-shape constraint, which is correct.

### C7 — `distractor_rationale_response_level` is typed three ways · RESOLVED (refinement)

`metadata.distractor_rationale_response_level` is declared `array[string]` in 14 articles, bare
`array` in 11, and `string/number` in one — `Text-highlight-Deprecated.md`.

**Resolution.** `array[string]`. `array` and `array[string]` are a refinement rather than a
contradiction — the same field described at two levels of precision — so only the deprecated
article genuinely conflicts, and rule 3 does not rescue it: nothing about `texthighlight` would
make its rationale field scalar when every live type's is a list.

Edit dates do not discriminate, and were checked in case they did: both the `array` and the
`array[string]` groups run to 2026-08-14, so the imprecise form is not simply the older one.

**Depends on it:** how L0176 should expose per-response rationale, which the audit records as
an open item — it currently joins the list into one numbered string in `distractor_rationale`
instead.

### C8 — The bow-tie example's indices do not decode · RESOLVED (measured; the example is wrong)

`Bow-tie-bowtie.md`'s example defines three response groups of 5, 2 and 5 options — twelve in
total, indices 0–11 — and gives `validation.valid_response.value` as `[[0, 4], [7], [10, 12]]`.

Under cumulative global indexing the groups occupy 0–4, 5–6 and 7–11. So `[7]`, the middle
drop zone, names an option in the third group, and `12` is out of range entirely. The array is
not decodable under that scheme, and no other scheme is described: the article says only "an
array with three elements representing each drop zone".

**How it was closed.** A bow-tie was rendered in `review` state, which makes Learnosity print
the correct answer, and the rendered text read back:

| groups | `valid_response.value` | Learnosity rendered |
| :-- | :-- | :-- |
| `A1 A2` / `B1 B2` / `C1 C2` (2-2-2) | `[[0], [2], [4]]` | `1 A1  2 B1  3 C1` |
| `A1 A2 A3` / `B1` / `C1 C2` (3-1-2) | `[[2], [3], [5]]` | `1 A3  2 B1  3 C2` |

**Cumulative global indexing, confirmed.** The second case is the decisive one: with groups of
3, 1 and 2 a per-group scheme cannot even express index 3 or 5, and the indices land exactly
where a running offset across all groups puts them.

**The example is simply wrong** — not a different scheme. L0176's `resolveBowtieResponse`
computed cumulative global offsets and passed the 117/117 golden-parity gate against L0158;
that gate proved agreement with L0158, and this render proves agreement with Learnosity. The
instruction to not "fix" L0176 toward the example stands, and now has a measurement behind it.
### C9 — `classification` omits `possible_responses` from its own table · RESOLVED (omission)

`Classification-classification.md` documents 13 top-level attributes.
`possible_responses` — the draggable items, without which the type does nothing —
is not among them.

It is everywhere else in the same article: the worked example sets it, the
`validation.valid_response.value` description says "the response index is based
on the index value in the `possible_responses` attribute" (three times, once per
scoring section), and `duplicate_responses` is defined as "the items from the
`possible_responses` will be reusable".

**Resolution.** The attribute exists and is required. This is an omission from the
table rather than a contradiction between sources — precedence rule 2 ranks the
table above the example, but rule 2 is about which source to believe when they
*disagree*, and here the table simply says nothing.

Recorded because it is the sharpest case yet against treating the attribute
tables as complete: implementing `classification` from its table alone yields a
question with no items to drag. Compare C2, where the tables are likewise
incomplete about the `options` bag but at least list something.

**Depends on it:** `validAttributes.CLASSIFICATION` includes `possible_responses`
even though it is absent from the article the rest of that list was taken from.

### C10 — `scoring_type`'s documented default is not applied by the scorer · RESOLVED (measured)

Every article that documents `validation.scoring_type` gives it a default:
`Default: "exactMatch"`. Taken at face value, a validation that omits the key scores the same
as one that sets it to `exactMatch`.

**It does not.** Measured with two questions identical but for that one key, rendered in the
same harness, the correct option selected, and the instant-feedback Check Answer button
pressed:

| `validation` sent | `getResponse()` | `getScore()` | rendered |
| :-- | :-- | :-- | :-- |
| `{valid_response: {score: 1, value: ["1"]}}` | `["1"]` | **`null`** | nothing marked |
| `{scoring_type: "exactMatch", valid_response: ...}` | `["1"]` | `{score: 1, max_score: 1}` | `Grover Cleveland - correct` |

The response is recorded either way — `feedbackAttemptsCount` increments, the option shows as
selected — so the question is live. Only the scoring is absent, and **nothing reports it**: no
error, no console warning, no `errorListener` call. The documented default exists in the
articles and not in the scorer.

**Why it matters more than it looks.** This is the failure with no symptom. A question with no
`scoring_type` renders correctly, accepts responses, and looks finished. `instant-feedback` even
draws its Check Answer button — the button simply does nothing when pressed. An author
reviewing the preview sees a working item.

**How L0176 hit it.** The redesign gave each type a default `validation`, and `withDefaults`
spread it flat. A flat spread makes an authored `validation` *replace* the default rather than
merge into it, so a question written as `validation [valid-response [...]]` — the ordinary
thing to write — silently shipped without a `scoring_type`.

**What L0176 does now.** `scoring_type` is always on the wire. Two layers put it there:
`withDefaults` merges one level deep, so an authored `validation` keeps the type's default
scoring mode; and `applyScoring` backstops with the type's first supported mode for any type
whose defaults lack one. A missing `valid_response` is an error instead — there is no honest
stand-in for the answer.

**Precedence.** Rule 1: the render wins over the table. Do not "simplify" by relying on the
documented default.

---

## Caveat on evidence

**Four entries are measured; the other six are not.** C1, C2, C8 and C10 were closed against a live
Learnosity render — questions signed and initialised in a browser with responses pre-set, and
`getScore()` read back — so precedence rule 1 decided them, and in all three cases it overruled
what the corpus said. That is the reason to keep rule 1 at the top: the two entries that most
affect the emitted JSON both turned out to rest on documentation that is incomplete (C1) or
describes a restriction that does not exist (C2), and the one worked bow-tie example in the
corpus (C8) is simply wrong. C10 is the sharpest of the four: a documented *default* that the
scorer does not apply, failing silently in a way no layer reports.

Everything else here is doc-versus-doc, or doc-versus-what-L0176-emits. Where a resolution says
a table or an example "wins", it means the corpus is internally consistent enough to prefer one
reading, not that Learnosity's implementation has been observed to agree. Those entries are
decisions about which source to trust, and should be overturned the moment a render says
otherwise — which is exactly what happened to C1, C2 and C8.

**How the render session worked**, since it is worth repeating rather than reinventing:

- Sign the activity JSON directly with `learnosity-sdk-nodejs` rather than going through the
  compiler, so a probe can be any shape — including shapes L0176 cannot emit.
- The activity-level key for `resume` / `review` is **`state`**, not `type`. Learnosity's error
  message names the values but not the key, and rejects both when given as `type`.
- With `state: "review"` plus a `responses` map keyed by `response_id`, a probe scores without
  the UI being driven at all, and the correct answer is rendered — which is what decodes C8.
- The SDK's `errorListener` surfaces nothing useful. Patch `console.error` **before** the SDK
  script loads; that is where the C1 enumeration came from.
- **Always probe a deliberately invalid value alongside the real ones.** Whether an unknown
  value errors or is silently ignored is the difference between a score of 1 meaning something
  and meaning nothing — and it split the two ways here: `method` rejects loudly, `options`
  swallows in silence.
- Sign every probe into **one** activity. Nineteen questions in a single request answered the
  whole register in one page load.
- Rendering is safe to repeat; **item-bank writes are not**. Nothing in a render session should
  reach `save-to-itembank`.

Coverage is uneven: the conflicts found so far come from the types L0176 already emits (C9
surfaced only when `classification` was actually converted, not when its article was read),
plus the math and chemistry family read for C1 and C2. The 27 documented types L0176 does not
map have been read once and not audited. Expect this register to grow, and prefer growing it to
quietly resolving a conflict in favour of whichever article was read last.
