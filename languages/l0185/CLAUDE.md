# CLAUDE.md

Guidance for Claude Code when working in this directory.

## What L0185 is

L0185 is a Graffiticode dialect that **fetches and shapes data**: a public https GET (JSON or
CSV), inline `rows`, or a `let`-bound value, then steps that filter, reshape, summarize, sort and
join. It replaces L0170 (a legacy `@graffiticode/basis` language) and does NOT accept L0170
programs. Built on `@graffiticode/l0000` ^0.8.0 and `@graffiticode/l0000-view` ^0.4.0.

It lives in the graffiticode monorepo as a **self-contained npm project**: its own lockfile,
install, build and tests, all run from this directory.

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
