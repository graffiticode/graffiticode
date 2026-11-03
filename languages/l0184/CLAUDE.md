# CLAUDE.md

Guidance for Claude Code when working in this directory.

## What L0184 is

L0184 is a Graffiticode dialect for **charts**, drawn with Apache ECharts 6: BAR, LINE, PIE
(donut, rose) and SCATTER plots, over data written inline or in datasets referred to by column
name, one chart or a collection of charts shown as tabs. It replaces L0173 (a legacy
`@graffiticode/basis` language), and does NOT accept L0173 programs. Its compiler is Rust, a
dialect of the L0000 kernel (`languages/l0000/crates`); its `/form` view is `packages/view`,
built on `@graffiticode/l0000-view`.

> **One implementation lives here: Rust** (`crates/`, service `l0184r`, which serves
> `l0184.graffiticode.org`; on Rust since 2026-10-29, interpreted since 2026-10-30). The
> TypeScript compiler and server (`packages/core`, `packages/api`) were **removed on
> 2026-11-03** (interpreter plan A6). Their last behavior is the frozen conformance fixture
> (`crates/core/tests/conformance/PROVENANCE.md`). The TypeScript service `l0184` stays deployed,
> at min 0 and blocked in `deploy.json` (it can't be rebuilt), until its A7 decision.

The directory is also a small npm project (its own lockfile) for the view and the static assets.

## Commands

```bash
cargo test            # the compiler: conformance, interpretation, unit tests (no Node, no network)
npm ci
npm test              # tools/docs.test.mjs (the spec agrees with the language) and the view's tests
npm run lint
npm run typecheck     # the view
npm run rust:static   # ./static: spec assets (tools/build-static.mjs) + the /form bundle
npm run view:fixtures && npm run -w packages/view dev   # /dev.html: every spec program, rendered
```

Release from the **graffiticode repository root**: `npm run deploy -- l0184r` (deploy CLI; entry
in root `deploy.json`, image from `configs/Dockerfile.l0184r.yaml`, runtime `l0184r-run`).

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

## How the language is organized

The compiler is `crates/core` (see "The Rust implementation" below for each file). The
vocabulary is data: `crates/core/src/vocab.json` holds the chain, member and container fields,
the legality tables (`validAttributes`, `plotKindAttributes`, `validSettings`, `containerParts`,
`labelPositions`) and the example descriptions; `src/lexicon-additions.json` holds the words L0184
adds to L0000's lexicon. **Adding or changing a word is an edit to those files** (they were
generated from the TypeScript's `attributes.ts` until 2026-11-03 and are now the source), plus
the conformance cases that exercise it, reviewed as a change to the language. The containers and
PROG are hand-written in `src/lib.rs`; PROG's check reports a `{}` that ended a description early
(an L0184 word or a bare `{}` anywhere but last); L0000 expressions before the program are
allowed.

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

## Spec files (`spec/`)

`instructions.md` is the generator's system prompt (its tables are guarded by
`tools/docs.test.mjs` against the legality tables in `vocab.json`); `spec.md` renders to `spec.html` via spec-md, which reads bare
`{…}` in prose as a reference — keep braces inside code spans; `examples.md` holds RAG prompts,
never programs; `scope.json` names the sibling languages; the word tables in both files are
generated from the lexicon.

## Roadmap

