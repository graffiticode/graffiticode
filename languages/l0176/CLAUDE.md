# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- **Start dev server**: `npm run dev` (starts API server on port 50176; expects Firestore emulator at 127.0.0.1:8080 and local auth at 127.0.0.1:4100)
- **Build project**: `npm run build` (builds `core` → `api` → `view`, then assembles static bundle into `packages/api/static/`)
- **Start production**: `npm run start` (runs the built API server)

### Testing
Vitest, in `packages/core` (plus one view test that is not wired to a script).
- **Run all**: `npm test` (delegates to `npm -w packages/core test` → `vitest run`)
- **One file**: `npm -w packages/core exec vitest run src/docs.test.ts`
- **One test by name**: `npm -w packages/core exec vitest run -t "questions path"`
- **Watch**: `npm -w packages/core exec vitest`

The core tests run straight off `src/` — no build needed. Only
`tools/gen-attribute-reference.mjs` reads `dist/`, so build before regenerating
the spec table.

### Linting
- **Lint repo**: `npm run lint` (ESLint over the whole monorepo)
- **Lint a package**: `npm -w packages/<core|api|view> run lint`
- **Fix lint errors**: `npm run lint:fix` (or `:fix` on a workspace script)
- **Format**: `npm run format` (Prettier across the repo)

### Package Management
- **Build and pack**: `npm run pack` (builds, then packs `packages/view`)
- **Publish**: `npm run publish` (publishes `@graffiticode/l0176` and `@graffiticode/l0176-view` with public access)

### Deployment
- **Release**: from the graffiticode repository root, `npm run deploy -- l0176` (deploy CLI; config in root `deploy.json`, image from `configs/Dockerfile.l0176.yaml`, runtime `l0176-run`, port `50176`). It tests, builds, deploys a no-traffic candidate, checks `/` and `/lexicon.js`, then promotes. Env and pinned secret versions live in that `deploy.json` entry.
- **View logs**: `npm run gcp:logs`

## Architecture

L0176 is a Graffiticode dialect (child of `@graffiticode/l0000`) for building **Learnosity
assessment integrations**. It compiles Graffiticode programs into Learnosity API requests
(Items, Questions, Author APIs) and renders them via a React frontend that loads the
Learnosity browser SDK. It is the modern-architecture successor to **L0158** (which was
built on the old `@graffiticode/basis` compiler); the vocabulary and compiled output are a
faithful, byte-compatible port of L0158. It's an npm-workspaces monorepo with three packages.

### Structure

- **`packages/core/`** — `@graffiticode/l0176`: the language itself. Pure TypeScript.
  - `src/lexicon.ts`: merges L0000's base lexicon with L0176's Learnosity vocabulary
    (`init`, `items`, `item`, `questions`, `author`; the question-type keywords
    `mcq`/`shorttext`/`clozetext`/`choicematrix`/`bowtie`/`token-highlight`/… ; attribute keywords
    `stimulus`/`options`/`valid-response`/`save-to-itembank`/`metadata`/… ; and metadata
    member constructors `tags`/`notes`/`difficulty-level`/…)
  - `src/compiler.ts`: `Checker`/`Transformer` extending L0000's; hand-written block handlers
    (`INIT`, `ITEMS`, `ITEM`, `QUESTIONS`, `AUTHOR`, `PROG`)
    plus registry-driven generation of per-question-type / per-attribute / per-metadata
    methods. `signForRender` has the broker sign the activity at the end of `PROG` (through
    the selected connection, or the system preview session without one).
  - `src/protection.ts`: the brokered path — `brokeredSign`/`brokeredSave` via
    `exec.invoke`, and `systemPreviewSign`, which installs a system preview session on the
    compile's `ExecContext` when there is no connection
  - `src/question-types.ts`: the per-type Learnosity question builders + attribute/metadata
    registries (`questionTypeBuilders`, `memberFields`, `validAttributes`, `inferShape`,
    `partitionItemsList`) — the single source of truth the generated compiler methods and
    `tools/gen-attribute-reference.mjs` both read
  - `src/{items,questions,author}.ts`: build the unsigned activities and save plans (their
    `buildInit*` local signers are no longer called by the compiler)
  - `spec/`: language documentation, examples, schema, RAG training prompts — **executable
    documentation**, see below
  - `tools/build-static.js`: emits `dist/static/` for the API to serve — merged
    `lexicon.json` (minus deprecated aliases), L0000+L0176 `instructions.md`, `spec.html`,
    `language-info.json`, `scope.json`, `schema.json`, `template.gc`, `usage-guide.md`
  - `tools/gen-attribute-reference.mjs`: regenerates spec.md's Attribute Reference (a
    heading per word) from the registries in `dist/question-types.js` joined to the
    descriptions in `tools/attribute-docs.mjs`; fails on a word in one and not the other
    (build first)

