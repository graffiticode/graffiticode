# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

This is a monorepo using npm workspaces. Six packages are workspaces (`api`, `auth`, `common`, `auth-client`, `policy`, `broker`); `packages/parser` lives in the tree but is **not** a workspace — it is consumed as the published dependency `@graffiticode/parser` (see root `package.json` `dependencies`). Edits to `packages/parser` require republishing/reinstalling to affect the other packages.

`languages/l0000` is the base language (moved in from `graffiticode/l0000` with its history). It is a **self-contained npm project**, not a root workspace: its own lockfile, `npm ci`, build, tests and Dockerfile, all run from `languages/l0000`. It publishes `@graffiticode/l0000` (`packages/core`) and `@graffiticode/l0000-view` (`packages/view`), which every language consumes from npm, and deploys the `l0000` Cloud Run service (`packages/api`): `npm run deploy -- l0000` from the repo root (deploy CLI, `configs/Dockerfile.l0000.yaml`, runtime `l0000-run`, no roles). `languages/` is excluded from root jest and from every other service's deploy snapshot, so their releases don't install or ship it; l0000's own entry swaps that exclusion for `packages`. See `languages/l0000/CLAUDE.md`. `languages/l0176` (Learnosity) moved in the same way; each language's `deploy.json` entry uses `include` so its snapshot is only its own directory and Dockerfile.

### Root-level commands
```bash
npm run emulator     # Start Firebase emulators (Firestore on 8080, Auth on 9099)
npm run api          # Run api package dev server
npm run auth         # Run auth package dev server
npm test             # Run root-level tests with Firebase emulators
npm run lint         # Lint root test/ directory
```

### Package-specific commands
```bash
# API package (packages/api)
npm run -w packages/api dev       # Dev server with emulator env vars
npm run -w packages/api test      # Tests with Firebase emulators
npm run -w packages/api lint      # Lint src/ and tools/

# Auth package (packages/auth)
npm run -w packages/auth dev      # Dev server with emulator env vars
npm run -w packages/auth test     # Tests with Firebase emulators
npm run -w packages/auth lint

# Parser package (packages/parser)
npm run -w packages/parser test   # Tests with experimental VM modules
npm run -w packages/parser lint

# Common package (packages/common)
npm run -w packages/common test
npm run -w packages/common lint

# Auth-client package (packages/auth-client)
npm run -w packages/auth-client test
npm run -w packages/auth-client lint
```

### Running a single test
```bash
NODE_OPTIONS=--experimental-vm-modules jest path/to/file.spec.js
# For packages requiring emulators:
NODE_OPTIONS=--experimental-vm-modules firebase emulators:exec "jest path/to/file.spec.js"
```
Tests are colocated as `*.spec.js` next to the source. The `api` and `auth` suites run `jest --runInBand` under `firebase emulators:exec` (they share emulator state, so they cannot run in parallel); `common` and `parser` need no emulator.

### Deployment (Google Cloud Run)

The shared workspace CLI lives in `packages/deploy`; `deploy.json` owns service configuration.

```bash
npm run deploy -- api --plan          # offline preview; no cloud calls
npm run deploy -- api                 # build, candidate check, then promotion
npm run deploy -- broker --plan
npm run deploy -- policy --plan
npm run rollback -- api --release <release-id>
npm run test:deploy
```

`gcp:<service>:build` and `gcp:<service>:deploy` are compatibility aliases to the same
complete release command. Do not chain them. Builds freeze local source, run tests in
Cloud Build, publish an image, then return control to the workspace for deployment by
digest. `--allow-dirty` explicitly permits uncommitted input. Receipts are in `.gc-deploy/`.

Read `packages/deploy/README.md` before an actual release: the target Artifact Registry,
build account, runtime identities, and existing services must be provisioned first.
Broker/policy additionally remain blocked pending `docs/capability-policy-iam-review.md`.
The CLI does not provision infrastructure, change invocation IAM, or publish packages.
The old `configs/cloudbuild.*.yaml` recipes now build only; normal releases generate their
build configuration from `deploy.json`.

## Architecture Overview

Graffiticode is a platform for compilers as a service. The system consists of:

**@graffiticode/api** - API Gateway that handles code compilation requests and task management. Routes compile requests to language-specific compilers, stores results in Firestore.

**@graffiticode/auth** - Authentication service using Sign In With Ethereum (SIWE). Issues JWT access tokens and refresh tokens. Validates Ethereum signatures for user authentication.

**@graffiticode/auth-client** - Client library for authenticating with the auth service.

**@graffiticode/parser** - Core parser that converts Graffiticode language syntax into ASTs. Used by the API for parsing user code before compilation.

**@graffiticode/common** - Shared utilities: error handling, HTTP helpers, parser utilities.

### The task/compile domain model (read this before touching the API)

A **task** is `{ lang, code }`. Posting a task hashes it to a stable `id` and stores it (`POST /task` → `{ id }`; `POST /tasks` for batches). Compiles map a task `id` to data and are **idempotent and cached** — a given `id` always yields the same data.

Tasks compose into **pipelines** written as `id0+id1+id2`, compiled **right to left**: the tail's output `data` is fed as input `data` to the next task left of it. The ultimate head is often the live client form state, forming a compiler(Controller)→data(Model)→form(View) loop.

Two compile entry points in the API:
- `GET /data?id=<taskID>` — resolves a taskID (possibly a pipeline) to data.
- `POST /compile { id, data }` — creates a task from `data`, prepends it to `id`, and delegates to the `GET /data` handler.

The API does not compile code itself: for each task it resolves the language's base URL and delegates to that language server's own `POST /compile { code, data }`, which returns `{ status, data | error }`.

### Language-server dispatch

Languages are external HTTP compilers (e.g. `L0002`, `L0166`), referenced by numeric id (`0002`) or `L`-prefixed. `packages/api/src/lang/base-url.js` resolves a language's base URL in this precedence order:
1. **Per-user override** (`getOverrideBaseUrl({ uid, lang })`) — pins one tester to a specific language-server revision; overrides are memoized with a short TTL and managed via the `lang-override` route/storage.
2. `BASE_URL_<LANG>` **env var** (e.g. `BASE_URL_L0002`).
3. **Config** host/port (`localhost` → `http`, otherwise `https`).

`packages/api/src/lang/` also handles asset fetching (`get-asset.js`, 404 on missing asset) and health checks (`ping-lang.js`). Routes are assembled in `packages/api/src/routes/index.js`; the `/form` route serves language front-end forms.

### Auth service

`@graffiticode/auth` supports **Sign In With Ethereum (SIWE)** for interactive login and **API keys + OAuth** for programmatic access (see `packages/auth/src/routes/` and `services/`). It issues JWT access tokens + refresh tokens; the API validates these against `AUTH_URL`.

### Key Integration Points

- API validates JWT tokens against auth service (`AUTH_URL` env var; local default `http://127.0.0.1:4100`).
- API dev server runs on port 3100, auth on 4100, the console client on 3000.
- Parser integrates with language lexicons loaded from API's lang module.
- All server packages use Firebase Admin SDK; development uses Firebase emulators (Firestore 8080, Auth 9099). Firestore access rules live in `firestore.rules`; indexes in `firestore.indexes.json`.
- Tests require the `--experimental-vm-modules` flag for ES module support.

## Code Style

ESLint config enforces:
- Double quotes, semicolons required
- ES modules only (no CommonJS)
- Import extensions required (`.js`)
- Standard style guide base
