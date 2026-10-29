# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Two implementations live here.** `packages/` is the TypeScript L0176 that production runs; `crates/` is L0176 in Rust. Everything down to "The Rust implementation" describes the TypeScript side.

## Commands

### Development
- **Start dev server**: `npm run dev` (starts API server on port 50176; expects Firestore emulator at 127.0.0.1:8080 and local auth at 127.0.0.1:4100)
- **Build project**: `npm run build` (builds `core` → `api` → `view`, then assembles static bundle into `packages/api/static/`)
- **Start production**: `npm run start` (runs the built API server)

### Testing
Vitest, in `packages/core`, `packages/api` (the server through `supertest`, against the
core's sources via an alias in its `vitest.config.ts`) and `packages/view` (jsdom, with
`@testing-library/react`; the Learnosity SDK and `fetch` are stubbed at their boundaries).
- **Run all**: `npm test` (`npm -w packages/core test`, `npm -w packages/api test`, then `npm -w packages/view test`)
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
- **Release**: from the graffiticode repository root, `npm run deploy -- l0176` (deploy CLI; config in root `deploy.json`, image from `configs/Dockerfile.l0176.yaml`, runtime `l0176-run`, port `50176`). It tests, builds, deploys a no-traffic candidate, checks `/` and `/lexicon.json`, then promotes. Env and pinned secret versions live in that `deploy.json` entry.
- **View logs**: `npm run gcp:logs`

## Architecture

L0176 is a Graffiticode dialect (child of `@graffiticode/l0000`) for building **Learnosity
assessment integrations**. It compiles Graffiticode programs into Learnosity API requests
(Items and Questions APIs) and renders them via a React frontend that loads the
Learnosity browser SDK. It is the modern-architecture successor to **L0158** (which was
built on the old `@graffiticode/basis` compiler); the vocabulary and compiled output are a
faithful, byte-compatible port of L0158. It's an npm-workspaces monorepo with three packages.

L0176 signs no Author API sessions: `author` was removed with protected-registry v7
(AUTHOR-01, closed by removal). It makes items and activities for the item bank; an Author
integration is signed by the customer's own application, and L0177 (read-only) plans one.
An Author activity arriving as data is a compile error pointing to L0177.

### Structure

- **`packages/core/`** — `@graffiticode/l0176`: the language itself. Pure TypeScript.
  - `src/lexicon.ts`: merges L0000's base lexicon with L0176's Learnosity vocabulary
    (`init`, `items`, `item`, `questions`; the question-type keywords
    `mcq`/`shorttext`/`clozetext`/`choicematrix`/`bowtie`/`token-highlight`/… ; attribute keywords
    `stimulus`/`options`/`valid-response`/`save-to-itembank`/`metadata`/… ; and metadata
    member constructors `tags`/`notes`/`difficulty-level`/…)
  - `src/compiler.ts`: `Checker`/`Transformer` extending L0000's; hand-written block handlers
    (`INIT`, `ITEMS`, `ITEM`, `QUESTIONS`, `PROG`)
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
  - `src/{items,questions}.ts`: build the unsigned activities and save plans (their
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
  - `src/components/form/resolve.ts` / `sign.ts`: resolve-then-sign (below)
  - `src/generation.ts`: SWR middleware the `/form` bundle installs around the View, so its
    data load carries the `generation` of the `?url=` the api's `/form` redirect passes
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
  (`POLICY_SYSTEM_CONNECTIONS`), carrying only `init`. `systemPreviewSign` installs
  it on the compile's `ExecContext` once (`setSessionToken`/`setSnapshot`/`bindInvoker`, all
  public on l0000's `ExecContext`) and calls the same `brokeredSign`. It never writes and never
  signs Author: those check `isBrokered`, which needs a connection.
- **Gateway-only** (plan system-preview-rate-limit): the system path signs only for a
  compile whose `X-Caller-Identity` verifies as the api's (`urn:graffiticode:0176`, a
  `PREFLIGHT_GATEWAYS` account; the verifier `/preflight` uses). `routes/compile.ts` sets
  `identity.systemPreview` from that alone (never from the body), and `L0176Compiler.compile`
  dispatches such a compile to a `SystemSigningTransformer`; any other no-connection compile
  (a direct caller on `l0176.graffiticode.org` or `*.run.app`) gets its activity back
  unsigned, `signing: { unsigned: "gateway-only" }`, without asking policy. On by default;
  `SYSTEM_PREVIEW_DIRECT=1` (exactly `"1"`) turns it off, for the rollout window only.
  Connection compiles are unaffected.
