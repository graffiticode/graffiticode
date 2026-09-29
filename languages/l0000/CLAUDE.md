# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo shape

npm workspaces monorepo. Node `>=22`, npm `10.9.2`, ESM throughout (`"type": "module"`), TypeScript with `NodeNext` resolution (extends `tsconfig.base.json`). Three packages:

- `packages/core` (`@graffiticode/l0000`) — publishable language core: compiler, lexicon, JSON Form spec.
- `packages/api` (`@graffiticode/api-l0000`) — Express language server. Mounts `/compile`, `/form`, and the public static assets.
- `packages/view` (`@graffiticode/l0000-view`) — React View harness (library) + the embeddable `/form` bundle.

## Commands

Run from repo root:

```bash
npm run build      # core (tsc) → core static → api (tsc) → view (vite lib) → view embed (vite) → assemble
npm run dev        # api in watch mode (tsx) against local emulators — see "Dev environment"
npm start          # run built api server
npm test           # core tests (vitest run) — builds core first
npm run lint       # eslint across workspace
npm run lint:fix
npm run format     # prettier --write .
```

The `assemble` step copies `packages/core/dist/static/` and `packages/view/dist-embed/` into `packages/api/static/`. The API serves everything from that directory unauthenticated.

Per-package scripts (use `npm run -w packages/<name> <script>`):
- core: `build`, `build-static`, `test`, `lint`
- api: `build`, `dev`, `start`, `lint`
- view: `build` (lib), `build:embed` (the `/form` bundle), `dev` (vite on the embed entry), `preview`, `lint`

Single test: `npm run -w packages/core test -- -t "<pattern>"` (forwards to vitest). Core's `test` script runs `npm run build && vitest run`, so source changes are picked up only via the build — when iterating on `compiler.ts`, run `npx vitest -t "..."` directly inside `packages/core` and have a separate `tsc -w` running, or accept the rebuild.

## Dev environment

`npm run dev` (delegated to `packages/api`) hardcodes:
- `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`
- `AUTH_URL=http://127.0.0.1:4100` (Graffiticode auth service)

Both must be running locally or auth/static-only paths still work but `/compile` integration will be degraded.

Runtime env vars consumed elsewhere:
- `PORT` (default `50000`)
- `GRAFFITICODE_API_URL` — base for cross-language schema fetches in `core/src/schema-validator.ts` (default `https://api.graffiticode.org`)
- `GRAFFITICODE_SECRET_KEY` — AES-256-CBC key for `GET_VAL_PRIVATE` decryption in `core/src/compiler.ts`

## Architecture: inheritance kernel

L0000 is the **root** of a tree of Graffiticode dialects. Child languages depend on `@graffiticode/l0000` and extend its classes — that contract is the whole point of this repo.

**Compile pipeline** (`core/src/compiler.ts`):
```
parser → nodePool (AST) → Checker.check → Transformer.transform → Renderer.render → JSON
```

- `Visitor` is pure dispatch: `this[node.tag]` lookup, with async tail-call avoidance via `setTimeout(..., 0)` unless `options.SYNC === true`. Carries no semantics.
- `Checker` and `Transformer` extend `Visitor`. Every node type is a method named after its tag (`PROG`, `ADD`, `RECORD`, `MAP`, `USE`, `DATA`, …). Methods are CPS — each takes `(node, options, resume)` and calls `resume(err, val)` exactly once. `err` is always an array (concatenated, not short-circuited) so multiple compile errors accumulate.
- `Renderer` flattens the internal Record representation to plain JSON via `deepConvertRecords`.
- `Compiler.compile(code, data, config, resume)` runs the three phases and `normalizeErrors` between each. The api server wraps this in the `{ data, errors }` envelope (`packages/api/src/compile.ts`).

A child language's core looks like:
```ts
import { Checker, Transformer, Compiler, lexicon as baseLexicon, mergeLexicon } from "@graffiticode/l0000";
class MyChecker extends Checker { HELLO(node, options, resume) { ... } }
class MyTransformer extends Transformer { HELLO(node, options, resume) { ... } }
export const lexicon = mergeLexicon(baseLexicon, { hello: { tk: 1, name: "HELLO", ... } });
new Compiler({ langID: "0001", version: "...", Checker: MyChecker, Transformer: MyTransformer });
```

The lexicon is what the parser uses to tokenize source; lexicon entries' `name` field is the AST tag the visitor dispatches on. Merging is child-over-parent, so a child word that reuses a base key silently deletes the base function from that dialect. `mergeLexicon` (`core/src/merge-lexicon.ts`) guards this: an undeclared collision throws at import, and deliberate shadowing must be listed in `{ overrides: [...] }` (a stale override that no longer collides also throws). Prefer renaming over overriding. Some children still hand-roll `{ ...baseLexicon, ... }` until converted.

## Records, keys, and arithmetic

The runtime uses a `Record` type (`{ _type: "record", _entries: Map<encodedKey, value> }`) distinct from a plain JS object. Keys are classified as `tag`, `string`, or `number` and encoded as `tag:foo` / `str:foo` / `num:0`. **`recordGet` has cross-kind fallback** — `tag` falls back to `str`, `string` falls back to `tag`. Tests in `compiler.test.ts` pin this behavior; do not change fallback semantics without updating those.

