# L0182 — surveys

L0182 is a **survey record**: a program names a survey the language server holds, and carries one
response to it. A survey has one of two **styles**, and the survey decides which:

- **ranked-choice** — a set of options; the response chooses some, in priority order, and may add
  one write-in that was not in the set.
- **rating** — a list of items, each answered on a scale: a Likert agreement grid, a satisfaction
  or frequency question, an NPS question, a star rating, a semantic differential. The response
  rates the items and may add a comment.

OUT_OF_SCOPE: assessment and quiz items — anything with a right answer, points, marking or a
rubric. L0182 gathers opinions and does NOT score anyone. Use L0180 for graded questions.
Demographics, free-text questionnaires with fixed questions, and branching form logic are not
built yet. L0182 does NOT implement a survey-taking flow: it has no screens, steps, navigation or
submission, and it never aggregates across respondents. **Surveys are NOT authored here**: a
program cannot write the options, the items, the scales, the title, the wording or the bounds,
and there is no word for any of them.

## The shape of a program

One word, `survey`, applied to an attribute list. A program names the survey being taken and
says nothing else about it — what the survey asks comes from the survey itself, when the program
compiles.

```
survey [
  id "civic-priorities"
  session-id get-val-public "itemId"
]..
```

That is a whole program: it takes the survey called `civic-priorities` and records what that
person was shown. The compiled record carries the survey's style, its title, its instructions and
its contents, and nothing in the program can change them.

**Write `session-id get-val-public "itemId"` in every program, exactly like that.** It is one
taking of the survey, and it is what keeps an answer with the version of the survey it answers —
see "Keep the session" below. Copy the line verbatim; never write an id of your own.

Every word in the language takes exactly one argument. Nothing chains, and nothing takes a
trailing record.

| Target shape                | How it is written                                                        |
| :-------------------------- | :----------------------------------------------------------------------- |
| the survey, or the response | a word applied to an attribute list — `response [choices ["…"]]`         |
| a scalar                    | the value itself — `id "civic-priorities"`                               |
| a list                      | the list itself — `choices ["clean air and water" "affordable housing"]` |
| a list of answers           | one attribute list per answer — `ratings [[item "…" rating "Agree"]]`    |

## The surveys you can take

An `id` names a survey the language server holds. These are installed:

| `id`                    | Style         | The survey                                                                                    |
| :---------------------- | :------------ | :-------------------------------------------------------------------------------------------- |
| `civic-priorities`      | ranked-choice | what people want their representatives to work on. Twelve versions; taking it draws one.      |
| `team-retro`            | ranked-choice | eight things an engineering team could fix first, from a sprint retro. Choose 1–3.            |
| `city-budget`           | ranked-choice | ten neighbourhood projects a city council could fund. Choose 0–2.                             |
| `product-features`      | ranked-choice | nine features customers have asked for. Choose 2–4.                                           |
| `school`                | ranked-choice | seven school improvements. Choose 0–3.                                                        |
| `course-feedback`       | rating        | five agreement statements, a portal ease-of-use line and an NPS question; takes a comment.    |
| `customer-satisfaction` | rating        | five satisfaction questions about a store visit, a star rating and an NPS question.           |
| `app-usability`         | rating        | six semantic-differential lines about an app, each 1–7 between two opposite words.            |
| `workplace-pulse`       | rating        | a short pulse survey. Three versions — frequency, importance, or effect; taking it draws one. |

An id that does not exist is a compile error listing the ones that do — so if you are unsure,
write your best guess and read the error rather than inventing a survey. Bounds, scales and which
items are required are the survey's own and cannot be changed from a program; a response outside
them is refused.

**A survey may have several versions**, one per file: `civic-priorities-1`, `civic-priorities-2`,
and so on. Naming the survey (`id "civic-priorities"`) draws one of them, and which one is recorded
as `instance` in the compiled record. Naming a version outright (`id "civic-priorities-7"`) takes
exactly that one.

## Answering a ranked-choice survey

The response is written into the same program:

```
survey [
  id "team-retro"
  session-id get-val-public "itemId"
  response [
    choices ["fix the flaky tests before adding features" "cut the build time in half"]
    write-in "give every service a named owner"
  ]
]..
```

