# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## What this is

`languages/l0000r` is L0000, the root Graffiticode language, **in Rust**. It is a Cargo workspace beside the TypeScript implementation in `languages/l0000`, which is unchanged. Both implement the same language (the dialect's `lang_id` is `"0000"`), but they are **separate Cloud Run services**: `l0000` (TypeScript, pinnable, what production routes to) and `l0000r` (this one) — see "Deployment".

- `crates/core` (`graffiticode-l0000`) — the language: AST, values, evaluator, lexicon, and the `Dialect` trait.
- `crates/server` (`l0000r-server`, binary `l0000r`) — axum language server. `/compile`, `/form`, and the public static assets.
- `tools/build-static.mjs` — assembles `./static` by running `../l0000`'s core, static and View builds and copying their output. This project has no npm dependencies of its own; `package.json` only holds scripts.

**It depends on `../l0000` for three things**, all by relative path: the static assets (spec documents and the `/form` View bundle), the conformance fixtures, and the generated lexicon. A language change goes into the TypeScript first, then `npm run fixtures` here, then the Rust until `cargo test` passes.

## Commands

Run from this directory:

```bash
cargo test            # all Rust tests; needs no Node and no network
cargo test -p graffiticode-l0000 --test conformance
npm run build         # build:static, then cargo build --release -p l0000r-server
npm run build:static  # node tools/build-static.mjs → ./static (runs npm ci in ../l0000 if needed)
npm run dev           # cargo run -p l0000r-server with AUTH_URL=http://127.0.0.1:4100
npm start             # cargo run --release -p l0000r-server
npm run lint          # cargo clippy --all-targets -- -D warnings
npm run format        # cargo fmt
npm run fixtures      # build ../l0000's core, then regenerate crates/core/tests/conformance/* and crates/core/src/lexicon.json
```

Runtime env vars: `PORT` (default `50000`), `AUTH_URL` (default `https://auth.graffiticode.org`), `STATIC_DIR` (default `static`, relative to the working directory), `LOG_LEVEL` (a `tracing` filter, default `info`), `GRAFFITICODE_API_URL` (base for `use` schema fetches, default `https://api.graffiticode.org`), `GRAFFITICODE_SECRET_KEY` / `GRAFFITICODE_SECRET_KEYS` (keys for `get-val-private`). For chain admission: `POLICY_URL` (the policy service; without it a planned stage is refused), `PREFLIGHT_GATEWAYS` (comma-separated gateway service-account emails allowed to call `/preflight`; none means every preflight is refused), and the revision identity `K_REVISION` (set by Cloud Run) and `GC_IMAGE_DIGEST` (set by the deploy CLI), without which the compiler cannot be pinned by a plan.

## The Rust kernel (`crates/core`)

```
parser (JS, upstream) → AST pool (JSON) → Dialect::normalize → Ast::from_json → admission → check → Evaluator → Value → JSON
```

The server never parses source: `/compile` receives the AST the API's parser produced. `Compiler::compile(code, data, config, identity)` takes that JSON and returns a `Compilation { result, effects }`.

- `ast.rs` — `Ast::from_json` resolves the pool once into `Node` (typed literals, or `Form { op, elts }`). `Op` is an enum of every kernel tag plus `Op::Dialect(tag)` for tags the kernel does not define. `Ast::reachable()` lists the nodes a program can evaluate, for a dialect's own checks.
- `value.rs` — `Value` (`Undefined`, `Null`, `Bool`, `Num`, `Str`, `Tag`, `List`, `Record`, `Lambda`). `Record` keys are `Key::{Tag, Str, Num}`; `Record::get` has the tag↔string fallback and no number fallback. JSON objects from upstream become records with tag keys; `{"tag": "x"}` reads back as a tag.
- `number.rs` — `Number` and decimal arithmetic (20 significant digits, half-up) over `bigdecimal`, standing in for `decimal.js`. A `Number` is `Float(f64)` whenever an `f64` holds the value and `Exact(BigDecimal)` only when it would round (`12345678901234567890`), so equal values are always the same variant. `Decimal::evaluate` makes that choice for every result; quotients and powers that had to be rounded stay `f64`. Output is always `f64`.
- `format.rs` — `format-number`: Excel number-format patterns, exact decimal rounding half away from zero. A literal pattern is validated in `check.rs`, a computed one when used.
- `eval.rs` — direct-style async evaluator. Errors accumulate in a diagnostics list and evaluation continues with a neutral value, so one compile reports everything; any error means no result. Recursion is heap-allocated per node and grows the stack on demand (`stacker`), so depth is bounded by `MAX_DEPTH`, not the thread stack.
- `check.rs` — reports every `ERROR` node reachable from the root (the parser's syntax errors), unresolved `get-val-*`, and bad literal `format-number` patterns.
- `dialect.rs` — the extension point. A child language implements `Dialect::eval` for its tags, may claim kernel operators via `overrides` (and defer with `Evaluator::eval_kernel`), declares its protected functions and their `registry_version`, and may `normalize` a stored program into the one that runs. `L0000` is the dialect with nothing added.
- `lexicon.rs` — `Lexicon::base()` and `Lexicon::merge`, which refuses an undeclared collision and a stale override. `src/lexicon.json` is **generated** from `../l0000/packages/core/src/lexicon.ts` by `npm run fixtures`; edit the TypeScript.
- `exec.rs` — the per-invocation `ExecContext`. `invoke` is the only way to make a protected call; the outcome of every write is recorded as a `ProtectedEffect`, which is returned with the result even when the compile fails.
- `protected.rs` — admission before anything runs: `admit` for an ordinary compile, `admit_planned` for a stage of an admitted plan (an `admission_token` in the `Identity`), which runs only if the binding policy signed matches the stage's own manifest.
- `preflight.rs` — `StageManifest` (digests of the stored and normalized program and the options, revision, image, required functions), `binding_problems`, `RevisionIdentity`. `Compiler::preflight` returns the manifest without running anything.
- `policy_client.rs` — the policy/broker HTTP client: snapshot, mint, execute (retried once on `token-expiring`), and verification of policy's signed session (ES256, via `/v1/jwks`) before its binding is believed. `MetadataIdTokens` is the Cloud Run identity source.
- `canonical.rs` — the args digest (byte-for-byte with the monorepo's `packages/broker/src/canonical.js`; shared vectors in the tests).
- `error.rs` — `Diagnostic`: message and offsets, plus optional `code`, `category`, `stage`, `fn`, `step`.
- `schema.rs` — `SchemaSource` (injected into `Compiler`; `HttpSchemas` caches for an hour) and `LanguageSchema` validation via `jsonschema`.
- `secret.rs` — `Keyring` for `get-val-private`, in lockstep with the console's `secret-crypto.ts`.

Function application: functions are not values with bodies. `Evaluator::apply` evaluates the function's node with arguments pending; `LAMBDA` consumes them, `PAREN` and the last expression of a sequence forward them, everything else drops them. A lambda with no pending arguments (or too few) evaluates to `Value::Lambda` naming its unbound parameters.

### Conformance

`crates/core/tests/conformance/generate.mjs` loads the parser and the built TypeScript core from `../l0000` (by path — this project has no `node_modules`), parses a corpus, compiles it with the TypeScript `Compiler`, and writes `cases.json` (AST + expected result), `programs.json` (ASTs for the toy dialect in `tests/kernel.rs`), `manifests.json` (stage manifests the TypeScript compiler computed, which the Rust one must reproduce digest for digest) and `src/lexicon.json`. `tests/conformance.rs` requires the same data for every case. Deliberate differences are listed in its `divergence` function with the reason — add to it rather than editing a fixture. Current ones: `equiv` is structural, a nested upstream object has a `length`, and a function returned from a function is a function value (TypeScript applied it to the outer call's arguments). The generator skips a case the TypeScript compiler never answers (`json` of invalid text throws from a timer); here that is an ordinary compile error.

Tests that need signing keys (policy's session key, Google's ID-token key) generate throwaway ones at run time; no key files are committed, and the deploy snapshot would drop `*.pem` anyway.

## API server (`crates/server`)

`app(state, static_dir)` in `src/lib.rs` builds the axum router, and `serve(dialect, lexicon)` reads the environment and runs it. `src/main.rs` is `serve(L0000, Lexicon::base())`; a child language's server is the same line with its own `Dialect` and merged lexicon (see `languages/l0003r`), so anything changed here changes every Rust language server. `AppState` holds the shared `Compiler`, a `TokenVerifier` (the auth service in production, a stub in tests), a `GatewayVerifier` for `/preflight`, and the revision name.

- `GET /` — health check.
- `POST /compile` — `{ code, data, config }` → `{ data, errors }`. Missing/falsy `code` or `data` → 400. A token (`?access_token=`, body `auth`, or `Authorization`) is verified against `AUTH_URL` to learn the uid; a rejected token is 401, no token is anonymous. The uid comes only from the verified token; `connectionId`, `invocationToken`, `stage` and `admissionToken` are read from the body into the invocation's `Identity`. The response adds `effects` when the compile made protected writes, and `revision` when the request carried an `admissionToken`.
- `POST /preflight` — for the gateway only (`src/gateway.rs`): `X-Caller-Identity` must be a Google ID token for a configured gateway account with audience `urn:graffiticode:0000`. `{ stage, lang?, code, config? }` → `{ status, data: { manifest } | { errors } }`, `Cache-Control: no-store`. It hashes `config`, never `options`, so it agrees with what a compile pins. Side-effect free.
- `GET /form` — `static/index.html`.
- `GET /lexicon.json`, `GET /lexicon.js` — the lexicon embedded in the binary. The still-deployed console requests `lexicon.js`, slices the body from the first `{` and `JSON.parse`s it, so the same JSON serves both; drop the `.js` route once the console migrates.
- Anything else — a file under `STATIC_DIR`, no directory indexes.

Everything is public and CORS-open, with `Cross-Origin-Resource-Policy: cross-origin` so the `/form` bundle loads in COEP-isolated iframes. Plain HTTP arriving through a proxy (`X-Forwarded-Proto` present and not `https`, host not `localhost`) is redirected to HTTPS. Tests drive the router in-process (`crates/server/tests/app.rs`).

## Deployment

`l0000r` is its own Cloud Run service in project `graffiticode`, public, running as `l0000r-run@graffiticode.iam.gserviceaccount.com` (no roles). Release it from the repository root with `npm run deploy -- l0000r` (entry in root `deploy.json`, image `services/l0000r` from `configs/Dockerfile.l0000r.yaml`). The entry's `include` covers `languages/l0000r` **and** `languages/l0000`, because the image's Node stage builds the static assets from the TypeScript project; the Rust stage builds `l0000r-server`, and the distroless runtime holds only the binary and `static/`. The only build step is `cargo test --locked`. Smoke checks: `/` and `/lexicon.js`. The service and its account were provisioned by hand (the deploy CLI does not provision; see `packages/deploy/README.md`). The CLI parses `gcloud run deploy --format=json`, and gcloud running on Python 3.9 appends a line to that output (`An error occurred: module 'importlib.metadata' has no attribute 'packages_distributions'`), which fails the release after the candidate is created; run it with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later.

**It is deliberately not the `l0000` service.** `l0000` is `pinnable` under protected execution: every reachable revision there must be recorded as approved, and an admitted plan pins its L0000 stage to one. This service is not pinnable and sets neither `POLICY_URL` nor `PREFLIGHT_GATEWAYS`, so it fails closed: a stage of an admitted plan is refused here, and so is every `/preflight`. Ordinary compiles work. Never point the `l0000r` entry at the `l0000` service without also giving it that entry's `pinnable`, `baselines` and `env` — a release would otherwise promote an unapproved revision.

Traffic reaches this service only when something sends it here; nothing does by default:

- **One user**: seed `lang-overrides/{uid}` in Firestore with `bindings: { "L0000": "<this service's URL>" }`. The API applies it within 10 seconds, to that user's authenticated requests only.
- **Everyone**: set `BASE_URL_L0000` on the API and release it, or repoint `l0000.graffiticode.org` (the API's default host for the language) at this service.

The Rust server is not byte-identical to the TypeScript one (see the divergences under "Conformance", and reworded error messages).

There is no Dockerfile in this directory: its build context would not reach `../l0000`. Build locally from the repository root with `docker build -f configs/Dockerfile.l0000r.yaml .`.

## Conventions

- `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean.
- SPDX `// SPDX-License-Identifier: MIT` headers on source files.
- `static/` and `target/` are build outputs — gitignored, which is also what keeps them out of the deploy snapshot.
- Don't edit `crates/core/src/lexicon.json` or the conformance JSON by hand; they are generated.
