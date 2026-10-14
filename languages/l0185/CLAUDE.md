# CLAUDE.md

Guidance for Claude Code when working in this directory.

## What L0185 is

L0185 is a Graffiticode dialect that **fetches and shapes data**: a public https GET (JSON or
CSV), inline `rows`, or a `let`-bound value, then steps that filter, reshape, summarize, sort and
join. It replaces L0170 (a legacy `@graffiticode/basis` language) and does NOT accept L0170
programs. Built on `@graffiticode/l0000` ^0.8.0 and `@graffiticode/l0000-view` ^0.4.0.

It lives in the graffiticode monorepo as a **self-contained npm project**: its own lockfile,
install, build and tests, all run from this directory.

> **Two implementations live here.** `packages/` is the TypeScript L0185 that production runs; `crates/` is L0185 in Rust. Everything down to "The Rust implementation" describes the TypeScript side.

## Commands

```bash
npm install
npm run build      # core → build-static → api → view → view:embed → assemble
npm test           # core, api (needs the build: it serves static/), view
npm run lint
npm run typecheck
npm run -w packages/view dev             # /dev.html shows every spec program, compiled
(cd packages/core && npx tsx tools/fixtures.ts)   # refresh those fixtures
```

Release from the **graffiticode repository root**: `npm run deploy -- l0185` (deploy CLI; entry
in root `deploy.json`, image from `configs/Dockerfile.l0185.yaml`, runtime `l0185-run`, which
holds no roles).

## The language

**Right to left.** Every word is arity 2: its parameter, then the record to its right — the
State carrying the data so far. So the source (`fetch`, `rows`, `from`) is rightmost, just before
the one `{}`; a source's options (`parse`, `at`, `columns`) go to ITS right; steps stack to its
left, run right to left, and may repeat. `PROG` unwraps the State: **the output is the data and
nothing else** — no title, ids or envelope.

Functions of a record are L0000 lambdas, kept by node id and re-visited per row with
`{SYNC: true, args: [row]}` (L0000's `FILTER` pattern). A bare lambda parameter needs
parentheses (`where (<row: …>)`); inside a record value it does not.

**No L0000 word is overridden**: `limit`/`skip`/`where`/`derive`, not `take`/`drop`/`filter`/`map`
(those give a pointed error when used as steps). L0000's `eq` is numeric; `equiv` compares text.

## How the core is organized

- `attributes.ts` — the vocabulary as data: `stepFields` (role, expects, description, example),
  the tag sets, `TAGS`. Adding a word is a row here plus a function in `steps.ts`.
- `steps.ts` — one pure function per word over the State.
- `compiler.ts` — handlers generated from `stepFields`; `PROG` checks and unwraps; per-compile
  fetch dedupe (at most 10 URLs).
- `source.ts` — the Fetcher seam (`setFetcher`) and body parsing (JSON, CSV via Papa, HTML
  refused). Core never touches the network; the api installs the guarded fetcher, tests a
  fixture one (`harness.ts`).
- `paths.ts` — field lookup (exact key, then dot-path) and did-you-mean errors.

## Fetch security (`packages/api/src/fetch.ts`)

https only, port 443, no userinfo, denied internal host names; **every** resolved address checked
in the socket's lookup hook (closes DNS rebinding); manual redirects (≤3, each re-checked); 5 s
connect, 10 s per URL, 5 MB decoded; 60 s cache. Errors never echo a resolved IP. Authenticated
sources are the goal (`connection-id` is reserved and refused) — they go through the broker,
never raw proxying.

## The view

`packages/view` exports `Form` and `./style.css`. A list of flat records is a table (paged by
200, counts, Copy CSV/JSON); anything else is a collapsible JSON tree; errors are alerts. The
view never adds to the data.

## Spec files (`packages/core/spec`)

`instructions.md` is the generator's system prompt; `spec.md` renders via spec-md (keep braces in
code spans); `examples.md` holds RAG prompts, never programs, pointing only at the sample data
served from `/data` (`packages/core/data`); the word tables in both files are generated from the
lexicon and guarded by `docs.test.ts`.

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0185**. `packages/core` and `packages/api` are the TypeScript compiler and server, which production runs (Cloud Run service `l0185`). `crates/` is the same language in Rust, to be released to its own service `l0185r` so it can be vetted before it replaces the TypeScript. `packages/view` and the spec (with the sample data served at `/data`) are shared by both.