- **`packages/api/`** — `@graffiticode/api-l0176`: Express language server. TypeScript, run via `tsx` in dev and compiled to `dist/` for prod.
  - Routes (`src/routes/`): `compile`, `auth`, `root` (`/form`), plus `index` and shared `utils`
  - `src/protection.ts`: wires the policy/broker client into the compiler when `POLICY_URL`
    and `BROKER_URL` are set, including `POST /v1/preview-session` for system sessions
  - Auth integration with `@graffiticode/auth`
  - Port: 50176 (dev) or `process.env.PORT`

- **`packages/view/`** — `@graffiticode/l0176-view`: React view component. Vite + TypeScript + Tailwind.
  - `src/components/form/Form.tsx`: language-specific form rendering
  - `src/components/form/contentKey.ts`: stable key for the one-time `LearnosityApp.init`
  - `embed/`: standalone HTML entry built by `vite.embed.config.ts` for embedding in the API's static bundle
  - Built on top of `@graffiticode/l0000-view`

### Build pipeline

`npm run build` composes the packages in order:
1. `core` compiles TypeScript and copies spec content to `core/dist/static/`
2. `api` compiles TypeScript to `api/dist/`
3. `view` builds both the library (`dist/`) and the embed bundle (`dist-embed/`)
4. `assemble` clears `packages/api/static/` and copies `core/dist/static/` + `view/dist-embed/` into it — this is what the API serves

### Learnosity credentials

**L0176 holds no Learnosity secret.** Every signature and item-bank write is made by the
credential broker under a policy-minted token:

- A compile that **selects a connection** is brokered: policy `snapshot` admits the protected
  functions, and `brokeredSign`/`brokeredSave` spend that connection's credential.
- A compile **without a connection** signs its preview through a **system preview session**:
  `POST /v1/preview-session { lang }` (compiler identity, no user token) returns a session on
  the Graffiticode-owned connection policy has configured for the backend
  (`POLICY_SYSTEM_CONNECTIONS`), carrying only `preview-itembank`. `systemPreviewSign` installs
  it on the compile's `ExecContext` once (`setSessionToken`/`setSnapshot`/`bindInvoker`, all
  public on l0000's `ExecContext`) and calls the same `brokeredSign`. It never writes and never
  signs Author: those check `isBrokered`, which needs a connection.
- No session (no policy client, not configured, denied, unreachable) or a failed signing
  returns the activity **unsigned** with `signing: { unsigned, message }` — not a compile error.

Program-supplied `set-var "learnosity-key"/"learnosity-secret"` and a request's
`config.learnosity` are **ignored** (no error, even when only one is set); they sign nothing.
`save-to-itembank` writes only with a connection, otherwise evaluating to the activity with
`itemBank: { skipped: "no-connection", … }`. `get-val-private` is L0000's generic decrypt
(`GRAFFITICODE_SECRET_KEY`); L0176 no longer needs it for signing. See
`docs/learnosity-render-setup.md`.

