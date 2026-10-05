# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- **Start dev server**: `npm run dev` (starts API server on port 50175; expects Firestore emulator at 127.0.0.1:8080 and local auth at 127.0.0.1:4100)
- **Build project**: `npm run build` (builds `core` → `api` → `view`, then assembles static bundle into `packages/api/static/`)
- **Start production**: `npm run start` (runs the built API server)

### Linting
- **Lint repo**: `npm run lint` (ESLint over the whole monorepo)
- **Lint a package**: `npm -w packages/<core|api|view> run lint`
- **Fix lint errors**: `npm run lint:fix` (or `:fix` on a workspace script)
- **Format**: `npm run format` (Prettier across the repo)

### Package Management
- **Build and pack**: `npm run pack` (builds, then packs `packages/view`)
- **Publish**: `npm run publish` (publishes `@graffiticode/l0175` and `@graffiticode/l0175-view` with public access)

### Testing
- **Run all tests**: `npm test` (builds `core` first, then `vitest run`)
- **Watch**: `npx vitest` from the repo root
- **Single file**: `npx vitest run packages/core/test/compose.spec.ts`
- **By name**: `npx vitest run -t "<test name substring>"`

Specs live in `packages/core/test/` (`compose`, `task-model`, `corpus`, `embedding`, `verify-example`) and `packages/view/src/components/form/copy.spec.ts`. Because `npm test` builds `core` first, run it (not bare `vitest`) after changing core source so view/API tests see the rebuilt `dist/`.

### Deployment
- **GCP Cloud Build**: `npm run gcp:build` (submits `cloudbuild.yaml` to the `graffiticode` project)
- **GCP Direct Deploy**: `npm run gcp:deploy` (deploys to Cloud Run as `l0175`, region `us-central1`, port `50175`)
- **View logs**: `npm run gcp:logs`

## Architecture

L0175 is a Graffiticode dialect (child of `@graffiticode/l0000`) for composing 5th-grade ELA assessment items (Smarter Balanced · Grade 5 · Claim 1). One language is **parameterized over learning targets** via a required top-level `target` selector. Seven targets ship today, paired by skill × text type: `c1-t4` / `c1-t11` (Reasoning & Evidence, literary/RL and informational/RI), `c1-t2` / `c1-t9` (Central Ideas, literary/RL-1+RL-2 and informational/RI), `c1-t1` / `c1-t8` (Key Details, literary/RL-1 and informational/RI), and `c1-t10` (Word Meanings, informational). Each target is a profile (dimensions, standards, task models, stem catalog); the composition engine is target-invariant. It's an npm-workspaces monorepo with three packages. A program declares its `target`, then authors an inline superset of tagged content (a passage, candidate inference `claim`s, evidence `source`s) plus intended `outcome`s; the compiler composes each outcome into a finished item.

**Targets are single-sourced in `packages/core/src/targets.ts`** (`TARGETS_DATA`) — the doc comment at its head is authoritative: everything the compiler enforces about a target lives there and only there. `compiler.ts` derives its runtime `TARGETS` profiles from that data, `embedding.ts` routes a prompt to a target through its `skill` × `textType` pair (`targetForSkill`), and `tools/build-static.js` serializes it to `dist/static/targets.json` and generates the per-target spec tables. To add or change a target fact, edit `targets.ts`; the compiler and docs follow. Source guidelines live in `packages/core/data/*.pdf`.

### Structure

- **`packages/core/`** — `@graffiticode/l0175`: the language itself. Pure TypeScript.
  - `src/targets.ts`: single source of truth for per-target structure (`TARGETS_DATA`, `STANDARD_FAMILIES`, task-model maps). Plain data, round-trips to JSON.
  - `src/lexicon.ts`: merges L0000's base lexicon with L0175's builder vocabulary (attribute functions, the `claims`/`evidence`/`outcomes` collection builders, the `claim`/`source`/`outcome` element wrappers, and the kebab-case enum values)
  - `src/compiler.ts`: `Checker` + `Transformer` extending L0000's; the builder handlers reconstruct records and the overridden `PROG` runs the deterministic compose/selection that assembles each item. Builds runtime `TARGETS` profiles from `targets.ts`.
  - `src/embedding.ts`: RAG helpers (relevance gate, item-type / tag extraction) for the console generator pipeline
  - `src/verify-example.ts`: validates spec examples against target profiles
  - `spec/`: language documentation, examples, schema, RAG training prompts, etc.
  - `tools/build-static.js`: copies spec content into `dist/static/` for the API to serve

- **`packages/api/`** — `@graffiticode/api-l0175`: Express language server. TypeScript, run via `tsx` in dev and compiled to `dist/` for prod.
  - Routes (`src/routes/`): `compile`, `auth`, `root` (`/form`), plus `index` and shared `utils`
  - Auth integration with `@graffiticode/auth`
  - Port: 50175 (dev) or `process.env.PORT`

- **`packages/view/`** — `@graffiticode/l0175-view`: React view component. Vite + TypeScript + Tailwind.
  - `src/components/form/Form.tsx`: renders composed items; `ItemView` dispatches to a per-task-model component — `EbsrItem`, `HotTextItem`, `ShortTextItem`, `MultipleChoiceItem`, `MultiSelectItem`, `WordSelectItem` — with a `ModeToggle` for Student / Review. `copy.ts`/`CopyButton.tsx` build the copyable question + answer key.
  - `embed/`: standalone HTML entry built by `vite.embed.config.ts` for embedding in the API's static bundle
  - Built on top of `@graffiticode/l0000-view`

### Build pipeline

`npm run build` composes the packages in order:
1. `core` compiles TypeScript and copies spec content to `core/dist/static/`
2. `api` compiles TypeScript to `api/dist/`
3. `view` builds both the library (`dist/`) and the embed bundle (`dist-embed/`)
4. `assemble` clears `packages/api/static/` and copies `core/dist/static/` + `view/dist-embed/` into it — this is what the API serves

### Language Functions

The authoring surface is the l0169 builder idiom: a program is one flat chain ending in a single `{}..`. Top-level forms thread a shared continuation; list elements (`claim`/`source`/`outcome`) are their own `{}`-terminated chains.

| Form | Arity | Role |
|------|:-----:|------|
| `passage` / `type` / `lines` | 2 | Passage heading, type (`literary`/`informational`), and numbered lines |
| `claims` / `evidence` / `outcomes` | 2 | Collection builders (each takes a list) |
| `claim` / `source` / `outcome` | 1 | Element wrappers over an attribute chain |
| attribute fns (`id`, `status`, `dimension`, `error-type`, `text`, `rationale`, `cites`, `line`, `quote`, `supports`, `subject`, `standard`, `dok`, `focus`, …) | 2 | Merge one key into the element record |

Enum values are bare kebab-case identifiers (`ebsr`, `character`, `misreads-detail`, `directly-supports`, `rl-1`, `r-dok3`) registered in the lexicon. Validation (enum membership, required distractor rationale) runs in the Transformer as hard errors; selection compromises surface as `warnings` in the composed item.

### Data Flow

```
User Input → State Update → POST /compile → Compiler (core) → Output Data → Form (view) → postMessage to parent
```

The embedded form supports iframe embedding and communicates with parent windows via postMessage.

### Environment Variables
- `PORT`: API port (default 50175)
- `AUTH_URL`: Auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST`: Local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV`: `development` or `production`

### Dependencies
- `@graffiticode/l0000` (published) — base language, inherited by `core`
- `@graffiticode/l0000-view` (published) — base view, inherited by `view`
- `@graffiticode/auth` — auth service client used by `api`
