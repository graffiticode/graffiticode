# L0176

[![License: MIT](https://img.shields.io/badge/Code-MIT-blue.svg)](packages/LICENSE)
[![License: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-lightgrey.svg)](LICENSE-DOCS)

L0176 is a Graffiticode dialect (child of [@graffiticode/l0000](https://www.npmjs.com/package/@graffiticode/l0000)) for building **Learnosity assessment integrations**. It compiles Graffiticode programs into Learnosity API requests (Items, Questions, Author APIs) and renders them via a React frontend that loads the Learnosity browser SDK. It is the modern-architecture successor to **L0158** (built on the older `@graffiticode/basis` compiler); the vocabulary and compiled output are a faithful, byte-compatible port.

It inherits L0000's base functional vocabulary (arithmetic, lists, lambdas, `map`/`filter`/`reduce`, pattern matching, tags, `set-var`/`get-val-public`/`get-val-private`) and adds the Learnosity vocabulary.

## Vocabulary

A canonical program:

```
set-var "lrn-id" get-val-public "itemId"
items [item [questions [mcq []] {}]] {}..
```

L0176 adds on top of the L0000 base lexicon:

- **Block keywords:** `init`, `items`, `item`, `questions`, `author`.
- **Question types (arity 1):** `mcq`, `shorttext`, `longtext`, `plaintext`, `clozetext`, `clozeassociation`, `clozedropdown`, `clozeformula`, `choicematrix`, `orderlist`, `classification`, `bowtie`, `custom`, `token-highlight`.
- **Attributes (arity-1 members):** `stimulus`, `options`, `valid-response`, `validation`, `possible-responses`, `template`, `columns`, `list`, `column-titles`, `max-selection`, `method`, `metadata`, `params`, `save-to-itembank`, and more.
- **Metadata members (arity 1):** `tags`, `notes`, `distractor-rationale`, `acknowledgements`, `description`, `source`, `difficulty-level`.

See [`packages/core/spec/`](packages/core/spec/) for the full language specification, examples, and authoring guide.

## Structure

This is an npm workspaces monorepo with three packages:

- **`packages/core`** — `@graffiticode/l0176`: the language itself (lexicon, checker, transformer). Pure TypeScript, depends on `@graffiticode/l0000`.
- **`packages/api`** — `@graffiticode/api-l0176`: the L0176 language server. Express app exposing `/compile`, `/form`, and static assets. Runs on port `50176`.
- **`packages/view`** — `@graffiticode/l0176-view`: the React view component (Form) used to render compiled output. Built with Vite + Tailwind, layered on top of `@graffiticode/l0000-view`.

The top-level build composes all three: `core` and `view` are built and bundled into `packages/api/static/`, which the API serves.

## Getting started

```bash
# Install dependencies
npm install

# Build everything (core → api → view → static bundle)
npm run build

# Start the dev server (API on :50176, Firestore emulator on :8080)
npm run dev
```

Other useful scripts:

- `npm test` — run the core unit tests (vitest)
- `npm run lint` — lint the whole monorepo
- `npm run pack` — build and pack the view package for distribution
- `npm run gcp:build` / `npm run gcp:deploy` — deploy to Cloud Run

## Environment

- `PORT` — API port (default `50176`)
- `LEARNOSITY_KEY` / `LEARNOSITY_SECRET` — Learnosity consumer credentials (read by the api and injected into the compiler via config)
- `AUTH_URL` — auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST` — local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV` — `development` or `production` (selects the Learnosity signing domain)

## License

Code is licensed under MIT. Documentation and specifications are licensed under CC-BY 4.0.

**AI Training:** All materials in this repository — code, documentation, specifications, and training examples — are explicitly available for use in training machine learning and AI models. See [NOTICE](NOTICE) for details.