Phase 1 (this) is bar/line/pie/scatter parity with L0173 plus datasets, axes and multiple charts.
Phases 2–4 (analytical plots; annotations and visual mapping; formatting and interactivity) need
their deferred contracts specified before implementation. Composition with L0185 (fetch and shape
data, L0170's successor on L0000) is planned: `data use "0185"` supplies a dataset's rows.

## The Rust implementation (`crates/`)

`crates/` is L0184, released to the service `l0184r`, which production runs: the api routes L0184 to `l0184.graffiticode.org` (mapped to `l0184r`; interpreter plan A1 on 2026-10-29, domains 2026-11-02) and interprets it (`INTERPRETER_L0184=on`, C1, 2026-10-30). A language change goes into the Rust and the conformance fixture together.

- `crates/core` (`graffiticode-l0184`) — `L0184` implements `Dialect` from `graffiticode-l0000`; `lexicon()` is the base lexicon merged with `src/lexicon-additions.json` (no base word is redefined). `src/lib.rs` dispatches every word by its row in the vocabulary (property, member, container) and holds the containers and PROG; `src/vocab.rs` is `attributes.ts` (`checkValue`, `hintFor`, `assertKnown*`) over `src/vocab.json`; `src/chart.rs`, `src/collection.rs`, `src/data.rs`, `src/colors.rs` and `src/stats.rs` are their TypeScript namesakes. `src/js.rs` is the plain JavaScript value a TypeScript handler sees after `toPlainObject` (`undefined`, key order, `String()`, `JSON.stringify`, `trim`, property reads that fail on `null` as JavaScript's do); `src/date.rs` is V8's `Date.parse`.
- `src/vocab.json` and `src/lexicon-additions.json` are **the source** of the vocabulary, the legality tables, the example descriptions and the Tailwind table (frozen from the TypeScript on 2026-11-03; edit them directly).
- `crates/server` (`l0184r-server`, binary `l0184r`) — `l0000r_server::serve(L0184, lexicon())`.
- `tools/assemble-static.mjs` — `tools/build-static.mjs`'s spec assets plus `packages/view`'s embed bundle, into `./static`.

**The Rust side depends on `languages/l0000` by relative path.** Read "The Rust implementation" in `languages/l0000/CLAUDE.md`.

```bash
cargo test            # conformance and unit tests; needs no Node and no network
npm run rust:build    # rust:static, then cargo build --release -p l0184r-server
npm run rust:dev      # cargo run -p l0184r-server on :50184 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
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

`crates/core/tests/conformance/cases.json` (2,864 cases, about 5MB) was written by a generator that ran the TypeScript compiler, removed on 2026-11-03 with it; the file is now the frozen record (`PROVENANCE.md`). It holds: every word with a good value in every description and with every wrong value of its type in its own; every plot word on every plot kind, every pair of kinds in one chart, every label position; every tag in every tag slot, and quoted spellings; every scale in each direction with categories, bounds, positions and rotations; every Tailwind token and hex form and near misses; histogram, box-plot, radar, heatmap and gauge number sweeps; 110 date strings on a TIME axis; datasets and upstream rows (`data {}` and `data use "0185"` against L0185's schema, with list, record and empty upstreams); the spec's programs; **every program the TypeScript suite compiles, with its data**, recorded while vitest runs (`record.config.mjs` and `record.setup.mjs` wrap `parser.parse` and `Compiler.compile`); and hand-written edge cases, including fields written as record literals. Every error message in the TypeScript source appears in it, except the few no program can reach. `tests/conformance.rs` requires the same JSON text or the same errors for all of them but the difference below; the server returns `{"data":…,"errors":[]}` for every non-error case.

### Deliberate differences

None in the fixture. (A number of 2^64 or more, `values [1e20]`, once came out as `1e+20`; the kernel now writes every number as `JSON.stringify` does, `100000000000000000000`.)

### Static assets and fixtures without the TypeScript (interpreter plan A6)

- **`spec/`** (the language's spec, instructions, usage guide, schema, scope, template and examples)
  lives at this directory's root. `tools/build-static.mjs` turns it into the
  public assets (`spec.html` via spec-md, `instructions.md` with L0000's, `language-info.json` with
  the usage guide's Overview as `authoring_guide`) without importing any compiler;
  `tools/assemble-static.mjs` adds the View bundle from `packages/view`. The Rust server serves
  `/lexicon.json` from its binary, so `static/` has no `lexicon.json`. The output is byte-identical
  to what the TypeScript build produced (checked 2026-11-02).
- **`crates/core/src/vocab.json`, `lexicon-additions.json` and `tests/conformance/cases.json` are
  frozen**: the last trusted TypeScript record, with their provenance in
  `crates/core/tests/conformance/PROVENANCE.md`. Never regenerate them from the Rust; the
  TypeScript that generated them was removed on 2026-11-03.

### The interpreter pass (plan C1)

`L0184::input_independent` is `!ast.reads_input()`: a chart description that doesn't read its input (no `data`, no `get-var` that may name it) compiles to a value model, evaluated once; one that reads it (`rows data use "0185"`) is a plan the kernel evaluates against the input. `tests/interpret.rs` requires `interpret(model(case), data)` to write exactly what `compile(case, data)` writes for every conformance case. The API interprets L0184 while `INTERPRETER_L0184=on` (on in production since 2026-10-30; evidence in `docs/evidence/interpreter-c1-l0184/`).

### Deploying the Rust server

`deploy.json` has an `l0184r` entry (own service, `l0184r-run@graffiticode.iam.gserviceaccount.com`, image from `configs/Dockerfile.l0184r.yaml`, snapshot this directory and `languages/l0000`, build step `cargo test --locked`, env `AUTH_URL` only). L0184 has no secrets and no protected functions. The only network call at compile time is the kernel's, for `data use "<lang>"`: the upstream language's `schema.json` from `GRAFFITICODE_API_URL` (default `https://api.graffiticode.org`), as the TypeScript does. Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later (see `languages/l0000/CLAUDE.md`). The account needs no roles.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored build outputs; `src/vocab.json`, `src/lexicon-additions.json` and `tests/conformance/cases.json` are generated, not edited.