- No session (no policy client, not configured, denied, unreachable) or a failed signing
  returns the activity **unsigned** with `signing: { unsigned, message }` — not a compile error.
  The system signing limits come back the same way, each under its own reason with the
  message "Previews are busy right now; try again in a moment.": Policy's `rate-limited` (at
  the mint, or for the session) and Broker's `session-exhausted` (at execute).

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

### Resolve, then sign (the Form)

L0158 holds no credential, so its items render in this Form (the api's `/form` redirects an
L0158 task here once its generation is active): its compiled data is an **unsigned**
`{ type, data }` activity with inline `{ response_id, type, ... }` questions. Ported from
L0158's View, the Form picks one `dynamic_content_data` row per mount and substitutes
`{{var:X}}` everywhere, custom-question data included (Learnosity passes custom data through
unsubstituted). When the activity has no `request`, or it is an already-signed `questions`
activity that substitution changed, it posts the resolved activity to the api's stateless
`POST /preview/sign { activity }` (the api host the View loads data from: `localhost:3100`
in dev, `api.graffiticode.org` otherwise), with no connection or user token. The api
compiles L0176's `init data {}` with the activity inline, as the api, so the system preview
session signs it for `l0176.graffiticode.org` (gateway-only, above), and the Form renders
`{ type: activity.type, request }`. Never L0176's own `/compile` (a direct compile is
unsigned) and never the api's `/compile` (it stores posted data as a task, public for an
anonymous caller). The api answers `{ request }`, `{ signing: { unsigned, message } }` or a
4xx; a 429, `rate-limited` or `session-exhausted` shows "Previews are busy right now; try
again in a moment."
Any other already-signed activity renders its own request with no second compile: one with
nothing to substitute, and **every signed `items` activity**, dynamic data or not. The system
session is a different Learnosity consumer from a user's connection, and an items activity may
load bank items by reference that consumer can't see (Learnosity still substitutes its
standard fields). Without a request (signing unavailable,
pending, or refused) the SDK is never initialized; an unsigned result shows its
`signing.message`, or "This preview couldn't be signed."

`init` signs only a `{ type: "questions" | "items", data }` activity whose questions each have
a `type` and a Broker-acceptable `response_id`, checked before signing so a refusal is a
compile error. Anything else (a bare signed request, a list, a primitive, nothing, a legacy
`{ type, reference, data }` question record) is a compile error, never adapted. A `request`
the activity arrives with is dropped and the activity signed afresh, in `init` and in `PROG`.

### Data Flow

```
User Input → State Update → POST /compile → Compiler (core; the broker signs via policy)
  → { type, data, request } → Form (view, loads Learnosity SDK by type) → postMessage to parent
```

The embedded form supports iframe embedding; the shared View (from `@graffiticode/l0000-view`)
owns the parent-window postMessage/onload protocol. Its `onload`/`data-updated` fire on mount,
before Learnosity is up, so the Form adds the one signal only it can see
(`components/form/preview-status.ts`): `{ type: "preview-ready" }` from Learnosity's
`readyListener`, or `{ type: "preview-error", reason }` when that won't come (compile errors, an
unsigned preview, the SDK script failing, a Learnosity error, data that isn't an activity). It is
posted at most once per mount, only when the page has an `origin` param, and only to that origin.
The MCP widget frames `/form` for free-plan items and waits for it.

