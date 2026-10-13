# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## What this is

`languages/l0003r` is L0003 **in Rust**: a child language of L0000 that adds `hello`, `image`, `theme` and `id`. It is a Cargo workspace beside the TypeScript implementation in `languages/l0003`, which is unchanged and is what the `l0003` service runs.

- `crates/core` (`graffiticode-l0003`) — the whole dialect, in `src/lib.rs`: `L0003` implements `Dialect` from `graffiticode-l0000`, and `lexicon()` is the base lexicon merged with `src/lexicon-additions.json`.
- `crates/server` (`l0003r-server`, binary `l0003r`) — `l0000r_server::serve(L0003, lexicon())`. Routes, auth, static serving and environment handling all live in `languages/l0000r/crates/server`.
- `tools/build-static.mjs` — assembles `./static` by running `../l0003`'s core, static and View builds and copying their output.

**It depends on two sibling directories by relative path.** `../l0000r` supplies the kernel and the server as Cargo path dependencies (`../../../l0000r/crates/...`); read `languages/l0000r/CLAUDE.md` for how evaluation, values and the `Dialect` trait work. `../l0003` supplies the static assets, the conformance fixtures and the lexicon additions. This workspace has its own `Cargo.lock`, so after changing `l0000r`'s dependencies run `cargo update -w` or a plain `cargo build` here before a `--locked` build.

## Commands

Run from this directory:

```bash
cargo test            # conformance + dialect tests; needs no Node and no network
npm run build         # build:static, then cargo build --release -p l0003r-server
npm run build:static  # node tools/build-static.mjs → ./static (runs npm ci in ../l0003 if needed)
npm run dev           # cargo run -p l0003r-server on :50003 with AUTH_URL=http://127.0.0.1:4100
npm run lint          # cargo clippy --all-targets -- -D warnings
npm run format        # cargo fmt
npm run fixtures      # build ../l0003's core, then regenerate tests/conformance/cases.json and src/lexicon-additions.json
```

## The dialect

`Dialect::eval` handles the four tags and overrides `PROG`; everything else is the kernel.

- `hello x` → `{ hello: x }`, `image url` → `{ image: url }`.
- `theme DARK|LIGHT body` and `id "name" body` → the label beside the body's fields. A record body keeps its fields; a tag contributes `tag`; a scalar or list goes under `value`.
- **Upstream data wins.** The form posts its state back as the task's data, so every one of these results, and any program result that is a record (`PROG`), has the upstream data laid over it. `hello` keeps an edited greeting where it stands. A result that is not a record passes through unmerged.
- `Dialect::check` requires `theme`'s first argument to be the literal tag `DARK` or `LIGHT` and `id`'s to be a literal string, for every such node reachable from the root, and points the error at the argument.

`print` needs no handler here: the kernel's is the same.

### Conformance

`crates/core/tests/conformance/generate.mjs` parses a corpus with L0003's TypeScript lexicon (parser from `../l0000/node_modules`), compiles each program against several upstream inputs with `@graffiticode/l0003`, and writes `cases.json`. `tests/conformance.rs` requires identical data for every case and the same errors, comparing check errors up to "Got": the Rust message names what was found more clearly than TypeScript's ("the string "dark"" rather than "tag dark"). There are no other divergences.

The TypeScript L0003 depends on the published `@graffiticode/l0000` 0.8, which is older than the kernel here. The Rust dialect therefore also has what the base language gained since (exact numbers, `format-number`), and the lexicon it serves includes those words.

## Deployment

Its own Cloud Run service, `l0003r`, public, running as `l0003r-run@graffiticode.iam.gserviceaccount.com`, released from the repository root with `npm run deploy -- l0003r` (entry in root `deploy.json`, image from `configs/Dockerfile.l0003r.yaml`). The snapshot includes `languages/l0003r`, `languages/l0000r` (the path dependencies) and `languages/l0003` (the static assets). The only build step is `cargo test --locked`. The deploy CLI does not provision: the service and its account must exist first (`packages/deploy/README.md`).

Nothing routes to it by default. Send traffic with a per-user `lang-overrides/{uid}` binding for `L0003`, `BASE_URL_L0003` on the API, or by repointing `l0003.graffiticode.org`.

There is no Dockerfile in this directory: its build context would not reach the siblings. Build locally from the repository root with `docker build -f configs/Dockerfile.l0003r.yaml .`.

## Conventions

- `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean.
- SPDX `// SPDX-License-Identifier: MIT` headers on source files.
- `static/` and `target/` are build outputs — gitignored, which also keeps them out of the deploy snapshot.
- Don't edit `src/lexicon-additions.json` or `tests/conformance/cases.json` by hand; they are generated.