The `USE` visitor attaches a fetched schema to its returned Record via a `Symbol.for("gcSchema")` key (kept off `Object.entries` and JSON output). `DATA` reads that symbol to validate the upstream value before merging. If you add Record post-processing, preserve symbol keys.

Arithmetic uses `decimal.js`. The `Decimal` default-export normalization at the top of `compiler.ts` exists because the package is consumed as both CJS and ESM across the toolchain — don't "simplify" that import.

## `data` / `use` — cross-language composition

`use "<langId>"` fetches `${GRAFFITICODE_API_URL}/L<lang>/schema.json` at compile time, caches it 1h, and tags an empty Record with the schema. Chained with `data`, the upstream's runtime value is validated against that schema before merging. `setSchemaFetcher(fn)` lets tests swap the underlying `fetch`; `clearSchemaCache()` resets the cache. The lang id must match `/^\d{3,5}$/`.

## API server

`createApp({ authUrl })` in `packages/api/src/app.ts` constructs the Express app. Notable ordering:

1. HTTPS redirect (production, non-localhost).
2. `GET /lexicon.js` back-compat alias (see "Static asset pipeline"), then `express.static(STATIC_DIR, { index: false })` — **before** auth. Public assets (`lexicon.json`, `schema.json`, `spec.html`, `instructions.md`, `language-info.json`, `usage-guide.md`, `scope.json`, `template.gc`, and the hashed `/form` bundle assets) are unauthenticated. `index: false` keeps `GET /` as a health check.
3. Auth middleware attaches `req.auth` but does **not** reject anonymous requests.
4. Routes: `/`, `/compile`, `GET /form` (serves `static/index.html` from the assembled view embed).

`POST /compile` accepts `{ code, data, config }` and returns `{ data, errors }`. Missing `code` or `data` → 400.

## View harness

`@graffiticode/l0000-view`'s `View` is the **shared** front-end harness child languages inherit. It is parameterized by a language-specific `Form` component (`<View Form={Form} />`). L0000 ships the base JSON `Form`. The View:

- Reads `id`, `access_token`, `origin`, `data` from URL search params.
- Compiles via SWR fetchers (`packages/view/src/swr/fetchers.ts`).
- Treats responses as `{ data, errors }` envelopes — successful output replaces the form data model; errors are threaded to the Form alongside it.
- Posts state to the parent window via `postMessage` when an `origin` is provided (iframe-embed path) and announces `onload`/`data-updated`.

`packages/view/embed/main.tsx` is both the dev entry and the production bundle entry — it mounts `<View Form={Form} />` and is built by `vite.embed.config.ts` into `dist-embed/`, which is then assembled into `packages/api/static/`. The library build (`vite.config.ts`, not the embed config) emits `dist/` for consumption by child language view packages.

## Static asset pipeline

`packages/core/tools/build-static.js` emits L0000's public assets into `packages/core/dist/static/`. Note these constraints enforced by the script — don't undo them:

1. The lexicon is emitted as plain JSON in `lexicon.json` — no `lexicon.js` file. The still-deployed Graffiticode console still requests `lexicon.js`; the API server aliases that path to `lexicon.json` via an `app.get("/lexicon.js", …)` route registered before `express.static` (`packages/api/src/app.ts`). The console fetches the body, slices from the first `{`, and `JSON.parse`s it, so plain JSON works. Drop the alias route once the console migrates to `lexicon.json` (Stage 3 of the migration). Don't reintroduce the `export const` JS wrapper.
2. `language-info.json` is enriched with an `authoring_guide` extracted from the `## Overview` section of `spec/usage-guide.md`. The build fails if the section is missing or under 100 chars, or if `spec/language-info.json` already contains an `authoring_guide` key. Treat the usage guide's `## Overview` as the source of truth for the authoring guide.

## Deployment

The server ships as a single Docker image (`Dockerfile`, `node:22-alpine`) deployed to Cloud Run as service `l0000` in project `graffiticode`. The image: `npm ci` from the lockfile → `npm run build` (the full core→static→api→view→embed→assemble chain) → `npm prune --omit=dev` (runtime only runs compiled JS, so devDeps are dropped) → `npm start`. `NODE_ENV=production`, `EXPOSE 50000`.

Three root scripts drive GCP (require `gcloud` auth + project access):
- `npm run gcp:build` — `gcloud builds submit` against `cloudbuild.yaml` (docker build → push to `gcr.io/graffiticode/l0000:$COMMIT_SHA` → `gcloud run deploy`).
- `npm run gcp:deploy` — source-based `gcloud run deploy` (no explicit Cloud Build config), `--allow-unauthenticated`.
- `npm run gcp:logs` — tail the Cloud Run logs.

`cloudbuild.yaml` substitutions: `_DEPLOY_REGION=us-central1`, `_AUTH_URL=https://auth.graffiticode.org` (injected as the `AUTH_URL` env var on the deployed service). Cloud Run injects `PORT`; the server reads it (default `50000`). The service is deployed `--allow-unauthenticated` — matching the app's own "static assets and `/compile` are public" posture.

## Conventions

- SPDX `// SPDX-License-Identifier: MIT` headers on `.ts` source files.
- `@typescript-eslint/no-explicit-any` is **off** project-wide — the compiler is intentionally dynamic (index-signature dispatch, CPS callbacks). Don't introduce strict types that fight the AST dispatch pattern.
- Prettier governs formatting (`.prettierrc`).
- `dist/`, `dist-embed/`, and `packages/api/static/` are build outputs — gitignored.