- `crates/core` (`graffiticode-l0185`) — `src/lib.rs`: `L0185` implements `Dialect` from `graffiticode-l0000`. A word evaluates its right-hand side, then its parameter (a function of the record is kept as its node and applied per record with `Evaluator::apply`), then its step. A `State` travels through the kernel (a `let`, a list, a `join`'s record) as a small record naming a state kept in the compile's `ExecContext::state`, which also holds the per-compile fetch dedupe. It claims `PROG` (checks and unwraps the state) and `take`/`drop`/`filter`/`map`/`last` (the pointed "not an L0185 step" error); its `check` is the TypeScript Checker's early-`{}` error.
  - `src/vocab.json` is **generated from `attributes.ts`** (`stepFields`, `TAGS`) by `npm run rust:fixtures`; `src/vocab.rs` reads it. `attributes.ts` stays the single source of truth.
  - `src/js.rs` — the data as JavaScript holds it (`Js`: `undefined`, NaN, `Date`, objects in JavaScript key order) with `JSON.stringify`, `String()`, `Number()`, `Object.entries` and spread. `src/steps.rs` — one function per word, as `steps.ts`. `src/paths.rs` — field lookup and did-you-mean. `src/source.rs` — the `Fetcher` seam and body parsing.
  - `src/csv.rs` — a port of the Papa Parse 5.7 paths the TypeScript uses (`header`, `dynamicTyping`, `skipEmptyLines: "greedy"`): line-ending and delimiter guessing, quotes, duplicate headers, `__parsed_extra`, its error messages.
  - `src/dates.rs` — `format`'s date patterns (`dates.ts`), and a port of V8's `Date.parse` (ISO 8601 plus the lenient legacy forms), which decides whether a string is a date.
  - `src/fetch.rs` (feature `http`, on by default) — the guarded fetcher, `packages/api/src/fetch.ts` on `reqwest`. See below.
- `crates/server` (`l0185r-server`, binary `l0185r`) — `l0000r_server::serve(L0185::default(), lexicon())`. `L0185::default()` fetches through the guarded fetcher; `L0185::with_fetcher` / `without_fetcher` are for tests.
- `tools/assemble-static.mjs` — builds the static assets, sample data and `/form` bundle into `./static` for the Rust server, as `npm run build` does into `packages/api/static`.

**The Rust side depends on `languages/l0000` by relative path.** Read "The Rust implementation" in `languages/l0000/CLAUDE.md`.

```bash
cargo test            # conformance and unit tests; needs no Node and no network
npm run rust:build    # rust:static, then cargo build --release -p l0185r-server
npm run rust:dev      # cargo run -p l0185r-server on :50185 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then (TZ=UTC) regenerate src/vocab.json, src/lexicon-additions.json and the fixture
```

**Not ported:** the view (`packages/view`), the spec and its tooling (`build-static.js`, `fixtures.ts`, the docs tests) stay TypeScript. No JavaScript library had to stay JavaScript: Papa Parse, `decimal.js` (the kernel's `Decimal`), `localeCompare` (`icu_collator`, root collation — what V8's default locale gives) and `Date.parse` are reproduced in Rust.

**What the Rust must get exactly right:** JavaScript object key order (array-index keys first); `JSON.stringify` (it is the key of grouping, `distinct`, `join` and `COUNT-DISTINCT`, and the 1 MB check); `String()`/`Number()`; `localeCompare` for sorting, MIN/MAX and string comparisons; decimal SUM/AVERAGE/MEDIAN (20 digits, half up); Papa's typing (a CSV ISO date-time is a `Date`, which the L0000 renderer turns into `{}` in the output); V8's date parsing in UTC; the renderer's `deepConvertRecords`.

### Fetching (`src/fetch.rs`)

Every `fetch` is a GET at compile time to the URL the program names, so this is an SSRF boundary, ported from `packages/api/src/fetch.ts`: https only, port 443, no userinfo; `localhost`, `*.localhost`, `*.local`, `*.internal`, `metadata.google.internal` refused; a literal IP, and **every** address a host name resolves to, must be public unicast (ipaddr.js 2.5's special ranges, IPv4-mapped IPv6 unwrapped), checked in the client's own DNS resolver so the connection uses exactly the addresses that passed; no proxy; redirects by hand, at most 3, each re-checked; 10 s per URL (redirects and body included), 5 s to connect; at most 5 MB decoded body (gzip, deflate, br); fixed headers (`user-agent: Graffiticode-L0185/1`); a 60 s in-process cache of at most 200 URLs, in-flight requests shared, failures not cached. Per compile a URL is fetched once, and at most 10 different URLs. No env and no secrets; `connection-id` is refused as in TypeScript. Output stays cacheable, as the TypeScript's is.

### Conformance

`crates/core/tests/conformance/generate.mjs` builds about 4,000 cases: every field of every sample data set (and test-only bodies) through every operator, aggregate, sort, `distinct`, `group-by`, `format`, `omit`, `rename`, `fill`, `spread`, `unnest`; every word given a value of each kind; every test-only body (CSV with CR/CRLF/tabs/semicolons/pipes, quotes, duplicate and numeric headers, ragged rows, BOM, typed values; JSON with numeric and duplicate keys, scalars; HTML) with each `parse`; number and date patterns; V8 date strings; Unicode sorting; then the spec's, the TypeScript suite's and hand-written cases. Fetching is a fixture on both sides, never the network: `https://example.org/<file>` and `https://l0185.graffiticode.org/data/<file>` read `packages/core/data/<file>`; `https://example.org/t/<name>` the bodies in `conformance/fetches.json`. `tests/conformance.rs` requires the same JSON text or the same error messages for every case but these deliberate differences (each with its own test):

- An L0000 error inside a function of the record (`<row: add "a" 1>`) is the Rust kernel's message (`Error in ADD operation: expected a number, got "a"`), not the TypeScript kernel's; where such a body has several kernel errors the Rust reports each, the TypeScript only the first.
- An integer beyond 2^53 and below 1e21 is written by the kernel's JSON serializer as `1.2345678901234567e+19` where `JSON.stringify` writes `12345678901234567000`. Same number.
- Not in the fixture: a field given an undefined L0000 value is absent in both outputs but still listed by the TypeScript's `Object.keys`; a record literal imitating a state's object form (`{__l0185: true}`) is just a record here.

### Deploying the Rust server

`deploy.json` has an `l0185r` entry (own service, `l0185r-run@graffiticode.iam.gserviceaccount.com`, image from `configs/Dockerfile.l0185r.yaml`, snapshot this directory and `languages/l0000`, build step `cargo test --locked`, env `AUTH_URL` only). Like `l0185`, it makes outbound HTTPS requests to whatever public host a program names; the distroless `cc` image carries the CA certificates. Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later. The account needs no roles.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored; `src/vocab.json`, `src/lexicon-additions.json` and `tests/conformance/*.json` are generated, not edited.
