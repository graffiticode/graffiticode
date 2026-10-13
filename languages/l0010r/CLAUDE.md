# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## What this is

`languages/l0010r` is L0010 **in Rust**: the composition-planning child of L0000, which adds one word, `plan`. It is a Cargo workspace beside the TypeScript implementation in `languages/l0010`, which is unchanged and is what the `l0010` service runs. It has the same shape as `languages/l0003r`.

- `crates/core` (`graffiticode-l0010`) — the whole dialect, in `src/lib.rs`: `L0010` implements `Dialect` from `graffiticode-l0000`, and `lexicon()` is the base lexicon merged with `src/lexicon-additions.json`.
- `crates/server` (`l0010r-server`, binary `l0010r`) — `l0000r_server::serve(L0010, lexicon())`. Routes, auth, static serving and environment handling all live in `languages/l0000r/crates/server`.
- `tools/build-static.mjs` — assembles `./static` by running `../l0010`'s core, static and View builds and copying their output.

**It depends on two sibling directories by relative path.** `../l0000r` supplies the kernel and the server as Cargo path dependencies (`../../../l0000r/crates/...`); read `languages/l0000r/CLAUDE.md` for how evaluation, values and the `Dialect` trait work. `../l0010` supplies the static assets, the conformance fixtures and the lexicon additions. This workspace has its own `Cargo.lock`, so after changing `l0000r`'s dependencies run a plain `cargo build` here before a `--locked` build.

## Commands

Run from this directory:

```bash
cargo test            # conformance + dialect tests; needs no Node and no network
npm run build         # build:static, then cargo build --release -p l0010r-server
npm run build:static  # node tools/build-static.mjs → ./static (runs npm ci in ../l0010 if needed)
npm run dev           # cargo run -p l0010r-server on :50010 with AUTH_URL=http://127.0.0.1:4100
npm run lint          # cargo clippy --all-targets -- -D warnings
npm run format        # cargo fmt
npm run fixtures      # build ../l0010's core, then regenerate tests/conformance/cases.json and src/lexicon-additions.json
```

## The dialect

`plan <list>` evaluates to `{ langs: [...] }`: the ordered languages a request is composed from, head first, each consuming the next. One id is an atomic plan; an empty list is no composition. Upstream data is not merged into it, and there is no `PROG` override.

`Dialect::check` is where a plan is validated, before anything runs, for every `PLAN` node reachable from the root. A plan must be **written out**: a list whose elements are literal language-id strings (three to five digits, `is_language_id`), none twice, at most `MAX_STAGES` (4). A bad plan is rejected rather than trimmed, and each error points at the offending element. A `let`-bound list or string is fine, because the parser inlines it; a computed list (`concat`, a parenthesized list) is rejected.

### Conformance

`crates/core/tests/conformance/generate.mjs` parses a corpus with L0010's TypeScript lexicon (parser from `../l0000/node_modules`), compiles each program with `@graffiticode/l0010`, and writes `cases.json`. `tests/conformance.rs` requires identical data and identical errors for every case. One deliberate difference is listed in its `divergence` function: TypeScript accepts `plan 158` and evaluates it to an empty plan; here a plan that is not a list is rejected, as `plan "0158"` already is on both sides.

The TypeScript L0010 depends on the published `@graffiticode/l0000` 0.8, which is older than the kernel here, so the Rust dialect also has what the base language gained since (exact numbers, `format-number`).

## Deployment

Its own Cloud Run service, `l0010r`, public, running as `l0010r-run@graffiticode.iam.gserviceaccount.com`, released from the repository root with `npm run deploy -- l0010r` (entry in root `deploy.json`, image from `configs/Dockerfile.l0010r.yaml`). The snapshot includes `languages/l0010r`, `languages/l0000r` (the path dependencies) and `languages/l0010` (the static assets). The only build step is `cargo test --locked`. The deploy CLI does not provision: the service and its account must exist first (`packages/deploy/README.md`).

Nothing routes to it by default. Send traffic with a per-user `lang-overrides/{uid}` binding for `L0010`, `BASE_URL_L0010` on the API, or by repointing `l0010.graffiticode.org`.

There is no Dockerfile in this directory: its build context would not reach the siblings. Build locally from the repository root with `docker build -f configs/Dockerfile.l0010r.yaml .`.

## Conventions

- `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean.
- SPDX `// SPDX-License-Identifier: MIT` headers on source files.
- `static/` and `target/` are build outputs — gitignored, which also keeps them out of the deploy snapshot.
- Don't edit `src/lexicon-additions.json` or `tests/conformance/cases.json` by hand; they are generated.
