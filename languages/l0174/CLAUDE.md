# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Two implementations live here.** `crates/` is L0174 in Rust, which production runs (`l0174r`, since 2026-10-30); `packages/` is the TypeScript L0174, still deployed as `l0174` (min 0) as the switch's rollback target, and still the source of the static assets and the conformance fixtures. Everything down to "The Rust implementation" describes the TypeScript side.

## Commands

### Development
- **Start dev server**: `npm run dev` (starts API server on port 50174; expects Firestore emulator at 127.0.0.1:8080 and local auth at 127.0.0.1:4100)
- **Build project**: `npm run build` (builds `core` → `api` → `view`, then assembles static bundle into `packages/api/static/`)
- **Start production**: `npm run start` (runs the built API server)

### Linting
- **Lint repo**: `npm run lint` (ESLint over the whole monorepo)
- **Lint a package**: `npm -w packages/<core|api|view> run lint`
- **Fix lint errors**: `npm run lint:fix` (or `:fix` on a workspace script)
- **Format**: `npm run format` (Prettier across the repo)

### Package Management
- **Build and pack**: `npm run pack` (builds, then packs `packages/view`)
- **Publish**: `npm run publish` (publishes `@graffiticode/l0174` and `@graffiticode/l0174-view` with public access)

### Testing
Vitest is installed at the root but no test runner script is wired up yet, and no `*.spec.*` files exist in the packages.

### Deployment
- **Release**: `npm run deploy -- l0174` from the graffiticode repository root (deploy CLI; entry in root `deploy.json`, image from `configs/Dockerfile.l0174.yaml`, runtime `l0174-run`). It tests, builds, deploys a no-traffic candidate, checks `/` and `/lexicon.json`, then promotes.
- **View logs**: `npm run gcp:logs`

## Architecture

L0174 is a Graffiticode dialect — the first child of `@graffiticode/l0000`. It's an npm-workspaces monorepo with three packages.

### Structure

- **`packages/core/`** — `@graffiticode/l0174`: the language itself. Pure TypeScript.
  - `src/lexicon.ts`: merges L0000's base lexicon with L0174's additions (`hello`, `image`, `theme`, `id`, plus `DARK`/`LIGHT` tags)
  - `src/compiler.ts`: `Checker` and `Transformer` classes extending L0000's, adding handlers for the L0174 vocabulary
  - `spec/`: language documentation, examples, schema, RAG training prompts, etc.
  - `tools/build-static.js`: copies spec content into `dist/static/` for the API to serve

- **`packages/api/`** — `@graffiticode/api-l0174`: Express language server. TypeScript, run via `tsx` in dev and compiled to `dist/` for prod.
  - Routes (`src/routes/`): `compile`, `auth`, `root` (`/form`), plus `index` and shared `utils`
  - Auth integration with `@graffiticode/auth`
  - Port: 50174 (dev) or `process.env.PORT`

- **`packages/view/`** — `@graffiticode/l0174-view`: React view component. Vite + TypeScript + Tailwind.
  - `src/components/form/Form.tsx`: language-specific form rendering
  - `src/components/form/ThemeToggle.tsx`: dark/light toggle wired up by the `theme` function
  - `embed/`: standalone HTML entry built by `vite.embed.config.ts` for embedding in the API's static bundle
  - Built on top of `@graffiticode/l0000-view`

### Build pipeline

`npm run build` composes the packages in order:
1. `core` compiles TypeScript and copies spec content to `core/dist/static/`
2. `api` compiles TypeScript to `api/dist/`
3. `view` builds both the library (`dist/`) and the embed bundle (`dist-embed/`)
4. `assemble` clears `packages/api/static/` and copies `core/dist/static/` + `view/dist-embed/` into it — this is what the API serves

### Language Functions

L0174 inherits the full L0000 base vocabulary (arithmetic, lists, lambdas, `map`/`filter`/`reduce`, pattern matching, tags) and adds:

| Function | Arity | Description |
|----------|:-----:|-------------|
| `hello`  | 1 | Renders `hello, {string}!` |
| `image`  | 1 | Renders an image at the given URL |
| `theme`  | 2 | Wraps a UI expression in a theme (`DARK` or `LIGHT`) with a toggle button |
| `id`     | 2 | Tags an expression with a stable identifier |

The `Checker` validates that `theme`'s first argument is the `DARK` or `LIGHT` tag; unhandled tags fall through to L0000's base handlers via the shared Visitor dispatch.

### Data Flow

