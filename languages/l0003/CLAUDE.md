# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Two implementations live here.** `packages/` is the TypeScript L0003 that production runs; `crates/` is L0003 in Rust, released to a separate service. Everything down to "The Rust implementation" describes the TypeScript side.

## Commands

### Development
- **Start dev server**: `npm run dev` (starts API server on port 50003; expects Firestore emulator at 127.0.0.1:8080 and local auth at 127.0.0.1:4100)
- **Build project**: `npm run build` (builds `core` → `api` → `view`, then assembles static bundle into `packages/api/static/`)
- **Start production**: `npm run start` (runs the built API server)

### Linting
- **Lint repo**: `npm run lint` (ESLint over the whole monorepo)
- **Lint a package**: `npm -w packages/<core|api|view> run lint`
- **Fix lint errors**: `npm run lint:fix` (or `:fix` on a workspace script)
- **Format**: `npm run format` (Prettier across the repo)

### Package Management
- **Build and pack**: `npm run pack` (builds, then packs `packages/view`)
- **Publish**: `npm run publish` (publishes `@graffiticode/l0003` and `@graffiticode/l0003-view` with public access)

### Testing
Vitest is installed at the root but no test runner script is wired up yet, and no `*.spec.*` files exist in the packages.

### Deployment
- **Release**: `npm run deploy -- l0003` from the graffiticode repository root (deploy CLI; entry in root `deploy.json`, image from `configs/Dockerfile.l0003.yaml`, runtime `l0003-run`). It tests, builds, deploys a no-traffic candidate, checks `/` and `/lexicon.json`, then promotes.
- **View logs**: `npm run gcp:logs`

## Architecture

L0003 is a Graffiticode dialect — the first child of `@graffiticode/l0000`. It's an npm-workspaces monorepo with three packages.

### Structure

- **`packages/core/`** — `@graffiticode/l0003`: the language itself. Pure TypeScript.
  - `src/lexicon.ts`: merges L0000's base lexicon with L0003's additions (`hello`, `image`, `theme`, `id`, plus `DARK`/`LIGHT` tags)
  - `src/compiler.ts`: `Checker` and `Transformer` classes extending L0000's, adding handlers for the L0003 vocabulary
  - `spec/`: language documentation, examples, schema, RAG training prompts, etc.
  - `tools/build-static.js`: copies spec content into `dist/static/` for the API to serve

- **`packages/api/`** — `@graffiticode/api-l0003`: Express language server. TypeScript, run via `tsx` in dev and compiled to `dist/` for prod.
  - Routes (`src/routes/`): `compile`, `auth`, `root` (`/form`), plus `index` and shared `utils`
  - Auth integration with `@graffiticode/auth`
  - Port: 50003 (dev) or `process.env.PORT`

- **`packages/view/`** — `@graffiticode/l0003-view`: React view component. Vite + TypeScript + Tailwind.
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

L0003 inherits the full L0000 base vocabulary (arithmetic, lists, lambdas, `map`/`filter`/`reduce`, pattern matching, tags) and adds:

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
- `PORT`: API port (default 50003)
- `AUTH_URL`: Auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST`: Local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV`: `development` or `production`

### Dependencies
- `@graffiticode/l0000` (published) — base language, inherited by `core`
- `@graffiticode/l0000-view` (published) — base view, inherited by `view`
- `@graffiticode/auth` — auth service client used by `api`

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0003**. `packages/core` and `packages/api` are the TypeScript compiler and server, which production runs (Cloud Run service `l0003`). `crates/` is the same language in Rust, released to its own service `l0003r` so it can be vetted and soaked before it replaces the TypeScript. `packages/view` and the spec are shared by both.

- `crates/core` (`graffiticode-l0003`) — the whole dialect, in `src/lib.rs`: `L0003` implements `Dialect` from `graffiticode-l0000`, and `lexicon()` is the base lexicon merged with `src/lexicon-additions.json`.
- `crates/server` (`l0003r-server`, binary `l0003r`) — `l0000r_server::serve(L0003, lexicon())`. Routes, auth, static serving and environment handling all live in `languages/l0000/crates/server`.
- `tools/assemble-static.mjs` — builds `packages/core`'s static assets and `packages/view`'s embed bundle and copies them into `./static`, which the Rust server serves.

**The Rust side depends on `languages/l0000` by relative path**: its kernel and server crates are Cargo path dependencies (`../../../l0000/crates/...`), and the fixture generator uses its `node_modules` for the parser. Read "The Rust implementation" in `languages/l0000/CLAUDE.md` for how evaluation, values and the `Dialect` trait work. This workspace has its own `Cargo.lock`, so after `languages/l0000`'s Rust dependencies change, run a plain `cargo build` here before a `--locked` build.

```bash
cargo test            # conformance + dialect tests; needs no Node and no network
npm run rust:build    # rust:static, then cargo build --release -p l0003r-server
npm run rust:static   # node tools/assemble-static.mjs → ./static
npm run rust:dev      # cargo run -p l0003r-server on :50003 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then regenerate tests/conformance/cases.json and src/lexicon-additions.json
```

### The dialect

`Dialect::eval` handles the four tags and overrides `PROG`; everything else is the kernel.

- `hello x` → `{ hello: x }`, `image url` → `{ image: url }`.
- `theme DARK|LIGHT body` and `id "name" body` → the label beside the body's fields. A record body keeps its fields; a tag contributes `tag`; a scalar or list goes under `value`.
- **Upstream data wins.** The form posts its state back as the task's data, so every one of these results, and any program result that is a record (`PROG`), has the upstream data laid over it. `hello` keeps an edited greeting where it stands. A result that is not a record passes through unmerged.
- `Dialect::check` requires `theme`'s first argument to be the literal tag `DARK` or `LIGHT` and `id`'s to be a literal string, for every such node reachable from the root, and points the error at the argument.

`print` needs no handler here: the kernel's is the same.

#### Conformance

`crates/core/tests/conformance/generate.mjs` parses a corpus with L0003's TypeScript lexicon (parser from `../l0000/node_modules`), compiles each program against several upstream inputs with `@graffiticode/l0003`, and writes `cases.json`. `tests/conformance.rs` requires identical data for every case and the same errors, comparing check errors up to "Got": the Rust message names what was found more clearly than TypeScript's ("the string "dark"" rather than "tag dark"). There are no other divergences.

The TypeScript L0003 depends on the published `@graffiticode/l0000` 0.8, which is older than the kernel here. The Rust dialect therefore also has what the base language gained since (exact numbers, `format-number`), and the lexicon it serves includes those words.

### Deploying the Rust server

Its own Cloud Run service, `l0003r`, public, running as `l0003r-run@graffiticode.iam.gserviceaccount.com`, released from the repository root with `npm run deploy -- l0003r` (entry in root `deploy.json`, image from `configs/Dockerfile.l0003r.yaml`). The snapshot includes this directory and `languages/l0000` (the path dependencies). The only build step is `cargo test --locked`. Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later (see `languages/l0000/CLAUDE.md`).

Nothing routes to `l0003r` by default. Send traffic with a per-user `lang-overrides/{uid}` binding for `L0003`, `BASE_URL_L0003` on the API, or by repointing `l0003.graffiticode.org`.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored build outputs; `src/lexicon-additions.json` and `tests/conformance/cases.json` are generated, not edited.