**Parent mode (`/form?source=parent&origin=<o>`).** For the MCP widget, the page fetches nothing:
`embed/main.tsx` mounts `ParentFed` (`components/form/parent-fed.tsx`) instead of the View. It posts
`{ type: "preview-awaiting-data" }` to `<o>` and accepts exactly one `{ type: "preview-data", data }`
from `window.parent` at exactly `<o>`. `data` is the compile envelope `{ data, errors }`, unwrapped
by the shared View's own rule (an object whose `errors` is an array), with a bare activity also
accepted. So a signed-in user's private item renders without any credential reaching the frame.
**Expiry** (`components/form/expiry.ts`): a request within 60 s of its `expires` is stale. That is
decided once per content when it arrives, and never once Learnosity holds that content
(`initedContentRef`, compared by `contentKey`), because a started assessment keeps working past
`expires` (measured). A stale questions request is re-signed through `/preview/sign`; a stale
items request can't be, and shows "This preview's signature has expired." 

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
  rather than emitting a field. The item id comes from `set-var "lrn-id"` alone — ITEMS
  and QUESTIONS both error without it.

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
- `PREFLIGHT_GATEWAYS`: the gateway accounts (`api-run`) allowed to preflight, and the only
  callers whose no-connection previews are signed (gateway-only)
- `SYSTEM_PREVIEW_DIRECT`: `1` lets any direct caller's no-connection preview be signed on the
  system path; the gateway-only rollout window only, then removed

### Dependencies
- `@graffiticode/l0000` (published) — base language, inherited by `core`
- `@graffiticode/l0000-view` (published) — base view, inherited by `view`
- `@graffiticode/auth` — auth service client used by `api`
- `learnosity-sdk-nodejs` — still a `core` dependency for the unused `buildInit*` signers; the
  broker does the signing

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0176**. `packages/core` and `packages/api` are the TypeScript compiler and server, which production runs (Cloud Run service `l0176`, pinnable). `crates/` is the same language in Rust, to be released to its own service `l0176r` so it can be vetted before it replaces the TypeScript. `packages/view` and the spec are shared by both.

