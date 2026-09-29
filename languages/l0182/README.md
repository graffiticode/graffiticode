# L0182

[![License: MIT](https://img.shields.io/badge/Code-MIT-blue.svg)](packages/LICENSE)
[![License: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-lightgrey.svg)](LICENSE-DOCS)

L0182 is a Graffiticode dialect for **taking surveys**: a program names a survey the language
server holds and records one response to it. It inherits the base vocabulary of
[@graffiticode/l0000](https://www.npmjs.com/package/@graffiticode/l0000).

A survey has one of two styles. A **ranked-choice** survey is a set of options, and a response
names the options chosen in priority order, plus at most one write-in that was not in the set:

```
survey [
  id "team-retro"
  session-id get-val-public "itemId"
  response [
    choices ["cut the build time in half" "write smaller pull requests"]
    write-in "give every service a named owner"
  ]
]..
```

A **rating** survey is a list of items, each answered on a scale — Likert agreement, frequency,
importance and satisfaction scales, NPS and star ratings, semantic differentials — and a response
rates them, opting out where a scale allows it and adding a comment where the survey asks:

```
survey [
  id "course-feedback"
  session-id get-val-public "itemId"
  response [
    ratings [
      [item "The course met its stated goals" rating "Agree"]
      [item "The pace of the course was right for me" rating "Disagree"]
      [item "The course materials were clear" rating "Agree"]
      [item "Feedback on my work was timely and useful" rating "Strongly agree"]
      [item "The lab sessions helped me apply what I learned" rating "Not applicable"]
      [item "Using the course portal was" rating 6]
      [item "How likely are you to recommend this course to a colleague?" rating 9]
    ]
    comment "More worked examples, please."
  ]
]..
```

## The survey is not authored

A program says `id "team-retro"` and nothing else about the survey. Its style, options or items,
scales, title, instructions and bounds live in one JSON file per version in
`packages/core/data/`, which the compiler reads when the program compiles; no word in the
language writes any of them, so whoever takes a survey cannot edit it.

An id that names several versions (`civic-priorities-1` … `civic-priorities-12`) draws one without
replacement; naming a version outright (`id "civic-priorities-7"`) takes exactly that one.
`session-id get-val-public "itemId"` keeps the draw stable across the turn that adds the response,
so the answer is checked against the survey its taker actually saw.

An option in `choices`, or an item in `ratings`, is named by its exact text, by its id, or by its
position counting from 0. Text is the one to use when writing a response, because whoever writes
it has not seen the ids or positions; all three resolve to ids in the compiled record. A number in
`rating`, by contrast, is the scale's own value — `9` on a 0–10 scale is 9.

## The code is the interface

There is no survey flow here: no screens, no steps, no navigation or submission, and nothing
that walks anyone through anything. A person writes the response in the console's editor; an AI
agent writes it through `update_item`. They are the same client, so both produce the identical
record, and the view only renders it — the survey as it was given, with what came back marked on
it.

If an interactive survey flow is wanted, that is a different language or a different client
reading this record.

## What L0182 does not do

It records one response. It does not draw the sample, aggregate across respondents, compute a
group ranking, an average rating or an NPS score, or analyse anything.

It also has no notion of a right answer: a survey response is never scored. For graded questions
use [L0180](https://github.com/graffiticode/l0180).

## Development

```bash
npm install
npm run build   # core → static → api → view → embed → assemble
npm test        # core + api + view
npm run dev     # API on :50182
```

`npm run -w packages/view dev` runs the renderer alone on Vite; `/dev.html` there shows every
state of it — awaiting a response, answered, a write-in with nothing chosen, an unresolvable id, a rating
survey awaiting and answered —
against fixed models, with no API behind them.

## Packages

| Package         | Name                       | Role                                                       |
| --------------- | -------------------------- | ---------------------------------------------------------- |
| `packages/core` | `@graffiticode/l0182`      | The language: lexicon, compiler, spec                      |
| `packages/api`  | `@graffiticode/api-l0182`  | Language server: `/compile`, `/form`, public static assets |
| `packages/view` | `@graffiticode/l0182-view` | The renderer                                               |

## Environment

| Variable   | Default                         | Purpose                    |
| ---------- | ------------------------------- | -------------------------- |
| `PORT`     | `50182`                         | The language server's port |
| `AUTH_URL` | `https://auth.graffiticode.org` | Token verification         |

There is no service credential and no backend to configure. Everything a program needs is in
the program.

See [CLAUDE.md](CLAUDE.md) for the design record.