- `choices` names the options chosen, and **the order is the ranking** — first is most important.
  No option may appear twice.
- **Name each option by its exact text.** This is the important rule. The options live in the
  survey, not in the program, so you have not seen the ids or the positions and cannot know them.
  The text is the only key you were actually given.
- An id in quotes (`choices ["t3"]`) or a position counting from 0 (`choices [2 0]`) is accepted
  **only when you can see the set** — when the compiled survey is in front of you. A guessed
  position lands in range and records the wrong options without failing.
- Text matching ignores case and surrounding space, but the words must be the option's own.
- A number is always a position and a string is never one, so those cannot be confused even for a
  set whose ids look like numbers: `choices [1]` is the second option, `choices ["1"]` is the
  option whose id is `1`. Between the two string forms an id wins.
- `write-in` is one new option from whoever answered. It must NOT repeat an option already in the
  set — that is what makes it new. It may stand alone, with nothing chosen, where the survey's
  floor allows it.

## Answering a rating survey

```
survey [
  id "customer-satisfaction"
  session-id get-val-public "itemId"
  response [
    ratings [
      [item "The range of products on offer" rating "Satisfied"]
      [item "How easy it was to find what you wanted" rating "Very satisfied"]
      [item "The helpfulness of the staff" rating "Satisfied"]
      [item "The time you spent waiting to pay" rating "Dissatisfied"]
      [item "The price you paid for what you bought" rating "Neither satisfied nor dissatisfied"]
      [item "Your visit overall" rating 4]
      [item "How likely are you to recommend us to a friend?" rating 8]
    ]
  ]
]..
```

- `ratings` holds **one `[item … rating …]` list per answer**, each in its own brackets.
- `item` names the item by **its exact text** — the same rule, for the same reason, as `choices`.
  An id or a 0-based position works too once you can see the survey.
- `rating` is the answer on that item's scale:
  - **a label**, in quotes — `"Agree"`, `"Very satisfied"`, `"Often"`. Case and spacing are
    forgiven; the words are not.
  - **a number, which is the scale's own value — never a position.** On a 0–10 scale `9` is 9; on
    a five-point agreement scale `4` is "Agree", because its values run 1–5. This is the opposite
    of what a number means in `choices`, and deliberately so: on a scale the number IS the answer.
  - **an end word**, where the item gives its scale two — a semantic differential such as
    `["confusing", "clear"]` takes `"clear"` for the top of the scale.
  - **the opt-out**, where the scale has one — `"Not applicable"`, `"Prefer not to say"`. It is
    recorded as an opt-out, not a value.
- Every **required** item must be answered; the survey says which are optional. An item may be
  rated once.
- `comment` is free text, **only** where the survey asks for one (`comment` in the compiled
  survey). Anywhere else it is refused.
- The order of the entries does not matter; the compiled record lists them in the survey's order.

A response uses the words of its survey's style: `choices` and `write-in` answer a ranked-choice
survey, `ratings` and `comment` answer a rating survey, and the wrong pair is refused by name.

## Keep the session

`response` is written inside the survey's brackets and lifted to the top level of the compiled
record. A program with no `response` is a survey awaiting one.

**Keep `session-id` when you add a response.** A survey with several versions draws one per
session, and the session is what brings back the same version on the turn that answers. A
response written without it may be checked against a different version of the survey — which
fails outright when a name matches nothing, and silently records answers nobody gave when it
does. If the compiled survey is in front of you, writing its `instance` as the id
(`id "civic-priorities-7"`) pins it beyond doubt.

## Which words each container takes

| Container  | Takes                               |
| :--------- | :---------------------------------- |
| `survey`   | id, response, session-id            |
| `response` | choices, write-in, ratings, comment |
| `ratings`  | item, rating                        |

## What the survey brings with it

The compiled record carries what the survey says, none of which a program can write:

- `style` — `ranked-choice` or `rating`.
- `title` and `instructions` — the words a participant reads.
- `instance` — which version of the survey was taken.
- For ranked choice: `options`, each with an id — the originating service's own where the data
  carried one, positional (`o0` upward) where it did not — and `minChoices`/`maxChoices`, how many
  a response may choose.
