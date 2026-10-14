# CLAUDE.md

Guidance for Claude Code when working in this directory.

## What L0184 is

L0184 is a Graffiticode dialect for **charts**, drawn with Apache ECharts 6: BAR, LINE, PIE
(donut, rose) and SCATTER plots, over data written inline or in datasets referred to by column
name, one chart or a collection of charts shown as tabs. It replaces L0173 (a legacy
`@graffiticode/basis` language), and does NOT accept L0173 programs. It is built on
`@graffiticode/l0000` ^0.6.0 and `@graffiticode/l0000-view` ^0.4.0.

It lives in the graffiticode monorepo as a **self-contained npm project**: its own lockfile,
install, build and tests, all run from this directory.

> **Two implementations live here.** `packages/` is the TypeScript L0184 that production runs; `crates/` is L0184 in Rust. Everything down to "The Rust implementation" describes the TypeScript side.

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

Release from the **graffiticode repository root**: `npm run deploy -- l0184` (deploy CLI; entry
in root `deploy.json`, image from `configs/Dockerfile.l0184.yaml`, runtime `l0184-run`).

## The language

Style: `console/docs/language-style-typed-chains.md`. Four construct shapes:

- CONTAINER (arity 2): a member list, then a settings chain — `charts`, `chart`, `datasets`,
  `axes`, `plots`.
- MEMBER (arity 1): one description chain — `dataset`, `axis`, `plot`, `legend`, `tooltip`.
- PROPERTY (arity 2): a value, then the rest of the chain — everything else, incl. `label`,
  whose value is itself a description.
- TAG (arity 0): an UPPERCASE closed-set value — `kind BAR`, `theme DARK`, `scale LOG`.

Every program is one `charts [ … ] settings {}..`, even for a single chart (mirroring L0179's
`sheets [ sheet … ]`). Collection settings go after the OUTER `]`; chart settings after the
chart's `]`.

**No L0000 word is overridden** (`mergeLexicon` has no `overrides`): bounds are
`min-value`/`max-value` and a log axis is `scale LOG`, because `min`, `max` and `log` are
L0000's. Never shadow `data`, `use`, `map`, `filter` either — L0000 expressions must keep working
inside a program (tested).

## How the core is organized

- `attributes.ts` — the vocabulary as data: `chainFields`, `memberFields`, `containerFields`,
  the legality tables (`validAttributes`, `plotKindAttributes`, `validSettings`,
  `containerParts`, `labelPositions`), `checkValue`, and the error helpers (`hintFor`,
  `assertKnown*`). Adding a word is a row here; handlers are generated from it.
- `compiler.ts` — generated handlers; the containers and PROG are hand-written. PROG's Checker
  reports a `{}` that ended a description early (an L0184 word or a bare `{}` anywhere but last);
  L0000 expressions before the program are allowed.
- `collection.ts` — chart ids and names, navigation defaults, shared datasets, the envelope.
- `chart.ts` — one chart: dataset selection, column resolution, axes and id references, the
  per-kind data contract, legend/tooltip defaults, layout, lowering to an ECharts option.
