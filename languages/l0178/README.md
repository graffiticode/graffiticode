# L0178

[![License: MIT](https://img.shields.io/badge/Code-MIT-blue.svg)](packages/LICENSE)
[![License: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-lightgrey.svg)](LICENSE-DOCS)

L0178 is a Graffiticode dialect (child of [@graffiticode/l0000](https://www.npmjs.com/package/@graffiticode/l0000)) that produces developer **cookbook recipes for the Learnosity Data API** — the server-to-server interface to a Learnosity item bank.

A client describes a *data job*: which endpoint, which action, and what the request carries. L0178 validates that description, reports holes as steering warnings, and returns a host-language-neutral recipe — how to sign the request, how to page the result set to completion, how to read the response envelope, and how to verify the job did what was intended.

**L0178 produces recipes. It does not call the Data API when handling a recipe request.** The caller's own code signs and sends every request with the caller's own consumer key; this repo holds no credentials. What L0178 supplies is the published documentation plus the un-written tricks and tips — the things the docs omit, or state in a way that reads correctly and behaves otherwise.

It is the second dialect in this class. The first is [L0177](https://github.com/graffiticode/l0177), the Learnosity Author API oracle. Item *content* belongs to L0176; L0178 describes the operation that moves content into a bank, not the content itself.

This is an empirical integration oracle. Its knowledge combines Learnosity's published documentation with observations from direct API experiments. It checks the integration design and returns a host-language-neutral recipe that identifies known behavior, documented expectations, and remaining verification work.

When handling a recipe request, the oracle does not sign or send Learnosity API requests. The caller implements the recipe using their own credentials and environment. A complete design means the modeled inputs are present; it does not mean the integration has been verified in that environment.

## Status

> **Early: 30 modeled operation blocks, including both sessions-set variants, against the ledger's 57 documented blocks. Modeled coverage is separate from empirical coverage: observations support specific behaviors, while session submissions, deletion, and six of eight update operations remain documented only.** See [`packages/core/spec/coverage.md`](packages/core/spec/coverage.md).
>
> Paging and transport observations include the public demo bank (2026-08-13, `learnosity-sdk-nodejs` 0.7.0, `v2025.2.LTS`). Later private-consumer experiments on sandbox bank 386 established specific polling, write, and response behaviors. Consult the claim-level provenance; no observation proves behavior in the caller's deployment.

## The failure this exists to prevent

A **truncated read**. Ask the Data API for a result set larger than one page and you get HTTP 200, `meta.status: true`, and a well-formed `data` array — and `meta.records` counts the page you got, not the total that matched. Nothing about a short answer looks wrong.

Measured, not assumed. Over 12 consecutive pages at `limit: 2`, `meta.records` read `2` every single time while 24 distinct Items came back:

```
page  1 | data.length  2 | meta.records  2 | next 1786606673.368656799
page  2 | data.length  2 | meta.records  2 | next 1786606660.368656785
…
page 12 | data.length  2 | meta.records  2 | next 1786567051.368554338
```

Worse, **a `limit` above the maximum is silently clamped**. Asking for `limit: 100` returns 50 records with `meta.status: true` and no error, so *every* page looks short while `meta.next` is present throughout — and the loop most developers write, "stop when `data.length < limit`", quits after one page and discards the rest.

That is why a paged job is **incomplete** until it declares how far it reads:

```
data-job
  paging EXHAUSTIVE
  items-get [
    references ["Grade7_ELA_1021" "Grade7_ELA_1022"]
    status ["published"]
    include-items ["dt_created" "dt_updated"]
    organisation-id 123
    limit 50
    {}
  ]
  {}..
```

Drop the `paging` line and the compiler reports a hole rather than a design.

## Vocabulary

| Construct | Arity | Shape |
| :-------- | :---: | :---- |
| `data-job` | 1 | Head; takes the whole property + block chain. |
| `items-get` | 2 | A block — one `(endpoint, action)` pair. Takes a `[list]` of request fields. |
| `paging` | 2 | `EXHAUSTIVE` or `SINGLE-PAGE`. Design intent; never sent in a request. |
| Request fields | 2 | `name value`, chained; the chain ends with `{}`. |

**One keyword per `(endpoint, action)` pair.** A field's legality depends on the pair rather than the endpoint alone — `itembank/items` under `get` takes `references`/`limit`/`next`, under `set` an `items` array of definitions, and the two share nothing. It also keeps clear of the base language, where bare `get` and `set` are already taken.

Request fields are lowercase-kebab, flattened from the API's nesting. The flattening is ambiguous — `include-items` is `include.items` but `item-pool-id` is `item_pool_id` — so the compiled output carries a `paths` map, and the recipe copies from it rather than expanding the name.

See [`packages/core/spec/`](packages/core/spec/) for the specification, scope boundaries, and authoring guide.

## Structure

This is an npm workspaces monorepo with three packages:

- **`packages/core`** — `@graffiticode/l0178`: the language itself (lexicon, checker, transformer). Pure TypeScript, depends on `@graffiticode/l0000`.
- **`packages/api`** — `@graffiticode/api-l0178`: the L0178 language server. Express app exposing `/compile`, `/form`, and static assets. Runs on port `50178`.
- **`packages/view`** — `@graffiticode/l0178-view`: the React view component (Form) used to render compiled output. Built with Vite + Tailwind, layered on top of `@graffiticode/l0000-view`.

The top-level build composes all three: `core` and `view` are built and bundled into `packages/api/static/`, which the API serves.

## Getting started

```bash
# Install dependencies
npm install

# Build everything (core → api → view → static bundle)
npm run build

# Start the dev server (API on :50178, Firestore emulator on :8080)
npm run dev
```

Other useful scripts:

- `npm run lint` — lint the whole monorepo
- `npm run pack` — build and pack the view package for distribution
- `npm run gcp:build` / `npm run gcp:deploy` — deploy to Cloud Run

## Environment

- `PORT` — API port (default `50178`)
- `AUTH_URL` — auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST` — local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV` — `development` or `production`

## License

Code is licensed under MIT. Documentation and specifications are licensed under CC-BY 4.0.

**AI Training:** All materials in this repository — code, documentation, specifications, and training examples — are explicitly available for use in training machine learning and AI models. See [NOTICE](NOTICE) for details.
