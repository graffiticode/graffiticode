# The grid is built on ProseMirror, and probably should not be

**Status:** open, but no longer for performance reasons · **Scope:**
`packages/view/src/components/form/` only

This records a review of `TableEditor.tsx` made after L0179 took ownership of the renderer
(`shed-l0166.md`). The question was whether ProseMirror is the right foundation, up to and
including replacing it. The conclusion is that it is not, but that replacing it was not the right
first move — so the waste was removed and the engine separated first, and the case is written down
here rather than re-derived later.

## What slow sheets turned out to be — and it was not this

A later report that 100-500 cell sheets were slow to paint was investigated against this document,
on the assumption that the renderer was the cause. It was not, and the correction matters because
it removes performance from the case below.

One formula evaluation costs **3-17 ms**, all of it inside TransLaTeX's `translate()`, and it grows
with the number of cells handed to the parser as `env`. A literal cell costs ~0 ms and every other
engine operation — dependency extraction, formatting, colour, borders — is under 0.05 ms. So the
cost of the whole system is **how many times a formula is parsed**, and that lives in
`packages/view/src/sheet/`, which is DOM-free and would be inherited verbatim by any new renderer.
(`TransLaTeX.buildTranslator` is free — it returns a closure — so caching the translator, which the
shape of the code invites, measures as worth nothing.)

ProseMirror's role was amplification, not cost, and the amplification was this repo's own code:
`state.init` marked every non-empty cell dirty, each got its own dispatch, and each dispatch
re-entered a plugin `apply` that rebuilt the decorations for the whole sheet and rescored it. So
the number of full-sheet rebuilds at mount was the number of populated cells. ProseMirror provides
`tr.docChanged` and `DecorationSet.map` precisely to avoid that; neither was used.

What that came to, measured (`npm run bench`):

| | before | after |
| :-- | --: | --: |
| literal 500 cells — the floor, no formulas | 4.5 ms | 4.4 ms |
| mixed 500 cells, one pass | 852 ms | 459 ms |
| chain 300 cells | 939 ms | 653 ms |
| **chain 200 cells, as a mount actually does it** | **2,838 ms** | **414 ms** |
| `getChangedCells` over 500 names (runs on every mount) | 22.13 ms | 0.11 ms |
| `getResponses` over 500 cells | 0.38 ms | 0.05 ms |
| 100 assessed cells sharing one formula `expected` | 100 parses | 1 parse |

Delivered by: a real dependency graph with a reverse index (`sheet/graph.ts`), one
topologically-ordered evaluation pass (`sheet/recalc.ts`), a content-addressed memo
(`sheet/cache.ts`), narrowing the parser env to the cells a formula actually reads, removing eight
O(N^2) spread-accumulator reduces, and two guards in the ProseMirror layer. The gate is
`src/perf.test.ts`, which counts `translate()` invocations — call counts do not flake in CI the way
wall clock does.

**None of the above argues for or against replacing the renderer.** The case below stands on what
it always stood on: bundle size, and the share of `TableEditor.tsx` that exists only to make a text
editor behave like a grid.

## The measurements

- **ProseMirror is 364 kB of the 672 kB renderer bundle — 54%**, attributed exactly by decoding
  `dist/index.js.map` rather than grepping minified output. It is ~3.5 MB across 15 installed
  packages.
- **The grids are tiny.** Across all 129 corpus programs the median is **4 cells**, p90 is 14, and
  the largest is 39 cells in 6 columns. Nothing here needs a document model, virtualization or
  incremental layout — and equally, nothing needs a spreadsheet library built for 100k-row books.
- **The document model is unused.** No custom nodes. Marks were removed in this pass because
  nothing could reach them: the language expresses emphasis as cell attributes, and the only
  commands that would have applied marks were buttons commented out since L0166. The schema still
  admits headings, blockquotes and images as siblings of the grid.
- Before this pass, roughly **47% of the file existed to make a text editor behave like a grid**:
  ~250 lines converting ProseMirror positions back into `(row, col)`, `filterTransaction` firewalls
  standing in for "this cell is read-only", and eleven no-op transactions dispatched only to force
  a redraw.

## What ProseMirror actually earns

Worth stating plainly, so a replacement does not lose these by accident:

- contentEditable text entry inside a cell, with IME support;
- undo/redo, via `history()`;
- `<table>` rendering — **including the `<colgroup>` that carries every authored column width**.
  This one is easy to underestimate. Removing `columnResizing()` during this pass on the grounds
  that its dragging leads nowhere silently dropped every authored width: a 150px column rendered
  at 462px. The plugin is the width renderer, not only a drag affordance;
