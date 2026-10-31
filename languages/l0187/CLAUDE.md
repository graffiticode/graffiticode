# CLAUDE.md

Guidance for Claude Code when working in this directory.

## What L0187 is

L0187 is a Graffiticode dialect for **declarative FigJam boards**. It refines L0186 by making
geometry the compiler's job: a program declares content, membership, connections and meaningful
order, and the compiler measures, arranges, routes and validates the board, returning it
positioned. Coordinates, sizes, spacing and connector routes are compiled output, never source.
The language contract is `docs/l0187-language-design.md` (repo root); the implementation plan
is tracked in phases (skeleton → evaluation → measurement → layout → routing/validation → view
and docs → plugin → deploy → ecosystem).

L0187 is the **first language whose backend is Rust only**. There is no `packages/core` or
`packages/api` and no TypeScript oracle: `crates/core/src/vocab.rs` is the source of truth for
every word, and everything else is derived from it. npm here holds only the frontend view (to
come) and dev tools.

## Layout

- `crates/core` (`graffiticode-l0187`) — `L0187` implements `Dialect` from `graffiticode-l0000`
  (by Cargo path, as every Rust language does).
  - `src/vocab.rs` — the vocabulary as data: properties (with value types), members,
    containers, tag sets, legal locations, required properties, the removed geometry words,
    and the spelling rules (`font-size` → field `fontSize`, node tag `FONT_SIZE`).
  - `src/lexicon.rs` — the lexicon derived from the vocabulary, merged over L0000's (shadowing
    nothing).
  - `src/check.rs` — value checks (`check_value`): ids, tags, colours, counts, opacity, id
    lists. Every value is checked when evaluated, wherever it came from.
  - `src/eval.rs` — the handlers: a property checks its value and extends its chain; a member
    checks its description (keys ⊆ its properties, values valid, required present) and yields
    `{sticky: …}`; a container checks its items and settings (and the layout rules: `columns`
    only with GRID, which needs it; `direction` only with FLOW) and yields
    `{section: {settings, children}}`. Items that did not come from a handler (records, bindings,
    upstream data) are re-checked the same way, so forbidden fields can't slip in. Errors are
    positioned at the word, carry `code` and `category` (`src/diag.rs`), and are product
    surface: `tests/expected.json` pins every one.
  - `src/ir.rs` — the semantic board (pages → region tree of marks/sections/groups, page
    connectors), defaults filled. `src/resolve.rs` — board-wide ids, one tier of sections,
    same-page mark endpoints, `before` legality and strict-cycle detection, positioned through a
    source map of `id "…"` literals.
  - `src/lib.rs` — `Dialect`: dispatch, `PROG` (one board, at most one `save-to-figjam`, upstream
    data never merged), and `check` (early `{}`, hints on removed geometry words and missing
    terminators, which reach us as parser errors).
  - `src/profile.rs` — `FIGJAM_V1`: every geometry constant, with its provenance (calibrated
    against FigJam on 2026-10-30, L0186's measurements, or L0187 policy). **Provisional** until
    the phase 7 fidelity comparison; then frozen (a geometry change needs a new profile tag).
  - `src/measure.rs` — text: the embedded **Inter 3.19 Medium** (`fonts/`, OFL; FigJam's widths
    are its advances rounded up), shaped with rustybuzz, wrapped greedily at UAX #14
    opportunities and between grapheme clusters inside a long word; lines re-join to the exact
    text (`Break`). Coverage policy: `.notdef` emoji are modeled at 1.25 em; other `.notdef`
    characters and right-to-left text are content limits. `content_box` is each shape kind's
    calibrated text area.
  - `src/size.rs` — every mark's box and lines: stickies keep their width (square, or wide when a
    square would grow) and grow taller as FigJam's do; shapes are sized on the 24 grid to hold
    their text (FigJam truncates a resized shape's overflow); textboxes wrap at 20 em; labels are
    padded lines. Text that cannot be measured is a `content-limit` diagnostic.
  - `src/layout.rs` — regions composed bottom-up. ROW/COLUMN keep the written order on a line,
    GRID row by row in growing tracks (start-aligned); FLOW layers by `before` (strict) and
    connectors lifted to the children containing their ends (preferred; one that would close a
    cycle runs against the flow), orders layers by fixed barycentre sweeps, centres them, and
    reserves a routing channel beside the layers for back and layer-skipping edges; AUTO lays
    connected groups out as flows to the right and packs the rest in a near-square grid. Gaps:
    the gutter (48), 72 next to a region, widened for labels, plus the repair loop's `Spacing`.
    Section title bands sit above the border inside the section's block. Whole pixels.
  - `src/bin/emit.rs` — writes the vocabulary-derived files to `generated/`, or `--check`s them.
  - `examples/` — calibration helpers (`advances`, `wrap`, `shapes`, `probe_lines`); the method
    and results are in `docs/evidence/l0187-calibration/`.

Until lowering lands (phase 5), a compile returns the semantic board itself (`{type: "board", profile, …,
pages: [{id, name, region, connectors}]}`), each mark carrying `measured` (size, content box,
lines) and each labelled connector `measuredLabel`, each placed object its absolute `frame`
(sections also `titleFrame`), and each page its `size` and routing `channels`; the plugin board
replaces it. Resource limits (2000 objects, 4000 characters a text) are `resource` errors.

- `crates/server` (`l0187-server`, binary `l0187`) — `l0000r_server::serve_with(L0187, …)`.
- `generated/` — **committed** emit output (`lexicon.json` so far; `schema.json` later). The
  freshness target for `emit --check`, and what the static assembly copies.
- `crates/core/tests/programs/*.gc` — test programs, one per file; `invalid-*` must be rejected.
  `tools/parse-cases.mjs` parses them with `@graffiticode/parser` and `generated/lexicon.json`
  into `crates/core/tests/cases.json` (there is no Rust parser; the API parses upstream).
- `crates/core/tests/compile.rs` — every program against the reviewed snapshot
  `tests/expected.json` (output, or every error's message/code/category/position); upstream data
  never changes a board; compiling is repeatable. `UPDATE_EXPECT=1 cargo test --test compile`
  rewrites the snapshot — review the diff. `tests/interpret.rs` — the C1 interpreter pass
  interprets every program exactly as it compiles.
- `crates/core/tests/layout.rs` — the geometric contract on every valid program: siblings keep
  the gutter on one axis, children stay inside section padding and group bounds, ROW/COLUMN/GRID
  order, `before` disjoint along its flow with clearance, whole pixels, channels cross no mark;
  then the design's examples one by one.
- `crates/core/tests/vocabulary.rs` — the vocabulary must equal the design doc's tables (words,
  arities, property words, allowed-property sets, container children, closed sets, required
  properties, removed geometry words), the committed lexicon must be current, and every test
  program must parse to known words. It reads `docs/l0187-language-design.md`, so a deploy
  snapshot must include that file until the canonical `spec/spec.md` replaces it.

## Commands

```bash
npm ci                  # the parser, for `npm run cases`
cargo test              # needs no Node and no network
npm run rust:lint       # cargo clippy --all-targets -- -D warnings
npm run emit            # regenerate generated/ after changing vocab.rs
npm run cases           # re-parse the test programs after changing them or the vocabulary
npm run emit:check && npm run cases:check   # what CI and the image build run
npm run rust:dev        # the server on :50187 with AUTH_URL=http://127.0.0.1:4100
```

Adding or changing a word: edit `vocab.rs` (and the design/spec tables, which the tests compare),
then `npm run emit && npm run cases`.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and clippy clean; `static/` and
`target/` are gitignored; `generated/` and `tests/cases.json` are generated, not edited.
