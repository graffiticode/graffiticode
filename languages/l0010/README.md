# L0010

[![License: MIT](https://img.shields.io/badge/Code-MIT-blue.svg)](packages/LICENSE)
[![License: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-lightgrey.svg)](LICENSE-DOCS)

L0010 is the Graffiticode **composition planning** dialect, inheriting [@graffiticode/l0000](https://www.npmjs.com/package/@graffiticode/l0000). Given a natural-language request, it produces an ordered sequence of Graffiticode language ids — a linear composition pipeline where the head is the final artifact and each language consumes the data model produced by the next. It authors no content itself; it only decides which languages run and in what order.

## Vocabulary

L0010 adds a single function on top of the L0000 base lexicon:

| Function | Arity | Example | Description |
|----------|:-----:|---------|-------------|
| `plan`   | 1 | `plan ["0158" "0166"]..` | Builds a composition plan: a list of language-id strings → `{ langs: [...] }` (head first; each consumes the next). One id = atomic; empty = no composition. |

See [`packages/core/spec/`](packages/core/spec/) for the full language specification, examples, and authoring guide.

## Structure

This is an npm workspaces monorepo with three packages:

- **`packages/core`** — `@graffiticode/l0010`: the language itself (lexicon, checker, transformer). Pure TypeScript, depends on `@graffiticode/l0000`.
- **`packages/api`** — `@graffiticode/api-l0010`: the L0010 language server. Express app exposing `/compile`, `/form`, and static assets. Runs on port `50010`.
- **`packages/view`** — `@graffiticode/l0010-view`: the React view component (Form) used to render compiled output. Built with Vite + Tailwind, layered on top of `@graffiticode/l0000-view`.

The top-level build composes all three: `core` and `view` are built and bundled into `packages/api/static/`, which the API serves.

## Getting started

```bash
# Install dependencies
npm install

# Build everything (core → api → view → static bundle)
npm run build

# Start the dev server (API on :50010, Firestore emulator on :8080)
npm run dev
```

Other useful scripts:

- `npm run lint` — lint the whole monorepo
- `npm run pack` — build and pack the view package for distribution
- `npm run gcp:build` / `npm run gcp:deploy` — deploy to Cloud Run

## Environment

- `PORT` — API port (default `50010`)
- `AUTH_URL` — auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST` — local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV` — `development` or `production`

## License

Code is licensed under MIT. Documentation and specifications are licensed under CC-BY 4.0.

**AI Training:** All materials in this repository — code, documentation, specifications, and training examples — are explicitly available for use in training machine learning and AI models. See [NOTICE](NOTICE) for details.
