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
their deferred contracts specified before implementation. L0170 composition waits for L0170 to
move to l0000.
