# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Two implementations live here.** `packages/` is the TypeScript L0010 that production runs; `crates/` is L0010 in Rust, released to a separate service. Everything down to "The Rust implementation" describes the TypeScript side.

## Commands

### Development
- **Start dev server**: `npm run dev` (starts API server on port 50010; expects Firestore emulator at 127.0.0.1:8080 and local auth at 127.0.0.1:4100)
- **Build project**: `npm run build` (builds `core` → `api` → `view`, then assembles static bundle into `packages/api/static/`)
- **Start production**: `npm run start` (runs the built API server)

### Linting
- **Lint repo**: `npm run lint` (ESLint over the whole monorepo)
- **Lint a package**: `npm -w packages/<core|api|view> run lint`
- **Fix lint errors**: `npm run lint:fix` (or `:fix` on a workspace script)
- **Format**: `npm run format` (Prettier across the repo)

### Package Management
- **Build and pack**: `npm run pack` (builds, then packs `packages/view`)
- **Publish**: `npm run publish` (publishes `@graffiticode/l0010` and `@graffiticode/l0010-view` with public access)

### Testing
Vitest is installed at the root but no test runner script is wired up yet, and no `*.spec.*` files exist in the packages.

### Deployment
- **Release**: `npm run deploy -- l0010` from the graffiticode repository root (deploy CLI; entry in root `deploy.json`, image from `configs/Dockerfile.l0010.yaml`, runtime `l0010-run`). It tests, builds, deploys a no-traffic candidate, checks `/` and `/lexicon.json`, then promotes.
- **View logs**: `npm run gcp:logs`

## Architecture

L0010 is the Graffiticode **composition planning** dialect, inheriting `@graffiticode/l0000`. It maps a request to an ordered language sequence (`plan [...]` → `{ langs: [...] }`). It's an npm-workspaces monorepo with three packages.

### Structure

- **`packages/core/`** — `@graffiticode/l0010`: the language itself. Pure TypeScript.
  - `src/lexicon.ts`: merges L0000's base lexicon with L0010's single addition (`plan`)
  - `src/compiler.ts`: `Checker` and `Transformer` classes extending L0000's, adding the `PLAN` handlers (validate ids / build `{ langs }`)
  - `spec/`: language documentation, examples, schema, RAG training prompts, etc.
  - `tools/build-static.js`: copies spec content into `dist/static/` for the API to serve

- **`packages/api/`** — `@graffiticode/api-l0010`: Express language server. TypeScript, run via `tsx` in dev and compiled to `dist/` for prod.
  - Routes (`src/routes/`): `compile`, `auth`, `root` (`/form`), plus `index` and shared `utils`
  - Auth integration with `@graffiticode/auth`
  - Port: 50010 (dev) or `process.env.PORT`

- **`packages/view/`** — `@graffiticode/l0010-view`: React view component. Vite + TypeScript + Tailwind.
  - `src/components/form/Form.tsx`: renders the compiled plan (`{ langs }`) as an ordered pipeline
  - `embed/`: standalone HTML entry built by `vite.embed.config.ts` for embedding in the API's static bundle
  - Built on top of `@graffiticode/l0000-view`

### Build pipeline

`npm run build` composes the packages in order:
1. `core` compiles TypeScript and copies spec content to `core/dist/static/`
2. `api` compiles TypeScript to `api/dist/`
3. `view` builds both the library (`dist/`) and the embed bundle (`dist-embed/`)
4. `assemble` clears `packages/api/static/` and copies `core/dist/static/` + `view/dist-embed/` into it — this is what the API serves

### Language Functions

L0010 inherits the L0000 base vocabulary and adds a single function:

| Function | Arity | Description |
|----------|:-----:|-------------|
| `plan`   | 1 | Takes a list of language-id strings → `{ langs: [...] }` (head first; each consumes the next). One id = atomic; empty = no composition. |

The `Checker` validates that every element is a language id (`^\d{3,5}$`), rejects duplicates, and caps the sequence at 4; the `Transformer` evaluates the list to `{ langs }`. Base `PROG` returns that as the program's data.

### Data Flow

```
User Input → State Update → POST /compile → Compiler (core) → Output Data → Form (view) → postMessage to parent
```

The embedded form supports iframe embedding and communicates with parent windows via postMessage.