- decoration diffing, so redraws are incremental.

## The recommendation: a purpose-built grid, not a library

Not Univer, Handsontable, jspreadsheet or react-spreadsheet. The blocking reason is not size or
licensing, though Handsontable is not free for commercial use and Univer is megabytes:

**Each of them brings its own formula engine, and scoring decides answer equivalence through
`@graffiticode/translatex`** (`packages/view/src/scoring/score.ts`). Two engines means the grid can
show one value while the scorer judges another — the exact drift this codebase keeps refusing.
TransLaTeX is ~154 kB of the bundle and is paid under any foundation.

Nor would a library provide the assessment semantics: live `#efe`/`#fee` assess painting suppressed
on the focused cell, `protected` cells with their allow/block key list and the `systemFormatting`
escape hatch that lets recalculation still write, or a response set filtered to cells carrying
`assess`.

## What a replacement must satisfy

The contract, which is larger than it looks:

1. The `interaction` shape exactly — `{type, rows, columns, cells, sheets?, hideMenu, showSheetTabs,
   hideSheetMenu}` — including that **`hideMenu` means the formula bar**, not the sheet menu.
2. The cell > column > row presentation cascade, and the border split: CSS-string borders override,
   side lists (`"top,left"`, `"all"`) union.
3. All three actions at the same moments: `update` (`{cells:{name:{text,formattedValue}}}` plus
   `sheetId`), `response` (assessed cells only, `{text,val,formula}`, keys qualified `s1!A1` when
   there is more than one sheet), and `focus` in all nine payload variants. `focus` is a cross-repo
   contract — `console/src/components/FormIFrame.tsx` forwards it to a properties panel that keys on
   `` `${type}-${name}` ``.
4. The one-time initial `update` covering every cell; the model depends on it for first paint.
5. Recalculation on blur propagating to `deps`, with `#NAME!` and `#CYCLE!`.
6. Raw `text` in the focused cell, `formattedValue` everywhere else.
7. Header skipping on Tab/Enter/arrows, and no content edits in headers.
8. `protected` enforcement with its specific allow/block list and the tooltip.
9. Live assess painting, never on the focused cell or a header.
10. Surviving a sheet switch with uncommitted edits.
11. `packages/view/src/scoring/**` staying DOM-free and loadable in bare Node.

Most of the hard half — evaluation, dependencies, cycles, formatting, addresses, the presentation
policy — is already out of the renderer in `packages/view/src/sheet/`, and tested. A replacement is
a re-skin of the remaining renderer, not a rewrite of the spreadsheet.

## Still open

- **The re-seed.** Any change to `cells` or `columns` rebuilds the document, discards undo history
  and forces the caret to A1; and because `plugins` is rebuilt on every render,
  `buildCellPlugin.state.init` re-runs and re-evaluates every formula. This is the root of the
  constraint that forced `formModel="loaded"` and the mount-every-sheet design in `Form.tsx`. Not
  attempted here: it interacts with both, and wants its own change with its own verification.
- **`react-markdown` is 170 kB — 25% of the renderer bundle** — and it renders `title` and
  `instructions`. Orthogonal to the grid and a bigger saving than most of the grid work.
- **`scorer.js` still carries React**, roughly half its 254 kB, because `scorer.ts` imports
  `createScorer` from the `@graffiticode/learnosity-cqt` root barrel, which re-exports
  `createQuestion`, which imports `react-dom/client` — and that package declares no `sideEffects`.
  The fix is a scorer subpath from that shared package.
- **The shared View's serialization is fixed but not yet consumed.**
  `@graffiticode/l0000-view` serialized the whole model twice per dispatched action, and once per
  render, to decide whether anything had changed. That is fixed in the `l0000` checkout and
  released as **0.1.4**; this repo's `^0.1.3` range already accepts it, so it needs only a publish.
  Until then a share of the per-interaction cost is still paid here and is not attributable to
  anything in this repo.
- Two inherited defects remain annotated rather than fixed: `[...cell?.deps]` throws when `deps` is
  undefined, and `getRegionValidations` scores only the first row region. Both were deliberately
  preserved through the performance work, which touched all the code around them.
- The grid is capped at **26 columns**: `makeEditorState` derives width with `cellName.slice(0, 1)`
  against a 27-character alphabet. The compiler agrees — its address entry is `^[A-Z][0-9]+$` — so
  the limit is consistent, but `schema.json` advertises `^[A-Z]+[0-9]+$`.
