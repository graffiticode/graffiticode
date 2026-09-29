# L0000

The root Graffiticode language: base compiler, lexicon, and inheritance contract that child languages extend.

## Packages

This is an npm workspaces monorepo with three packages:

- **`packages/core`** (`@graffiticode/l0000`) — the language core: compiler, lexicon, and JSON Form spec. Publishable; consumed by child languages.
- **`packages/api`** (`@graffiticode/api-l0000`) — the language server. Runs the core and serves `/compile`, `/form`, and public static assets via Express.
- **`packages/view`** (`@graffiticode/l0000-view`) — the shared View harness (React) inherited by child languages, plus the base JSON Form renderer.

## Requirements

- Node.js `>=22` (see `.nvmrc`)
- npm 10.9.2 (declared via `packageManager`)

## Setup

```bash
npm install
```

## Common scripts

Run from the repo root:

```bash
npm run build     # build core, api, view, embed bundle, then assemble static assets into api/static
npm run dev       # run the api server in watch mode (against the local firestore + auth emulators)
npm start         # run the built api server
npm test          # run core tests (vitest)
npm run lint      # eslint across the workspace
npm run format    # prettier write
```

The `assemble` step (run as part of `build`) copies `packages/core/dist/static/` and `packages/view/dist-embed/` into `packages/api/static/` so the api can serve them.

## Local dev environment

`npm run dev` expects:

- Firestore emulator at `127.0.0.1:8080`
- Graffiticode auth service at `http://127.0.0.1:4100`

Both are wired in via env vars in the `dev` script in `packages/api/package.json`.

## Docker

A `Dockerfile` is provided for building a production image of the api server.