### Signing at compile time — and why compiles are never cached

The shared `@graffiticode/l0000-view` issues **one** `POST /compile` and hands the result to
the Form verbatim, so the compile output must already carry a signed `request`. `signForRender`
in `PROG` signs the `{type, data}` activity; without it the Form renders blank.

Each signing stamps a fresh `user_id`/`signature`/`timestamp` on an expiring token, so the
compile envelope answers **`cache: false`** (`packages/api/src/compile.ts`). The api strips
the directive, skips the Firestore `compiles/{id}` write, and sends `Cache-Control: no-store`.
Two consequences: L0176 wants `min-instances=1` on Cloud Run (cold start is on every render
path), and the Form must key its one-time `LearnosityApp.init` on stable question content
(`contentKey.ts`) rather than object identity, since `request` churns on every recompile.
Re-initializing on already-mounted DOM throws Learnosity's `triggerBufferedEvents` error.

### Data Flow

```
User Input → State Update → POST /compile → Compiler (core; the broker signs via policy)
  → { type, data, request } → Form (view, loads Learnosity SDK by type) → postMessage to parent
```

The embedded form supports iframe embedding; the shared View (from `@graffiticode/l0000-view`)
owns the parent-window postMessage/onload protocol.

### Language Functions

L0176 inherits the full L0000 base vocabulary (arithmetic, lists, lambdas, `map`/`filter`/
`reduce`, pattern matching, tags, `set-var`/`get-val-public`/`get-val-private`) and adds the
Learnosity vocabulary. Canonical program shape (`spec/template.gc`):

```
set-var "lrn-id" get-val-public "itemId"
items [item [questions [mcq []] {}]] {}..
```

- **Question types (arity 1):** `mcq`, `shorttext`, `longtext`, `plaintext`, `clozetext`,
  `clozeassociation`, `clozedropdown`, `clozeformula`, `choicematrix`, `orderlist`,
  `classification`, `bowtie`, `custom`, `token-highlight`.
- **Attributes (arity-1 members):** `stimulus`, `options`, `valid-response`, `validation`,
  `possible-responses`, `template`, `columns`, `list`, `column-titles`, `max-selection`,
  `method`, `metadata`, `params`, `save-to-itembank`, and more. Every attribute is arity 1;
  only `items` and `questions` are arity 2.
- **Metadata members (arity 1):** `tags`, `notes`, `distractor-rationale`, `acknowledgements`,
  `description`, `source`, `difficulty-level`.
- **Control flow:** `save-to-itembank` sets `options["save-to-itembank"]` by side effect
  rather than emitting a field. The item id comes from `set-var "lrn-id"` alone — ITEMS,
  QUESTIONS and AUTHOR all error without it.

Checker/Transformer methods for question types, attributes, and metadata members are generated
programmatically by looping over the registries in `question-types.ts`; only the block-level
nodes have hand-written methods.

**Program shape.** `items [ … ] {v: 1}..` is the top level; there is no wrapper above it.
The `items` list holds `item` entries alongside items-level members (`params`,
`save-to-itembank`), told apart by `partitionItemsList` — a single-key record whose key is one
of those is a member, anything else is an item. The trailing record is program metadata and is
spread onto the compiled envelope. `items` builds one Learnosity item record per entry, but
rendering flattens every item's questions into one list because it goes through the Questions
API with inline data; item references are `graffiticode-{lrn-id}-{n}` and question references
carry the same ordinal.

**Member lists.** Every attribute is an arity-1 member returning a single-key record, and a
question is a bracketed member list — `mcq [ stimulus "..." validation [ ... ] ]`. Objects nest
the same way at any depth, and an array of objects is a list of member lists. `{}` survives only
on the arity-2 blocks (`items`, `questions`) and the control-flow attribute `save-to-itembank`
that chains onto them. A word gets one arity, which is why `item` takes a member list too:
`metadata` is a member at both item and question level.

