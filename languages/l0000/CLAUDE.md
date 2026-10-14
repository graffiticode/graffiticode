# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Two implementations live here.** `packages/` is the TypeScript L0000 that production runs; `crates/` is L0000 in Rust, released to a separate service. Everything from "Repo shape" down to "The Rust implementation" describes the TypeScript side.

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

Arithmetic uses `decimal.js`. A number value is a JS number when that number is exactly its decimal value, and a `Decimal` only when a JS number would round it (`12345678901234567890`); `numberValue()` in `compiler.ts` makes that choice and every literal and exact result goes through it. Quotients and powers that decimal.js has to round stay JS numbers. So a dialect sees ordinary values as JS numbers, but code that accepts numbers should use `isNumber()` / `sameValue()` rather than `typeof === "number"` / `===`. The Renderer converts any remaining `Decimal` to a JS number, so output is unchanged JSON. The `Decimal` default-export normalization at the top of `compiler.ts` exists because the package is consumed as both CJS and ESM across the toolchain — don't "simplify" that import.

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

The server ships as a single Docker image deployed to Cloud Run as service `l0000` in project `graffiticode`, running as `l0000-run` (no roles). The image: `npm ci` from the lockfile → `npm run build` (the full core→static→api→view→embed→assemble chain) → `npm prune --omit=dev` (runtime only runs compiled JS, so devDeps are dropped) → `npm start`. Cloud Run injects `PORT`; the server reads it (default `50000`). `AUTH_URL=https://auth.graffiticode.org`. The service is public, matching the app's own "static assets and `/compile` are public" posture.

Release it with the monorepo's deploy CLI, from the repository root: `npm run deploy -- l0000` (config in root `deploy.json`, image from `configs/Dockerfile.l0000.yaml`). It tests, builds, deploys a no-traffic candidate, checks `/` and `/lexicon.js`, then promotes. `npm run gcp:logs` tails the Cloud Run logs. The local `Dockerfile` builds the same image from this directory.

## Conventions

- SPDX `// SPDX-License-Identifier: MIT` headers on `.ts` source files.
- `@typescript-eslint/no-explicit-any` is **off** project-wide — the compiler is intentionally dynamic (index-signature dispatch, CPS callbacks). Don't introduce strict types that fight the AST dispatch pattern.
- Prettier governs formatting (`.prettierrc`).
- `dist/`, `dist-embed/`, and `packages/api/static/` are build outputs — gitignored.

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0000**. `packages/core` and `packages/api` are the TypeScript compiler and server: they are what production runs (Cloud Run service `l0000`, pinnable), and `@graffiticode/l0000` on npm is what TypeScript child languages extend. `crates/` is the same language in Rust, released to its own service `l0000r` so it can be vetted and soaked before it replaces the TypeScript. `packages/view` (the React `/form` view) and the spec are shared by both. The intended end state is this one directory with the Rust server and the TypeScript view; until then, a language change goes into the TypeScript first, then `npm run rust:fixtures`, then the Rust until `cargo test` passes.