- `data.ts` — dataset normalization (list rows, record rows, `{rows, columns}`, integer-keyed
  records from L0000's `DATA`), scopes and shadowing, and the list-or-column rule.
- `colors.ts` — Tailwind tokens and hex; anything else is a compile error.

Rules the code enforces, each with a test: one `plots` per chart and at most one of each other
part; ids unique after defaults (charts c1…, datasets d1…, axes x1/y1…, plots p1…); references by
id, omitted only when exactly one compatible target exists; legend names unique while a legend
shows; `null` is a gap (never 0) where a kind can show one; LOG values above 0 (nulls skipped);
LINE is `values` OR `x`/`y`, never both; SCATTER is `x`/`y`, never `values`; a chart is `empty`
only when every plot has nothing to draw. The output never contains `dataset`/`encode` and never
carries upstream `options.data`.

## Output

`{type: "charts", charts: [{id, name, option, view: {width, height, empty, description}}],
view: {theme, renderer, locale, showTabs, hideMenu, title?, instructions?, background?}}` —
always complete, because the shared View shallow-merges top-level keys. `spec/schema.json` is
strict for the envelope and the view records; `option` is compiler-owned and checked by the
compiler tests. The canvas is transparent unless `background` is set; the viewer paints the
theme's background.

## The view

`packages/view` exports `Form` and `./style.css` — the contract the MCP server's widget registry
relies on. `EChart` creates an instance only when its container is visible and sized, resizes
through a ResizeObserver that skips 0×0 updates, replaces the option with `notMerge` only when the
stable serialization of `option`+formats changed, recreates on theme/renderer/locale change, and
disposes only on unmount — charts on hidden tabs stay mounted, keeping zoom and legend state.
`ChartChrome` implements the WAI-ARIA tabs pattern and a keyboard-operable menu. ECharts is
tree-shaken in `lib/echarts.ts`: registering a chart there is the second half of adding a kind.

Testing a live resize in an automated browser needs a rendered frame: a background tab reports
`visibilityState: "hidden"` and runs no ResizeObserver callbacks.

## Spec files (`packages/core/spec`)

`instructions.md` is the generator's system prompt (its tables are guarded by `docs.test.ts`
against the legality tables); `spec.md` renders to `spec.html` via spec-md, which reads bare
`{…}` in prose as a reference — keep braces inside code spans; `examples.md` holds RAG prompts,
never programs; `scope.json` names the sibling languages; the word tables in both files are
generated from the lexicon.

## Roadmap

