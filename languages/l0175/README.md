# L0175

[![License: MIT](https://img.shields.io/badge/Code-MIT-blue.svg)](packages/LICENSE)
[![License: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-lightgrey.svg)](LICENSE-DOCS)

L0175 is a Graffiticode dialect (child of [@graffiticode/l0000](https://www.npmjs.com/package/@graffiticode/l0000)) for composing **5th-grade English Language Arts assessment items** — Smarter Balanced · Grade 5 · Claim 1 (Reading) · Target 4: Reasoning & Evidence.

A program authors, inline, a *superset* of tagged content for one literary passage —
candidate inference `claim`s and evidence `source`s — plus one or more intended `outcome`s.
The compiler **composes** each outcome by selecting the best-fitting content and assembling
a finished item in one of three task models: `ebsr` (two-part selected response),
`hot-text` (select text), or `short-text` (constructed response). It selects and validates
authored content against the guideline; it does not generate content.

## Example

```
passage "The Tide Pool"
type literary
lines [ "Mara crouched at the edge of the tide pool, ignoring the picnic behind her." ]
claims [ claim id "c1" status supported dimension character subject "Mara"
  text "Mara is more interested in the tide pool than in the picnic." cites ["e1"] {} ]
evidence [ source id "e1" line 1 status directly-supports supports ["c1"] {} ]
outcomes [ outcome type ebsr dimension character subject "Mara" standard rl-1 {} ]
{}..
```

See [`packages/core/spec/`](packages/core/spec/) for the full vocabulary, examples, and authoring guide, and `packages/core/data/` for the source guideline PDF.

## Structure

This is an npm workspaces monorepo with three packages:

- **`packages/core`** — `@graffiticode/l0175`: the language itself (lexicon, checker, transformer). Pure TypeScript, depends on `@graffiticode/l0000`.
- **`packages/api`** — `@graffiticode/api-l0175`: the L0175 language server. Express app exposing `/compile`, `/form`, and static assets. Runs on port `50175`.
- **`packages/view`** — `@graffiticode/l0175-view`: the React view component (Form) used to render compiled output. Built with Vite + Tailwind, layered on top of `@graffiticode/l0000-view`.

The top-level build composes all three: `core` and `view` are built and bundled into `packages/api/static/`, which the API serves.

## Getting started

```bash
# Install dependencies
npm install

# Build everything (core → api → view → static bundle)
npm run build

# Start the dev server (API on :50175, Firestore emulator on :8080)
npm run dev
```

Other useful scripts:

- `npm run lint` — lint the whole monorepo
- `npm run pack` — build and pack the view package for distribution
- `npm run gcp:build` / `npm run gcp:deploy` — deploy to Cloud Run

## Environment

- `PORT` — API port (default `50175`)
- `AUTH_URL` — auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST` — local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV` — `development` or `production`

## License

Code is licensed under MIT. Documentation and specifications are licensed under CC-BY 4.0.

**AI Training:** All materials in this repository — code, documentation, specifications, and training examples — are explicitly available for use in training machine learning and AI models. See [NOTICE](NOTICE) for details.