**An attribute is named for the Learnosity field it emits**, and the program nests the way the
object nests, so a question is a transcription of its JSON. That means a builder has almost
nothing to do — the generated member transformer accumulates the record and the builder stamps
the type, applies defaults, and checks the attribute set against `validAttributes` and the
`scoring-type` against `SCORING_TYPES`, both taken from the type's Learnosity article. All 13
types work this way; there is no second form.

Two words carry different Learnosity types on different question types — `options` and `value` —
and `inferShape` in `question-types.ts` decides which reading applies from the element types,
which do not overlap. Scoring-rule `options` keys are camelCase (`decimalPlaces`), alone among
Learnosity's fields.

Because the language transcribes rather than derives, L0176 validates very little of what it
emits: no index is range-checked, no `method` is recognised, no `options` key is known. See
`packages/core/spec/conflict-resolution.md` for where the Learnosity documentation contradicts
itself, and `docs/learnosity-audit.md` for the per-type record of what was decided.

### spec/ is executable documentation

**A code generator writes L0176 programs from `spec/instructions.md` and `spec/examples.md`,**
so a stale example is not a documentation nit — it is reproduced verbatim into generated items.
`src/docs.test.ts` is the guard, and it is unusually strict. It enforces that:

- every fenced program fragment in `spec/spec.md` and `spec/instructions.md` **parses and
  compiles** (parse-only once let twenty stale examples through)
- no retired keyword still appears in code spans or fences (`RETIRED` in the test lists them:
  `partial-credit`, `alternative-response`, `max-word-count`, `categories`, `distractors`,
  `hot-text`, `learnosity`, `features`, `layout`, `id`)
- cloze blanks live in the `template`, never the `stimulus`; a `clozeformula`'s formula
  likewise
- every LaTeX backslash in a spec program is doubled (`\\frac`) — the compiler cannot catch
  single-backslash `\frac`, only the source can
- `examples.md`'s numbering, category ranges, and cross-references are internally coherent
- every attribute the compiler accepts has its own `####` heading in spec.md's Attribute
  Reference (65 of 153 words were once undocumented and therefore unreachable by the
  generator)

The compiler backs these up: a member given twice in one member list (two `validation`
blocks) and an answer set whose `value` is itself a member list are compile errors. Both
once compiled silently to wrong JSON from twenty spec examples.

When changing vocabulary: update the lexicon and registries, describe the word in
`tools/attribute-docs.mjs`, regenerate the reference with `tools/gen-attribute-reference.mjs`, update `spec/`, add the old spelling to `RETIRED`,
and run the tests. `README.md` is not covered by these guards and currently lists retired
block keywords — treat `spec/` and the lexicon as authoritative.

**Retiring a word.** A word removed from the lexicon breaks already-saved sources. The escape
hatch is `deprecatedAliases` in `lexicon.ts`: the alias still lexes and maps onto the current
keyword's AST name (one node type, one builder), but `build-static.js` strips it from the
published `lexicon.json`, so nothing advertises it. `hot-text` → `token-highlight` is the one
live example.

### Environment Variables
- `PORT`: API port (default 50176)
- `POLICY_URL` / `BROKER_URL`: policy authority and credential broker; every Learnosity
  signature goes through them (without them, previews come back unsigned and a selected
  connection is refused)
- `AUTH_URL`: Auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST`: Local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV`: `development` or `production` (the Learnosity signing `domain` is the broker's
  `LEARNOSITY_DOMAIN`, not L0176's)

### Dependencies
- `@graffiticode/l0000` (published) — base language, inherited by `core`
- `@graffiticode/l0000-view` (published) — base view, inherited by `view`
- `@graffiticode/auth` — auth service client used by `api`
- `learnosity-sdk-nodejs` — still a `core` dependency for the unused `buildInit*` signers; the
  broker does the signing