Phase 1 (this) is bar/line/pie/scatter parity with L0173 plus datasets, axes and multiple charts.
Phases 2–4 (analytical plots; annotations and visual mapping; formatting and interactivity) need
their deferred contracts specified before implementation. Composition with L0185 (fetch and shape
data, L0170's successor on L0000) is planned: `data use "0185"` supplies a dataset's rows.

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0184**. `packages/core` and `packages/api` are the TypeScript compiler and server, which production runs (Cloud Run service `l0184`). `crates/` is the same language in Rust, released to its own service `l0184r` so it can be vetted before it replaces the TypeScript. `packages/view` (the ECharts Form), the spec and the static assets are shared by both. A language change goes into the TypeScript first, then `npm run rust:fixtures`, then the Rust until `cargo test` passes.

- `crates/core` (`graffiticode-l0184`) — `L0184` implements `Dialect` from `graffiticode-l0000`; `lexicon()` is the base lexicon merged with `src/lexicon-additions.json` (no base word is redefined). `src/lib.rs` dispatches every word by its row in the vocabulary (property, member, container) and holds the containers and PROG; `src/vocab.rs` is `attributes.ts` (`checkValue`, `hintFor`, `assertKnown*`) over `src/vocab.json`; `src/chart.rs`, `src/collection.rs`, `src/data.rs`, `src/colors.rs` and `src/stats.rs` are their TypeScript namesakes. `src/js.rs` is the plain JavaScript value a TypeScript handler sees after `toPlainObject` (`undefined`, key order, `String()`, `JSON.stringify`, `trim`, property reads that fail on `null` as JavaScript's do); `src/date.rs` is V8's `Date.parse`.
- `src/vocab.json` and `src/lexicon-additions.json` are **generated**: the vocabulary and legality tables and the example descriptions from `attributes.ts`, and the Tailwind table read out of `colors.ts`. Edit the TypeScript and regenerate.
- `crates/server` (`l0184r-server`, binary `l0184r`) — `l0000r_server::serve(L0184, lexicon())`.
- `tools/assemble-static.mjs` — builds `packages/core`'s static assets and `packages/view`'s embed bundle into `./static`, exactly what `npm run build` assembles into `packages/api/static`.

**The Rust side depends on `languages/l0000` by relative path.** Read "The Rust implementation" in `languages/l0000/CLAUDE.md`.

```bash
cargo test            # conformance and unit tests; needs no Node and no network
npm run rust:build    # rust:static, then cargo build --release -p l0184r-server
npm run rust:dev      # cargo run -p l0184r-server on :50184 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then regenerate src/*.json and the fixture
```

### What was not ported, and why

- **ECharts stays in the view.** The compiler does not call ECharts or any other npm library: it writes an ECharts option as plain data, and only `packages/view` renders it. So nothing needed a Node worker (as `languages/l0014` has for TransLaTeX); the whole compile path is Rust.
- The view, the spec, `build-static.js`, `tools/fixtures.ts` and the TypeScript tests stay TypeScript.

### What the Rust must get exactly right

- **Error order and wording.** The first problem found is the one reported, so checks run in the TypeScript's order; messages are byte-identical (they are a product surface: the generator reads them and retries).
- **JavaScript values.** `undefined` versus `null` (a list item never set is refused, not a gap), `String()` of numbers, `JSON.stringify` quoting, `trim`'s white space, integer-like keys first, `Object.keys` of a string, and the `TypeError` a `null` record literal raises (`Cannot read properties of null (reading 'id')`).
- **`Date.parse`.** A TIME axis accepts what V8 accepts, legacy grammar included (`"Mar 1, 2026"`, `"1"`, `"abc 2026"` are dates; `"2026 abc"` is not). `date.rs` ports V8's `DateParser`, `MakeDay` and the ±8.64e15 ms range, with local time taken as UTC as on the server; the generator runs with `TZ=UTC` for the same reason.
- **Numbers.** Histogram edge labels are `String(Number(x.toPrecision(p)))`: rounding half up on the double's exact decimal value (`stats::to_precision`), not Rust's half-even. R-7 quartiles, Sturges' rule, `niceCeil` and `constantRange` follow `stats.ts` operation for operation.
- **The program's value** must be a `charts` envelope built by L0184's own words: a record literal `{type: "charts"}` is refused, as in TypeScript (where it is still L0000's internal record). The words' outputs are kept in `ExecContext::state` to tell them apart.

### Conformance

`crates/core/tests/conformance/generate.mjs` writes `cases.json` (2,864 cases, about 5MB): every word with a good value in every description and with every wrong value of its type in its own; every plot word on every plot kind, every pair of kinds in one chart, every label position; every tag in every tag slot, and quoted spellings; every scale in each direction with categories, bounds, positions and rotations; every Tailwind token and hex form and near misses; histogram, box-plot, radar, heatmap and gauge number sweeps; 110 date strings on a TIME axis; datasets and upstream rows (`data {}` and `data use "0185"` against L0185's schema, with list, record and empty upstreams); the spec's programs; **every program the TypeScript suite compiles, with its data**, recorded while vitest runs (`record.config.mjs` and `record.setup.mjs` wrap `parser.parse` and `Compiler.compile`); and hand-written edge cases, including fields written as record literals. Every error message in the TypeScript source appears in it, except the few no program can reach. `tests/conformance.rs` requires the same JSON text or the same errors for all of them but the difference below; the server returns `{"data":…,"errors":[]}` for every non-error case.

### Deliberate differences

None in the fixture. (A number of 2^64 or more, `values [1e20]`, once came out as `1e+20`; the kernel now writes every number as `JSON.stringify` does, `100000000000000000000`.)

### Deploying the Rust server

`deploy.json` has an `l0184r` entry (own service, `l0184r-run@graffiticode.iam.gserviceaccount.com`, image from `configs/Dockerfile.l0184r.yaml`, snapshot this directory and `languages/l0000`, build step `cargo test --locked`, env `AUTH_URL` only). L0184 has no secrets and no protected functions. The only network call at compile time is the kernel's, for `data use "<lang>"`: the upstream language's `schema.json` from `GRAFFITICODE_API_URL` (default `https://api.graffiticode.org`), as the TypeScript does. Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later (see `languages/l0000/CLAUDE.md`). The account needs no roles.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored build outputs; `src/vocab.json`, `src/lexicon-additions.json` and `tests/conformance/cases.json` are generated, not edited.