- `crates/core` (`graffiticode-l0000`) — the language: AST, values, evaluator, lexicon, and the `Dialect` trait that Rust child languages implement.
- `crates/server` (`l0000r-server`, binary `l0000r`) — axum language server. `/compile`, `/preflight`, `/form`, and the public static assets.
- `tools/assemble-static.mjs` — builds `packages/core`'s static assets and `packages/view`'s embed bundle and copies them into `./static`, which the Rust server serves. (The TypeScript server's copy is `packages/api/static`, assembled by `npm run build`.)

```bash
cargo test            # all Rust tests; needs no Node and no network
cargo test -p graffiticode-l0000 --test conformance
npm run rust:build    # rust:static, then cargo build --release -p l0000r-server
npm run rust:static   # node tools/assemble-static.mjs → ./static
npm run rust:dev      # cargo run -p l0000r-server on :50000 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then regenerate crates/core/tests/conformance/* and crates/core/src/lexicon.json
```

Rust server env vars: `PORT` (default `50000`), `AUTH_URL` (default `https://auth.graffiticode.org`), `STATIC_DIR` (default `static`, relative to the working directory), `LOG_LEVEL` (a `tracing` filter, default `info`), `GRAFFITICODE_API_URL`, `GRAFFITICODE_SECRET_KEY` / `GRAFFITICODE_SECRET_KEYS`. For egress (ISOLATE-01): `HTTPS_PROXY`/`HTTP_PROXY` and the CA in `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` (see `egress.rs`). For chain admission: `POLICY_URL` (without it a planned stage is refused), `BROKER_URL` (only a language with protected functions needs it), `PREFLIGHT_GATEWAYS` (gateway accounts allowed to call `/preflight`; none means every preflight is refused), and the revision identity `K_REVISION` and `GC_IMAGE_DIGEST`.

### The kernel (`crates/core`)

```
parser (JS, upstream) → AST pool (JSON) → Dialect::normalize → Ast::from_json → admission → check → Evaluator → Value → JSON
```

The server never parses source: `/compile` receives the AST the API's parser produced. `Compiler::compile(code, data, config, identity)` takes that JSON and returns a `Compilation { result, effects }`.

- `ast.rs` — `Ast::from_json` resolves the pool once into `Node` (typed literals, or `Form { op, elts }`). `Op` is an enum of every kernel tag plus `Op::Dialect(tag)` for tags the kernel does not define. `Ast::reachable()` lists the nodes a program can evaluate, for a dialect's own checks.
- `value.rs` — `Value` (`Undefined`, `Null`, `Bool`, `Num`, `Str`, `Tag`, `List`, `Record`, `Lambda`). `Record` keys are `Key::{Tag, Str, Num}`; `Record::get` has the tag↔string fallback and no number fallback. JSON objects from upstream become records with tag keys; `{"tag": "x"}` reads back as a tag. JSON text is written with `json_text`, which writes every number exactly as `JSON.stringify` does (through `format_number`): `12345678901234567000`, not serde's `1.2345678901234567e19`; `1e+21`. The server answers `/compile` with it, and conformance tests compare it. Do not turn on `serde_json`'s `arbitrary_precision` instead: it reaches every crate in a language's build and breaks `chromiumoxide` (l0013's capture hangs).
- `number.rs` — `Number` and decimal arithmetic (20 significant digits, half-up) over `bigdecimal`, standing in for `decimal.js`. A `Number` is `Float(f64)` whenever an `f64` holds the value and `Exact(BigDecimal)` only when it would round (`12345678901234567890`), so equal values are always the same variant. `Decimal::evaluate` makes that choice for every result; quotients and powers that had to be rounded stay `f64`. Output is always `f64`.
- `format.rs` — `format-number`: Excel number-format patterns, exact decimal rounding half away from zero. A literal pattern is validated in `check.rs`, a computed one when used.
- `eval.rs` — direct-style async evaluator. Errors accumulate in a diagnostics list and evaluation continues with a neutral value, so one compile reports everything; any error means no result. Recursion is heap-allocated per node and grows the stack on demand (`stacker`), so depth is bounded by `MAX_DEPTH`, not the thread stack.
- `check.rs` — reports every `ERROR` node reachable from the root (the parser's syntax errors), unresolved `get-val-*`, and bad literal `format-number` patterns.
- `dialect.rs` — the extension point (`Evaluator::error_count` and `Evaluator::var` let it see whether its arguments failed and what `set-var` set; `cacheable() == false` makes the server answer `cache: false`). A child language implements `Dialect::eval` for its tags, may claim kernel operators via `overrides` (and defer with `Evaluator::eval_kernel`), declares its protected functions and their `registry_version`, and may `normalize` a stored program into the one that runs. `L0000` is the dialect with nothing added.
- `lexicon.rs` — `Lexicon::base()` and `Lexicon::merge`, which refuses an undeclared collision and a stale override. `src/lexicon.json` is **generated** from `packages/core/src/lexicon.ts` by `npm run rust:fixtures`; edit the TypeScript.
- `exec.rs` — the per-invocation `ExecContext`. `invoke` is the only way to make a protected call; the outcome of every write is recorded as a `ProtectedEffect`, which is returned with the result even when the compile fails. `state::<T>()` is a dialect's own per-invocation state (L0176 keeps its save plans there). `open_system_session(lang, function)` is for a compile with no connection: it asks policy for a system session (`PolicyClient::preview_session`) once per compile and grants that one function, never a write; it refuses a compile with a connection or one already granted anything.
- `protected.rs` — admission before anything runs: `admit` for an ordinary compile (skipped without a connection for a dialect whose protected functions `degrades_without_connection`, which then falls back on its own), `admit_planned` for a stage of an admitted plan (an `admission_token` in the `Identity`), which runs only if the binding policy signed matches the stage's own manifest.
- `preflight.rs` — `StageManifest` (digests of the stored and normalized program and the options, revision, image, required functions), `binding_problems`, `RevisionIdentity`. `Compiler::preflight` returns the manifest without running anything.
- `policy_client.rs` — the policy/broker HTTP client: snapshot, mint, execute (retried once on `token-expiring`), and verification of policy's signed session (ES256, via `/v1/jwks`) before its binding is believed. `MetadataIdTokens` is the Cloud Run identity source.
- `egress.rs` — ISOLATE-01: `client_builder()` is how every server and dialect builds an outbound client. With `HTTPS_PROXY` set it sends everything through the egress proxy except the metadata server (an explicit `reqwest::Proxy` ignores `NO_PROXY`, so that exclusion is set here) and adds the proxy's CA from `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`, refusing to start without it. `metadata_client()` is direct, follows no redirects and resolves only `metadata.google.internal`; `MetadataIdTokens::direct()` uses it. Don't build a `reqwest::Client` any other way (`scripts/check-egress-clients.js` in the monorepo checks).
- `canonical.rs` — the args digest (byte-for-byte with the monorepo's `packages/broker/src/canonical.js` (repository root); shared vectors in the tests).
- `error.rs` — `Diagnostic`: message and offsets, plus optional `code`, `category`, `stage`, `fn`, `step`.
- `schema.rs` — `SchemaSource` (injected into `Compiler`; `HttpSchemas` caches for an hour) and `LanguageSchema` validation via `jsonschema`.
- `secret.rs` — `Keyring` for `get-val-private`, in lockstep with the console's `secret-crypto.ts`.

Function application: functions are not values with bodies. `Evaluator::apply` evaluates the function's node with arguments pending; `LAMBDA` consumes them, `PAREN` and the last expression of a sequence forward them, everything else drops them. A lambda with no pending arguments (or too few) evaluates to `Value::Lambda` naming its unbound parameters.

#### Conformance

`crates/core/tests/conformance/generate.mjs` loads the parser from this directory's `node_modules` and the built TypeScript core from `packages/core/dist`, parses a corpus, compiles it with the TypeScript `Compiler`, and writes `cases.json` (AST + expected result), `programs.json` (ASTs for the toy dialect in `tests/kernel.rs`), `manifests.json` (stage manifests the TypeScript compiler computed, which the Rust one must reproduce digest for digest) and `src/lexicon.json`. `tests/conformance.rs` requires the same data for every case. Deliberate differences are listed in its `divergence` function with the reason — add to it rather than editing a fixture. Current ones: `equiv` is structural, a nested upstream object has a `length`, and a function returned from a function is a function value (TypeScript applied it to the outer call's arguments). The generator skips a case the TypeScript compiler never answers (`json` of invalid text throws from a timer); here that is an ordinary compile error.

Tests that need signing keys (policy's session key, Google's ID-token key) generate throwaway ones at run time; no key files are committed, and the deploy snapshot would drop `*.pem` anyway.

### The server (`crates/server`)

`app(state, static_dir)` in `src/lib.rs` builds the axum router, and `serve(dialect, lexicon)` reads the environment and runs it. `src/main.rs` is `serve(L0000, Lexicon::base())`; a child language's server is the same line with its own `Dialect` and merged lexicon (see `languages/l0003/crates`), so anything changed here changes every Rust language server. `AppState` holds the shared `Compiler`, a `TokenVerifier` (the auth service in production, a stub in tests), a `GatewayVerifier` for `/preflight`, and the revision name.

- `GET /` — health check.
- `POST /compile` — `{ code, data, config }` → `{ data, errors }`. Missing/falsy `code` or `data` → 400. A token (`?access_token=`, body `auth`, or `Authorization`) is verified against `AUTH_URL` to learn the uid; a rejected token is 401, no token is anonymous. The uid comes only from the verified token; `connectionId`, `invocationToken`, `stage` and `admissionToken` are read from the body into the invocation's `Identity`. The response adds `effects` when the compile made protected writes, and `revision` when the request carried an `admissionToken`.
- `POST /preflight` — for the gateway only (`src/gateway.rs`): `X-Caller-Identity` must be a Google ID token for a configured gateway account with audience `urn:graffiticode:0000`. `{ stage, lang?, code, config? }` → `{ status, data: { manifest } | { errors } }`, `Cache-Control: no-store`. It hashes `config`, never `options`, so it agrees with what a compile pins. Side-effect free.
- `GET /form` — `static/index.html`.
- `GET /lexicon.json`, `GET /lexicon.js` — the lexicon embedded in the binary. The still-deployed console requests `lexicon.js`, slices the body from the first `{` and `JSON.parse`s it, so the same JSON serves both; drop the `.js` route once the console migrates.
- Anything else — a file under `STATIC_DIR`, no directory indexes.

Everything is public and CORS-open, with `Cross-Origin-Resource-Policy: cross-origin` so the `/form` bundle loads in COEP-isolated iframes. Plain HTTP arriving through a proxy (`X-Forwarded-Proto` present and not `https`, host not `localhost`) is redirected to HTTPS. Tests drive the router in-process (`crates/server/tests/app.rs`).

### Deploying the Rust server

`l0000r` is its own Cloud Run service in project `graffiticode`, public, running as `l0000r-run@graffiticode.iam.gserviceaccount.com` (no roles). Release it from the repository root with `npm run deploy -- l0000r` (entry in root `deploy.json`, image `services/l0000r` from `configs/Dockerfile.l0000r.yaml`): a Node stage assembles `./static` from this directory's npm packages, a Rust stage builds `l0000r-server`, and the distroless runtime holds only the binary and `static/`. The only build step is `cargo test --locked`. The service and its account were provisioned by hand. The deploy CLI parses `gcloud run deploy --format=json`; gcloud on Python 3.9 appends a non-JSON line to that output, so run it with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later.

**It is deliberately not the `l0000` service.** `l0000` is `pinnable` under protected execution: every reachable revision there must be recorded as approved, and an admitted plan pins its L0000 stage to one. The `l0000r` service is not pinnable and sets neither `POLICY_URL` nor `PREFLIGHT_GATEWAYS`, so it fails closed: a stage of an admitted plan is refused there, and so is every `/preflight`. Ordinary compiles work. Never point the `l0000r` entry at the `l0000` service without also giving it that entry's `pinnable`, `baselines` and `env`.

Nothing routes to `l0000r` by default. Send traffic with a per-user `lang-overrides/{uid}` Firestore binding for `L0000` (the API applies it within 10 seconds), `BASE_URL_L0000` on the API, or by repointing `l0000.graffiticode.org`. The Rust server is not byte-identical to the TypeScript one (see the divergences under "Conformance", and reworded error messages).

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; SPDX headers; `static/` and `target/` are gitignored build outputs (which also keeps them out of both services' deploy snapshots); `crates/core/src/lexicon.json` and the conformance JSON are generated, not edited. `.prettierignore` keeps `npm run format` off them.