- `crates/core` (`graffiticode-l0176`) — the language:
  - `src/lib.rs` — `L0176` implements `Dialect` from `graffiticode-l0000`: the block words (`items`, `item`, `questions`, `init`, `save-to-itembank`), the question types and attribute words, and the `PROG` override that signs the program's activity.
  - `src/questions.rs` — the counterpart of `question-types.ts`: the attribute registry (`MEMBERS`, with each word's field and shape), `merge_members`, `infer_shape`, the question builders with their defaults, and every check (attributes, member shapes, scoring, cloze templates, math encoding, scoring methods).
  - `src/activities.rs` — `items.ts` and `questions.ts`: the activities and their save plans.
  - `src/protection.rs` — `protection.ts`: signing and saving through the broker, the system preview session, structured failures.
  - `src/lowering.rs` — `save-lowering.ts`, as `Dialect::normalize`.
  - `src/plain.rs` — values as the JSON the rest works on, with JavaScript's key order and `String()`.
- `crates/server` (`l0176r-server`, binary `l0176r`) — `l0000r_server::serve(L0176::new(), lexicon())`.
- `tools/assemble-static.mjs` — builds the static assets and `/form` bundle into `./static` for the Rust server.

**Not ported:** the unused `buildInit*` local signers (and with them `learnosity-sdk-nodejs`), and the authoring tools (`tools/gen-attribute-reference.mjs`, `tools/attribute-docs.mjs`, `tools/build-static.js`).

**The Rust side depends on `languages/l0000` by relative path.** Read "The Rust implementation" in `languages/l0000/CLAUDE.md` for evaluation, values, admission and the `Dialect` trait.

```bash
cargo test            # unit, conformance and brokered-path tests; needs no Node and no network
npm run rust:build    # rust:static, then cargo build --release -p l0176r-server
npm run rust:dev      # cargo run -p l0176r-server on :50176 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then regenerate tests/conformance/* and src/lexicon-additions.json
```

### The protected path

The same model as the TypeScript (see "Learnosity credentials" above); what carries it in Rust:

- `protected_functions` declares `INIT` (`init`, sign) and `SAVE_TO_ITEMBANK` (`save-to-itembank`, write); `implicit_protected_functions` declares `init`, since every render is signed; `registry_version` is 7.
- **A compile with a connection** is admitted by the kernel before it runs (one policy snapshot), and signs and saves through `ExecContext::invoke`.
- **A compile without one** is not admitted at all (`Dialect::degrades_without_connection`): a save is reported as `itemBank: { skipped: "no-connection" }`, and a preview signs through `ExecContext::open_system_session`, which asks policy for a system session (`PolicyClient::preview_session`, `POST /v1/preview-session`) once per compile and grants it `init` alone, whatever policy's answer lists. A write can never run on it.
- **Save plans** live in the compile's `ExecContext::state`. `save-to-itembank` saves only an activity this compile built, matched by value; an activity arriving as data, or built by another compile, is refused.
- `Dialect::cacheable` is `false`, so the server answers `cache: false`, as the TypeScript does: every compile carries a fresh, expiring signature.

These four kernel hooks were added for L0176 and are documented in `languages/l0000/CLAUDE.md`'s kernel section.

### Conformance

`crates/core/tests/conformance/generate.mjs` compiles, with the TypeScript compiler and no policy client, every program fragment in `spec/spec.md` and `spec/instructions.md` (each again with an id set), the programs in `src/compiler.test.ts`, and hand-written cases; `tests/conformance.rs` requires the same JSON text, field order included, or the same error messages, for all 203 but the two deliberate differences below that a fixture case shows (each has its own test). UUIDs and the timestamped dynamic-content references are masked on both sides. Programs that `use` another language are left out: the TypeScript fetches its schema over the network. `programs.json` holds ASTs for `tests/brokered.rs`, which follows `brokered.test.ts` against a fake policy and broker (23 tests).

Deliberate differences:

- An activity written as a record literal (`{type: "questions" data: …}..`) is signed. TypeScript cannot see a literal's `type` in its `PROG`, so it leaves that one unsigned, though it signs the same literal under `init`.
- A compile with a connection on a server with no policy client is refused by the kernel's admission ("init is not permitted through the selected connection.") rather than "connections are not available on this server."
- `get-val-*` without a resolved value says so without the `[object Object]` the published `@graffiticode/l0000` this package uses appends.
- An attribute given an undefined value (an unset `get-var`) emits `null`; TypeScript drops the field.

**Parity gap (not yet ported):** the TypeScript `init` now refuses any value that isn't a
`{ type, data }` activity with Broker-shaped questions, and drops a `request` an activity
arrives with (in `init` and `PROG`) before signing it afresh. The Rust `init` still evaluates a
non-activity to nothing and `{ type: "items" }` with no data to an unsigned preview, and the conformance
fixtures (`init { "type": "items" }`, `init {type: "other"}`) predate the change; regenerate
them with `npm run rust:fixtures` when the Rust side is brought level.

**Parity gap (not yet ported): gateway-only.** The TypeScript server signs a no-connection
preview only for a verified api identity (or `SYSTEM_PREVIEW_DIRECT=1`), and maps Policy's
`rate-limited` and Broker's `session-exhausted` to unsigned busy results. The Rust side has
neither. `l0176r` has no policy or broker configured, so it signs nothing today; bring this
level before giving it `POLICY_URL`/`BROKER_URL`.

### Deploying the Rust server

`deploy.json` has an `l0176r` entry: its own service, `l0176r-run@graffiticode.iam.gserviceaccount.com`, image from `configs/Dockerfile.l0176r.yaml`, snapshot this directory and `languages/l0000`, build step `cargo test --locked`, env `AUTH_URL` only. **Without `POLICY_URL` and `BROKER_URL`, `l0176r` signs nothing**: every preview comes back `signing: { unsigned: "not-configured" }` (the Learnosity form then renders blank) and a compile that selects a connection is refused. Giving it those means policy must also accept `l0176r-run` as a caller for language 0176, a change to the capability policy's reviewed configuration (see `docs/capability-policy-iam-review.md` at the repository root) — not done. It is not pinnable either. Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later (see `languages/l0000/CLAUDE.md`).

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored build outputs; `src/lexicon-additions.json` and `tests/conformance/*.json` are generated, not edited.
