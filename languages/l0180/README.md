# L0180

[![License: MIT](https://img.shields.io/badge/Code-MIT-blue.svg)](packages/LICENSE)
[![License: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-lightgrey.svg)](LICENSE-DOCS)

L0180 is a Graffiticode dialect for **web-based assessment delivery** — quizzes, tests and practice questions that render and score in a browser, with no assessment platform behind them. It inherits the base vocabulary of [@graffiticode/l0000](https://www.npmjs.com/package/@graffiticode/l0000) and adds assessment-item authoring on top.

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

A program compiles to two siblings:

- **`interaction`** — everything the candidate sees. Safe to send to a browser.
- **`validation`** — the answer key and the points available.

Keeping them apart is what lets a graded delivery withhold the key and score on the server, while a practice item ships both and marks itself as the learner answers.

## Vocabulary

| Function | Arity | Description |
|----------|:-----:|-------------|
| `choice`  | 1 | A choice interaction: a stem and options to select from |
| `options` | 2 | The options offered, each an attribute list, plus a configuration record |
| `prompt`  | 1 | The question stem |
| `text`    | 1 | An option's visible text |
| `id`      | 1 | An option's identifier. Derived as A, B, C… when omitted |
| `assess`  | 1 | Scoring for an option. Its presence turns scoring on |
| `correct` | 0 | Marks an option as a right answer. Takes no value |
| `points`  | 1 | What an option is worth. Defaults to 1 with `correct`; negative penalizes |
| `shuffle` | 1 | Present the list in random order. Defaults to true |
| `min-choices` / `max-choices` | 1 | Selection limits. `max-choices` above 1 is multi-select |

Weighted answers, partial credit and penalized distractors all live in `assess`:

```
options [
  [ text "Mercury" assess [ correct points 2 ] ]
  [ text "Venus" ]
  [ text "The Moon" assess [ points -1 ] ]
] {}
```

The maximum sums only the `correct` options, so a penalty can never move the ceiling.

See [`packages/core/spec/`](packages/core/spec/) for the full language specification, examples, and authoring guide.

## Structure

This is an npm workspaces monorepo with three packages:

- **`packages/core`** — `@graffiticode/l0180`: the language itself (lexicon, checker, transformer). Pure TypeScript, depends on `@graffiticode/l0000`.
- **`packages/api`** — `@graffiticode/api-l0180`: the L0180 language server. Express app exposing `/compile`, `/form`, and static assets. Runs on port `50180`.
- **`packages/view`** — `@graffiticode/l0180-view`: the native React item renderers and the scorer. Built with Vite + Tailwind, layered on top of `@graffiticode/l0000-view`. The scorer is published on its own subpath and is free of React and the DOM, so it can also run server-side.

The top-level build composes all three: `core` and `view` are built and bundled into `packages/api/static/`, which the API serves.

## Getting started

```bash
# Install dependencies
npm install

# Build everything (core → api → view → static bundle)
npm run build

# Start the dev server (API on :50180, Firestore emulator on :8080)
npm run dev
```

Other useful scripts:

- `npm test` — run the core and view test suites
- `npm run lint` — lint the whole monorepo
- `npm run pack` — build and pack the view package for distribution
- `npm run gcp:build` / `npm run gcp:deploy` — deploy to Cloud Run

## Environment

- `PORT` — API port (default `50180`)
- `AUTH_URL` — auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST` — local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV` — `development` or `production`

## License

Code is licensed under MIT. Documentation and specifications are licensed under CC-BY 4.0.

**AI Training:** All materials in this repository — code, documentation, specifications, and training examples — are explicitly available for use in training machine learning and AI models. See [NOTICE](NOTICE) for details.
