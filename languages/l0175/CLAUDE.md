# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Two implementations live here.** `crates/` is L0175 in Rust, which production runs (`l0175r`, since 2026-10-30); `packages/` is the TypeScript L0175, still deployed as `l0175` (min 0) as the switch's rollback target, and still the source of the static assets and the conformance fixtures. Everything down to "The Rust implementation" describes the TypeScript side.

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
- Release with `npm run deploy -- l0175` from the graffiticode repository root (deploy CLI; entry in root `deploy.json`, image from `configs/Dockerfile.l0175.yaml`, runtime `l0175-run`). It updates env additively and carries the live `--max-instances` forward.
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

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0175**. `packages/core` and `packages/api` are the TypeScript compiler and server (Cloud Run service `l0175`, min 0, kept as the switch's rollback target). `crates/` is the same language in Rust, released to its own service `l0175r`, which production runs: the api routes L0175 there (`BASE_URL_L0175`, interpreter plan A2, 2026-10-30; evidence in `docs/evidence/track-a-batch-l0174-l0175-l0183/`). `packages/view` and the spec are shared by both.

- `crates/core` (`graffiticode-l0175`) — the language:
  - `src/lib.rs` — `L0175` implements `Dialect` from `graffiticode-l0000`: the attribute words (one table, tag → field), the six words that close an element's chain, and the `PROG` override that composes. `lexicon()` is the base lexicon merged with `src/lexicon-additions.json`.
  - `src/targets.rs` — the target profiles, read from `src/targets.json`.
  - `src/authored.rs` — a program's content (`Program`, `Claim`, `Source`, `Word`, `Meaning`, `Outcome`), read once from the records the builders made.
  - `src/compose.rs` — validation and item assembly: `compose(Program) -> (Json, Vec<Problem>)`. The counterpart of everything below `composeProgram` in `compiler.ts`.
  - `src/text.rs` — normalising, sentence splitting, the reading-level estimate, id collation and the seeded shuffle.
- `crates/server` (`l0175r-server`, binary `l0175r`) — `l0000r_server::serve(L0175, lexicon())`. Routes, auth and static serving live in `languages/l0000/crates/server`.
- `tools/assemble-static.mjs` — builds the static assets and `/form` bundle into `./static` for the Rust server.

**Not ported:** `embedding.ts` and `verify-example.ts`. They are the console's RAG helpers and the example-corpus gate, consumed as a JavaScript library and by this package's own tests; neither is part of a compile. `tools/build-static.js` (spec tables, `targets.json`) also stays.

**The Rust side depends on `languages/l0000` by relative path** (Cargo path dependencies on its kernel and server crates). Read "The Rust implementation" in `languages/l0000/CLAUDE.md` for how evaluation, values and the `Dialect` trait work.

```bash
cargo test            # unit, conformance and dialect tests; needs no Node and no network
npm run rust:build    # rust:static, then cargo build --release -p l0175r-server
npm run rust:dev      # cargo run -p l0175r-server on :50175 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then regenerate the generated files below
```

### `targets.ts` is still the single source of truth

`crates/core/src/targets.json` is **generated** from `packages/core/src/targets.ts` by `npm run rust:fixtures`. Never edit it. After changing a target in `targets.ts`, run `rust:fixtures` and commit the result, or the two compilers disagree about what the target allows. The same run regenerates `src/lexicon-additions.json`, `tests/conformance/cases.json` and `tests/conformance/collation.json`.

### What the Rust has to get exactly right

An item's option labels, its selectable sentences and its warnings all follow from small computations, and the Rust is held to the TypeScript's output **as JSON text**, field order included. The places where that means JavaScript's notion of something, all in `text.rs` or `authored.rs`:

- **The shuffle.** `hash` (FNV-1a over UTF-16 code units) seeds mulberry32; `place_correct` in `compose.rs` puts the key at a slot that advances with the outcome index. Change either and every item's labels move.
- **Tie-breaks.** Distractors and foil sources are ranked by score, then by id in the order `localeCompare` gives. `text::collate` reproduces that for ASCII (punctuation, then digits, then letters; case only breaks ties, lowercase first) and is tested against a list Node sorted. Non-ASCII ids fall back to code-point order, which is not ICU's.
- **Lengths** are UTF-16 code units (`text::length`): they appear in warnings and weigh on plausibility.
- **Rounding.** `Math.round` and `toFixed(1)` send a half up; Rust's formatting sends it to even. `text::round` and `text::one_decimal`.
- **Sentence splitting** (`text::sentences`) is the same heuristic, quirks included: text after the last full stop is dropped, and a rejoined abbreviation comes back with a space ("a.m." → "a. m.").
- **Loose values.** `authored::text` and `authored::number` read a field the way `str()` and `Number()` do: a tag is its name, a number prints as itself, a missing value is empty.

Where an element was written travels on its record under a key no program can write (`authored::NODE`), so a problem can point at its element. It never reaches an item; a test checks every fixture case for that.

### Conformance

`crates/core/tests/conformance/generate.mjs` builds its corpus from the shipped examples (`spec/examples/*.gc`, every target with every task model), each example with something removed or changed (about 45 mutations, each applied to one example in five), the pool the TypeScript suite composes from, and hand-written cases for sentence splitting, word meanings and degenerate programs. `tests/conformance.rs` requires the same JSON text or the same error messages for all 298 cases. `L0175_EVERY_MUTATION=1 node crates/core/tests/conformance/generate.mjs` writes every mutation of every example (988 cases, 18MB) for a one-off run; do not commit that fixture.

One deliberate difference: a chain that ends in a record literal with fields (`claim id "c1" {text: "…"}`) instead of `{}`. TypeScript does not see the literal's fields; the Rust does.

### The interpreter pass (plan C1)

`L0175::input_independent` is `!ast.reads_input()`: an item is composed from its program alone,
so a program that doesn't read its input (all of the conformance corpus) compiles to a value
model, evaluated once; one that does (`data`, a `get-var` that may name it) is a plan.
`tests/interpret.rs` requires `interpret(model(case), input)` to write exactly what
`compile(case, input)` writes for every case, in both modes and against three inputs. The api
interprets L0175 only while `INTERPRETER_L0175=on`.

### Deploying the Rust server

`deploy.json` has an `l0175r` entry (own service, `l0175r-run@graffiticode.iam.gserviceaccount.com`, image from `configs/Dockerfile.l0175r.yaml`; snapshot is this directory and `languages/l0000`; build step `cargo test --locked`). Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later (see `languages/l0000/CLAUDE.md`). The service and account do not exist until provisioned; the account needs no roles.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored build outputs.
