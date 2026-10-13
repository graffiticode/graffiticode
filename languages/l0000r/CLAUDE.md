# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## What this is

`languages/l0000r` is L0000, the root Graffiticode language, **in Rust**. It is a Cargo workspace beside the TypeScript implementation in `languages/l0000`, which is unchanged. Both implement the same language (the dialect's `lang_id` is `"0000"`) and both release to the **same Cloud Run service, `l0000`** — see "Deployment".

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

Runtime env vars: `PORT` (default `50000`), `AUTH_URL` (default `https://auth.graffiticode.org`), `STATIC_DIR` (default `static`, relative to the working directory), `LOG_LEVEL` (a `tracing` filter, default `info`), `GRAFFITICODE_API_URL` (base for `use` schema fetches, default `https://api.graffiticode.org`), `GRAFFITICODE_SECRET_KEY` / `GRAFFITICODE_SECRET_KEYS` (keys for `get-val-private`).

## The Rust kernel (`crates/core`)

```
parser (JS, upstream) → AST pool (JSON) → Ast::from_json → admit protected functions → check → Evaluator → Value → JSON
```

The server never parses source: `/compile` receives the AST the API's parser produced.

- `ast.rs` — `Ast::from_json` resolves the pool once into `Node` (typed literals, or `Form { op, elts }`). `Op` is an enum of every kernel tag plus `Op::Dialect(tag)` for tags the kernel does not define.
- `value.rs` — `Value` (`Undefined`, `Null`, `Bool`, `Num`, `Str`, `Tag`, `List`, `Record`, `Lambda`). `Record` keys are `Key::{Tag, Str, Num}`; `Record::get` has the tag↔string fallback and no number fallback. JSON objects from upstream become records with tag keys; `{"tag": "x"}` reads back as a tag.
- `number.rs` — decimal arithmetic (20 significant digits, half-up) over `bigdecimal`, standing in for `decimal.js`.
- `eval.rs` — direct-style async evaluator. Errors accumulate in a diagnostics list and evaluation continues with a neutral value, so one compile reports everything; any error means no result. Recursion is heap-allocated per node and grows the stack on demand (`stacker`), so depth is bounded by `MAX_DEPTH`, not the thread stack.
- `check.rs` — reports every `ERROR` node reachable from the root (the parser's syntax errors) and unresolved `get-val-*`.
- `dialect.rs` — the extension point. A child language implements `Dialect::eval` for its tags, may claim kernel operators via `overrides` (and defer with `Evaluator::eval_kernel`), and declares protected functions. `L0000` is the dialect with nothing added.
- `lexicon.rs` — `Lexicon::base()` and `Lexicon::merge`, which refuses an undeclared collision and a stale override. `src/lexicon.json` is **generated** from `../l0000/packages/core/src/lexicon.ts` by `npm run fixtures`; edit the TypeScript.
- `exec.rs`, `protected.rs`, `policy_client.rs`, `canonical.rs` — the per-invocation `ExecContext`, protected-function admission, the policy/broker HTTP client, and the args digest (byte-for-byte with the monorepo's `packages/broker/src/canonical.js`; shared vectors in the tests).
- `schema.rs` — `SchemaSource` (injected into `Compiler`; `HttpSchemas` caches for an hour) and `LanguageSchema` validation via `jsonschema`.
- `secret.rs` — `Keyring` for `get-val-private`, in lockstep with the console's `secret-crypto.ts`.

Function application: functions are not values with bodies. `Evaluator::apply` evaluates the function's node with arguments pending; `LAMBDA` consumes them, `PAREN` and the last expression of a sequence forward them, everything else drops them. A lambda with no pending arguments (or too few) evaluates to `Value::Lambda` naming its unbound parameters.

### Conformance

`crates/core/tests/conformance/generate.mjs` loads the parser and the built TypeScript core from `../l0000` (by path — this project has no `node_modules`), parses a corpus, compiles it with the TypeScript `Compiler`, and writes `cases.json` (AST + expected result), `programs.json` (ASTs for the toy dialect in `tests/kernel.rs`) and `src/lexicon.json`. `tests/conformance.rs` requires the same data for every case. Deliberate differences are listed in its `divergence` function with the reason — add to it rather than editing a fixture. Current ones: `equiv` is structural, a nested upstream object has a `length`, and a function returned from a function is a function value (TypeScript applied it to the outer call's arguments).

## API server (`crates/server`)

`app(state, static_dir)` in `src/lib.rs` builds the axum router; `src/main.rs` reads the environment and serves it. `AppState` holds the shared `Compiler` and a `TokenVerifier` (the auth service in production, a stub in tests).

- `GET /` — health check.
- `POST /compile` — `{ code, data, config }` → `{ data, errors }`. Missing/falsy `code` or `data` → 400. A token (`?access_token=`, body `auth`, or `Authorization`) is verified against `AUTH_URL` to learn the uid; a rejected token is 401, no token is anonymous. The uid comes only from the verified token; `connectionId`, `invocationToken` and `stage` are read from the body into the invocation's `Identity`.
- `GET /form` — `static/index.html`.
- `GET /lexicon.json`, `GET /lexicon.js` — the lexicon embedded in the binary. The still-deployed console requests `lexicon.js`, slices the body from the first `{` and `JSON.parse`s it, so the same JSON serves both; drop the `.js` route once the console migrates.
- Anything else — a file under `STATIC_DIR`, no directory indexes.

Everything is public and CORS-open, with `Cross-Origin-Resource-Policy: cross-origin` so the `/form` bundle loads in COEP-isolated iframes. Plain HTTP arriving through a proxy (`X-Forwarded-Proto` present and not `https`, host not `localhost`) is redirected to HTTPS. Tests drive the router in-process (`crates/server/tests/app.rs`).

## Deployment

`l0000r` and `l0000` are two `deploy.json` entries for **one Cloud Run service**, `l0000` in project `graffiticode` (the `l0000r` entry sets `"service": "l0000"` and the same runtime account, `l0000-run`). From the repository root, `npm run deploy -- l0000r` releases the Rust server to it and `npm run deploy -- l0000` releases the TypeScript one; each release takes 100% of traffic, so whichever was deployed last is what serves language `0000`. Nothing else has to change to switch: the API already routes to that service.

- The two entries share the CLI's per-service lock, so they cannot release at once.
- `npm run rollback -- l0000r --release <id>` restores the traffic that preceded that release, which is how to go back to the TypeScript revision. It refuses if a later release owns traffic.
- Images stay distinguishable: Rust builds push to `services/l0000r`, TypeScript builds to `services/l0000`. Receipts in `.gc-deploy/` record which.
- The entry's `include` covers `languages/l0000r` **and** `languages/l0000`, because the image's Node stage builds the static assets from the TypeScript project; the Rust stage builds `l0000r-server`, and the distroless runtime holds only the binary and `static/`. The only build step is `cargo test --locked`. Smoke checks: `/` and `/lexicon.js`.

The Rust server is not byte-identical to the TypeScript one (see the divergences under "Conformance", and reworded error messages), so a release of `l0000r` changes behavior for every consumer of language `0000`, and for child languages only if they call this service — they compile with their own servers.

There is no Dockerfile in this directory: its build context would not reach `../l0000`. Build locally from the repository root with `docker build -f configs/Dockerfile.l0000r.yaml .`.

## Conventions

- `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean.
- SPDX `// SPDX-License-Identifier: MIT` headers on source files.
- `static/` and `target/` are build outputs — gitignored, which is also what keeps them out of the deploy snapshot.
- Don't edit `crates/core/src/lexicon.json` or the conformance JSON by hand; they are generated.
