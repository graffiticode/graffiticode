# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **GCP Cloud Build**: `npm run gcp:build` (submits `cloudbuild.yaml` to the `graffiticode` project)
- **GCP Direct Deploy**: `npm run gcp:deploy` (deploys to Cloud Run as `l0010`, region `us-central1`, port `50010`)
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