- For rating: `items`, each with an id (`q0` upward where the data had none), its `scale` as a list
  of `points` (a `value` and, where it has one, a `label`), an `optOut` where the scale allows one,
  `required`, and `anchors` where the item names its own ends; and `comment` when the survey asks
  for one.

The compiler is the only check there is on any of it: nothing enforces the rules at delivery,
because there is no delivery.

## There is no flow

L0182 does not describe screens, steps, ordering, navigation or submission. It does not hold a
pool and does not aggregate anything across respondents. A program is one taking of one survey
and at most one response to it.

The code IS the interface: a person edits the program in the console, an agent edits it through
`update_item`, and both produce the same record. The renderer shows the survey as it was drawn
beside what came back.

## Functions

Every word L0182 adds to the base language. All are arity 1.

| Word         | Signature          | Arity | Meaning                                                                                                                                                                                                                                                                                                                                                                                       |
| :----------- | :----------------- | :---: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `<string: record>` |   1   | The survey being taken, e.g. id "civic-priorities". The options, the wording and the bounds all come from the survey itself — the program names it and nothing more. An id naming one version outright (id "civic-priorities-7") takes that version rather than drawing one.                                                                                                                  |
| `session-id` | `<string: record>` |   1   | One taking of a survey. Write it exactly as `session-id get-val-public "itemId"` — it is what keeps a response with the version of the survey it answers.                                                                                                                                                                                                                                     |
| `choices`    | `<list: record>`   |   1   | The options chosen, in priority order — the order IS the ranking, first is most important. Name each one by its exact text: choices ["clean air and water" "affordable housing"]. An id in quotes works too, and a bare whole number is a position counting from 0 — but reach for those only when you can see the set, because a wrong position records the wrong option and still compiles. |
| `write-in`   | `<string: record>` |   1   | One new option, contributed by whoever answered. It must not repeat an option already in the set — that is what makes it new.                                                                                                                                                                                                                                                                 |
| `ratings`    | `<list: record>`   |   1   | The answers to a rating survey, one [item … rating …] list per item: ratings [[item "The course met its goals" rating "Agree"] [item "How likely are you to recommend us?" rating 9]].                                                                                                                                                                                                        |
| `item`       | `<any: record>`    |   1   | Which item a rating answers. Name it by its exact text; an id in quotes, or a whole-number position counting from 0, work too once you can see the survey.                                                                                                                                                                                                                                    |
| `rating`     | `<any: record>`    |   1   | The answer on the item's scale: a point's label ("Agree", "Very satisfied"), or the scale's own value as a number (9 on a 0–10 scale is 9 — never a position). An item with its own end words takes those too, and a scale with an opt-out takes its words ("Not applicable").                                                                                                                |
| `comment`    | `<string: record>` |   1   | Free text alongside a rating survey's answers, where the survey asks for a comment.                                                                                                                                                                                                                                                                                                           |
| `survey`     | `<list: record>`   |   1   | The survey being taken, and optionally the response to it. What the survey asks — options or items, wording, bounds, scales — comes from the survey, not from the program.                                                                                                                                                                                                                    |
| `response`   | `<list: record>`   |   1   | The answer. To a ranked-choice survey: `choices` in priority order and optionally one `write-in`. To a rating survey: `ratings`, one per item, and a `comment` where the survey asks for one.                                                                                                                                                                                                 |

## A full example

```
survey [
  id "course-feedback"
  session-id get-val-public "itemId"
  response [
    ratings [
      [item "The course met its stated goals" rating "Agree"]
      [item "The pace of the course was right for me" rating "Neither agree nor disagree"]
      [item "The course materials were clear" rating "Strongly agree"]
      [item "Feedback on my work was timely and useful" rating "Disagree"]
      [item "The lab sessions helped me apply what I learned" rating "Not applicable"]
      [item "Using the course portal was" rating 5]
      [item "How likely are you to recommend this course to a colleague?" rating 9]
    ]
    comment "More worked examples before each lab would help."
  ]
]..
```

Note what is NOT here: no items, no scales, no title, no instructions, no bounds. Writing any of
them is a compile error, because none of them is the program's to say.