### Environment Variables
- `PORT`: API port (default 50010)
- `AUTH_URL`: Auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST`: Local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV`: `development` or `production`

### Dependencies
- `@graffiticode/l0000` (published) — base language, inherited by `core`
- `@graffiticode/l0000-view` (published) — base view, inherited by `view`
- `@graffiticode/auth` — auth service client used by `api`

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0010**. `packages/core` and `packages/api` are the TypeScript compiler and server, which production runs (Cloud Run service `l0010`). `crates/` is the same language in Rust, released to its own service `l0010r` so it can be vetted and soaked before it replaces the TypeScript. `packages/view` and the spec are shared by both.

- `crates/core` (`graffiticode-l0010`) — the whole dialect, in `src/lib.rs`: `L0010` implements `Dialect` from `graffiticode-l0000`, and `lexicon()` is the base lexicon merged with `src/lexicon-additions.json`.
- `crates/server` (`l0010r-server`, binary `l0010r`) — `l0000r_server::serve(L0010, lexicon())`. Routes, auth, static serving and environment handling all live in `languages/l0000/crates/server`.
- `tools/assemble-static.mjs` — builds `packages/core`'s static assets and `packages/view`'s embed bundle and copies them into `./static`, which the Rust server serves.

**The Rust side depends on `languages/l0000` by relative path**: its kernel and server crates are Cargo path dependencies (`../../../l0000/crates/...`), and the fixture generator uses its `node_modules` for the parser. Read "The Rust implementation" in `languages/l0000/CLAUDE.md` for how evaluation, values and the `Dialect` trait work. This workspace has its own `Cargo.lock`, so after `languages/l0000`'s Rust dependencies change, run a plain `cargo build` here before a `--locked` build.

```bash
cargo test            # conformance + dialect tests; needs no Node and no network
npm run rust:build    # rust:static, then cargo build --release -p l0010r-server
npm run rust:static   # node tools/assemble-static.mjs → ./static
npm run rust:dev      # cargo run -p l0010r-server on :50010 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then regenerate tests/conformance/cases.json and src/lexicon-additions.json
```

### The dialect

`plan <list>` evaluates to `{ langs: [...] }`: the ordered languages a request is composed from, head first, each consuming the next. One id is an atomic plan; an empty list is no composition. Upstream data is not merged into it, and there is no `PROG` override.

`Dialect::check` is where a plan is validated, before anything runs, for every `PLAN` node reachable from the root. A plan must be **written out**: a list whose elements are literal language-id strings (three to five digits, `is_language_id`), none twice, at most `MAX_STAGES` (4). A bad plan is rejected rather than trimmed, and each error points at the offending element. A `let`-bound list or string is fine, because the parser inlines it; a computed list (`concat`, a parenthesized list) is rejected.

#### Conformance

`crates/core/tests/conformance/generate.mjs` parses a corpus with L0010's TypeScript lexicon (parser from `../l0000/node_modules`), compiles each program with `@graffiticode/l0010`, and writes `cases.json`. `tests/conformance.rs` requires identical data and identical errors for every case. One deliberate difference is listed in its `divergence` function: TypeScript accepts `plan 158` and evaluates it to an empty plan; here a plan that is not a list is rejected, as `plan "0158"` already is on both sides.

The TypeScript L0010 depends on the published `@graffiticode/l0000` 0.8, which is older than the kernel here, so the Rust dialect also has what the base language gained since (exact numbers, `format-number`).

### Deploying the Rust server

Its own Cloud Run service, `l0010r`, public, running as `l0010r-run@graffiticode.iam.gserviceaccount.com`, released from the repository root with `npm run deploy -- l0010r` (entry in root `deploy.json`, image from `configs/Dockerfile.l0010r.yaml`). The snapshot includes this directory and `languages/l0000` (the path dependencies). The only build step is `cargo test --locked`. Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later (see `languages/l0000/CLAUDE.md`).

Nothing routes to `l0010r` by default. Send traffic with a per-user `lang-overrides/{uid}` binding for `L0010`, `BASE_URL_L0010` on the API, or by repointing `l0010.graffiticode.org`.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored build outputs; `src/lexicon-additions.json` and `tests/conformance/cases.json` are generated, not edited.
