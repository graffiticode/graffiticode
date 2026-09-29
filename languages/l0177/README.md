# L0177

[![License: MIT](https://img.shields.io/badge/Code-MIT-blue.svg)](packages/LICENSE)
[![License: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-lightgrey.svg)](LICENSE-DOCS)

L0177 is a Graffiticode dialect (child of [@graffiticode/l0000](https://www.npmjs.com/package/@graffiticode/l0000)) that acts as a **Learnosity Author API integration oracle**.

You describe an *integration design* — which authoring experience to embed in your app (item editor, item browser, activity editor, activity list) and how it's configured. L0177 validates the design, reports missing required properties as steering warnings, and returns a **host-language-neutral developer recipe**: goal, preconditions, procedure, gotchas, and runnable verification steps. You implement it in your own stack (Node, PHP, Ruby, .NET, …).

L0177 does **not** author assessment item content (that is L0176), does **not** sign or send Learnosity API requests, and does **not** emit runnable code.

This is an empirical integration oracle. Its knowledge combines Learnosity's published documentation with observations from direct API experiments. It checks the integration design and returns a host-language-neutral recipe that identifies known behavior, documented expectations, and remaining verification work.

When handling a recipe request, the oracle does not sign or send Learnosity API requests. The caller implements the recipe using their own credentials and environment. A complete design means the modeled inputs are present; it does not mean the integration has been verified in that environment.

## How it works

1. Describe the design — `create_item("L0177", "…embed the item editor for author u123 on lms.acme.edu, allowing only MCQ and cloze…")`.
2. Read back the normalized design plus `warnings` — `get_item(id)`. Design **holes** (missing `domain`, `user-id`, `reference`, or no view chosen) come first; once filled, specificity advisories surface.
3. Refine with `update_item` until the warnings clear (`complete: true`).
4. Get the recipe — `get_spec(id)` — and work its verification steps against your implementation.

The compiled output is the normalized design, not the deliverable. The recipe is the deliverable.

## The language

A program is one `author-embed` head with a chain of property functions and exactly one **view**, terminated with `{}` then `..`:

```
author-embed
  domain "lms.example.edu"
  user-id "u123"
  reference "algebra-item-1"
  organisation-id 100
  question-type-groups [MCQ CLOZE]
  item-edit [
    item back true scoring true reference-prefix "LEAR_" {}
    widget edit true delete false {}
  ]
  {}..
```

The grammar is uniform:

| Construct | Arity | Role |
| :-------- | :---: | :--- |
| `author-embed` | 1 | Head; takes the property + view chain. |
| `item-edit` `item-list` `activity-edit` `activity-list` | 2 | **Views** — take a `[list]` of members; the view selects the Learnosity mode. |
| `item` `widget` `settings` `filter-restricted` `toolbar` `player-playback` … | 1 | **Members** (14) — take a property chain. Which ones a view accepts, and which properties each takes, depends on the view. |
| `container` `widget-templates` `global` | 2 | **Sections** — take a property sub-chain. |

Every **property** is a lowercase-kebab **arity-2** function (`name value`) that chains; chains end with `{}`. Everything is optional — write only what you change.

| Context | Properties |
| :------ | :--------- |
| top-level | `domain`(str, req) · `user-id`(str, req) · `user-email` · `user-firstname` · `user-lastname` · `reference`(str) · `organisation-id`(num) · `question-type-groups`(group tags) · `allow-widgets`(widget tags) |
| sections | `container` (`height` `fixed-footer-height` `scroll-into-view-selector`) · `widget-templates` (`back` `save` `require-validation`) · `global` (`disable-onbeforeunload`) |
| views | 186 further options across `item-edit`, `item-list`, `activity-edit` and `activity-list` — see the [vocabulary reference](packages/core/spec/instructions.md) |

**Properties are scoped to the view they appear in**, because Learnosity's own config is:
`config.item_edit.item` and `config.item_list.item` are different nodes sharing one field name, and
`status` is a boolean in one place and a list of strings in another. A property used where the API
doesn't define it is dropped with a warning rather than emitted — under fail-open semantics an
ignored key is worse than an error. Every option the compiler accepts is reported with its exact
Learnosity path in `data.paths`.

Enum values are **UPPERCASE-kebab tags**, never quoted strings. Because function keywords are
lowercase-kebab, the two can never collide, and an unknown property is a parse error.

- **Question-type groups** (`question-type-groups`) — `MCQ` `CLOZE` `MATCH` `WRITE-SPEAK`
  `HIGHLIGHT` `MATH` `GRAPH` `CHART` `CHEMISTRY` `OTHER`: the ten panes of the editor's question
  picker, and the granularity at which the API restricts.
- **Widget types** (`allow-widgets`) — `MCQ` `SHORT-TEXT` `CLOZE-TEXT` `FORMULA` `TOKEN-HIGHLIGHT`
  and others, each mapping to Learnosity's exact lowercase type string.

Some values are records, written the way Learnosity receives them — content tags as
`[{type: "Grade", name: "4"}]`, item bank sources as
`[{organisation_id: 100, item_bank_name: "Math"}]`.

There is no in-UI switching between the four views, so the view you choose *is* the mode — each is a separate page and integration. All four are fully modeled: **193 configuration options**, every emitted path cross-checked against Learnosity's published reference.

See [`packages/core/spec/`](packages/core/spec/) for the full specification, examples, and authoring guide.

## The recipe states its own uncertainty

The Learnosity Author API **fails open on `config`**: an unrecognized key is silently ignored — the editor still initializes, `readyListener` still fires, and the page looks correct while enforcing nothing.

L0177 takes that seriously, and states plainly which of its options are enforced and which are not.

**`question-type-groups` is enforced.** Restricting the editor's question picker was verified
against the live API by comparing against a control: 10 groups and 51 templates unrestricted, 2 and
13 when restricted to multiple-choice and cloze. The recipe names the config path as fact.

**`allow-widgets` is not.** It names finer-grained question *types*, while the mechanism selects
question-type *groups*, and one group holds several types. No confirmed key restricts per type, so
the recipe carries it as intent plus a check — and the compiler warns when a design reaches for it
alone, expecting enforcement it will not get.

This distinction was expensive to learn. The restriction was once recorded as not working at all,
because a config that *added* a picker group left the editor looking untouched — the config was in
force and invisible. That is why verification steps here are **differential**: they load the editor
twice, once with the key omitted, because observing the behaviour you wanted proves nothing on its
own. Don't upgrade an unconfirmed binding from recalled documentation; a design being expressible is
not a promise that Learnosity enforces it.

## Structure

An npm workspaces monorepo with three packages:

- **`packages/core`** — `@graffiticode/l0177`: the language (vocabulary, checker, transformer, spec assets). Pure TypeScript, depends on `@graffiticode/l0000`. `src/vocab.ts` is the single source of truth — the lexicon and the compiler are both generated from it.
- **`packages/api`** — `@graffiticode/api-l0177`: the L0177 language server. Express app exposing `POST /compile`, `GET /form`, and public static assets. Runs on port `50177`.
- **`packages/view`** — `@graffiticode/l0177-view`: the React view component, built with Vite + Tailwind on top of `@graffiticode/l0000-view`.

The top-level build composes all three: `core`'s static assets and `view`'s embed bundle are assembled into `packages/api/static/`, which the API serves.

## Getting started

```bash
# Install dependencies
npm install

# Build everything (core → static assets → api → view → embed → assemble)
npm run build

# Start the dev server (API on :50177, Firestore emulator on :8080)
npm run dev
```

Other useful scripts:

- `npm test` — run the core unit tests (vitest)
- `npm run lint` — lint the whole monorepo
- `npm run pack` — build and pack the view package for distribution
- `npm run gcp:build` / `npm run gcp:deploy` — deploy to Cloud Run

## Environment

- `PORT` — API port (default `50177`)
- `AUTH_URL` — auth service URL (default `https://auth.graffiticode.org`; dev uses `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST` — local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV` — `development` or `production` (production forces HTTPS and switches request logging)

No Learnosity credentials are needed to run L0177: it produces a recipe, it does not call Learnosity. Your consumer key and secret belong in *your* integration, server-side.

## License

Code is licensed under MIT. Documentation and specifications are licensed under CC-BY 4.0.

**AI Training:** All materials in this repository — code, documentation, specifications, and training examples — are explicitly available for use in training machine learning and AI models. See [NOTICE](NOTICE) for details.