```
User Input → State Update → POST /compile → Compiler (core) → Output Data → Form (view) → postMessage to parent
```

The embedded form supports iframe embedding and communicates with parent windows via postMessage.

### Environment Variables
- `PORT`: API port (default 50174)
- `AUTH_URL`: Auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST`: Local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV`: `development` or `production`

### Dependencies
- `@graffiticode/l0000` (published) — base language, inherited by `core`
- `@graffiticode/l0000-view` (published) — base view, inherited by `view`
- `@graffiticode/auth` — auth service client used by `api`

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0174**. `packages/core` and `packages/api` are the TypeScript compiler and server (Cloud Run service `l0174`, min 0, kept as the switch's rollback target). `crates/` is the same language in Rust, released to its own service `l0174r`, which production runs: the api routes L0174 there (`BASE_URL_L0174`, interpreter plan A1, 2026-10-30, with the `upstream-envelope` rule: the posted state an envelope delivers is laid over the form at the top level; evidence in `docs/evidence/track-a-batch-l0174-l0175-l0183/`). `packages/view` and the spec are shared by both.

- `crates/core` (`graffiticode-l0174`) — the whole dialect, in `src/lib.rs`: `L0174` implements `Dialect` from `graffiticode-l0000`. Two tables drive it, as in `compiler.ts`: `ATTRIBUTES` (tag → the field an arity-2 word sets) and `ELEMENTS` (tag → the type an arity-1 field word stamps). `lexicon()` is the base lexicon merged with `src/lexicon-additions.json`.
- `crates/server` (`l0174r-server`, binary `l0174r`) — `l0000r_server::serve(L0174, lexicon())`. Routes, auth and static serving live in `languages/l0000/crates/server`.
- `tools/assemble-static.mjs` — builds the static assets and `/form` bundle into `./static` for the Rust server.

**The Rust side depends on `languages/l0000` by relative path** (Cargo path dependencies on its kernel and server crates). Read "The Rust implementation" in `languages/l0000/CLAUDE.md` for how evaluation, values and the `Dialect` trait work.

```bash
cargo test            # conformance + dialect tests; needs no Node and no network
npm run rust:build    # rust:static, then cargo build --release -p l0174r-server
npm run rust:dev      # cargo run -p l0174r-server on :50174 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then regenerate tests/conformance/cases.json and src/lexicon-additions.json
```

### `min` and `max` are overridden, on purpose

This is the one dialect so far that **redefines base words**: here `min` and `max` are field-range attributes, not arithmetic. Both halves of that are explicit in the Rust:

- The lexicon merge declares them (`OVERRIDES` in `lib.rs`). `Lexicon::merge` refuses a collision that is not declared, and a declaration that no longer collides; a test pins both.
- The parser still emits the kernel's `MIN` and `MAX` tags for them, so `Dialect::overrides` claims `Op::Min` and `Op::Max` (and `Op::Prog`), and `eval` handles them as attributes. Without that claim the kernel would evaluate them as arithmetic.

`src/lexicon-additions.json` therefore holds the new words *and* the two redefined ones; the generator writes every entry that differs from the base.

### Semantics worth knowing

- An attribute or top-level word is `<word> <value> <rest>`: the rest of the chain, as a record keyed by name, with one more field. The outermost occurrence of a word wins.
- An element word stamps `type` and derives `name` from the label (`slug`), unless the attributes carry a `name` — including an empty one, which stands, as in TypeScript.
- `select` and `radio` require a non-empty `options` list; `theme` requires the tag `DARK` or `LIGHT`. Both are checked while evaluating, not in a separate pass, and reported at the word.
- The program's result, when it is a record, has the form's posted state (the upstream data) laid over it.

### Conformance

`crates/core/tests/conformance/generate.mjs` parses a corpus with L0174's TypeScript lexicon, compiles each program against two upstream inputs with `@graffiticode/l0174`, and writes `cases.json`. `tests/conformance.rs` requires identical data and identical error messages for all 90 cases. There are no divergences.

### Deploying the Rust server

`deploy.json` has an `l0174r` entry (own service, `l0174r-run@graffiticode.iam.gserviceaccount.com`, image from `configs/Dockerfile.l0174r.yaml`; snapshot is this directory and `languages/l0000`; build step `cargo test --locked`). Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later (see `languages/l0000/CLAUDE.md`). The service and account do not exist until provisioned; the account needs no roles.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored build outputs; `src/lexicon-additions.json` and `tests/conformance/cases.json` are generated, not edited.
