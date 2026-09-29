# L0179 should have no dependency on L0166

**Status: DONE.** The edge is gone; `@graffiticode/l0166` appears nowhere in this repo's
dependencies. What follows the outcome is the original analysis, kept because it framed the two
questions correctly and both of them got answered.

## Outcome

It was done as the first half of adding **multiple sheets with tabs and a sheet menu** — UI L0166
does not have. That is what settled the two open questions:

**"Is divergence actually wanted?"** Yes, and that is now the point rather than a risk. L0179 grows
chrome L0166 has no concept of. The two languages still compile to the same envelope for a single
sheet, and `packages/core` still proves it.

**"What guards equivalence afterwards?"** Nothing does, deliberately — renderer equivalence stopped
being a goal the moment divergence was chosen. What replaced it:

- **Compiled output** is still pinned by `tools/differential-test.mjs`, unchanged at 127/129.
  `packages/core` never depended on L0166; the test reaches the sibling checkout by path, which is
  a fixture, not a dependency.
- **Scoring** was verified against L0166 over all 129 corpus programs — 774 scored comparisons
  across 80 assessed cells, including `getCellsValidation` agreement — before the dependency was
  removed. That check could not survive the removal, so `packages/view/src/scoring/score.test.ts`
  replaces it, with each expectation independently checked against L0166's real behaviour.
- **The renderer** has no equivalence test and is not getting one. It was verified by running it.

The prescribed order held: scoring first, then the renderer.

### What came with it

Owning the code fixed things that could only be described from outside before:

- **The scorer runs in bare Node.** Scoring is a DOM-free module published on its own `./scoring`
  subpath. L0166's scorer could not be loaded outside a browser — it touches `document` at import
  time — which mattered because Learnosity runs the scorer server-side. `dist/scorer.js` now loads
  and scores with no DOM at all, and dropped from ~510 kB to ~318 kB.
- **One formula bar.** L0166 rendered two `MenuView`s and hid one with a stylesheet rule, so the
  layout depended on a CSS import to not look broken.
- **`assert` is gone.** The npm polyfill reads `process` at module scope and throws
  `ReferenceError: process is not defined` in a browser. It guarded one condition, now a plain throw.
- **Preflight is honest.** `tailwind.config.js` said `preflight: false` for good reason, but
  L0166's stylesheet shipped preflight anyway, so every consumer received it regardless. It is now
  `true` and visible, with scoping it to the form's own subtree left as its own change.

### What was left behind

`TextEditor` (serves an interaction type L0179 never emits), `ThemeToggle` (dead in L0166 too), and
the second hidden `MenuView`. Two inherited defects were annotated rather than fixed, since fixing
either changes behaviour: `[...cell?.deps]` throws when the property is undefined instead of
short-circuiting, and `getRegionValidations` scores only the first row region.

---

## Where it stood (original analysis)

L0179 was built as a source-surface rewrite: the same compiled envelope as L0166, a different
way of writing it. `packages/core/src/compiler.ts` says so directly — "it is why the renderer
(@graffiticode/l0166) and the deployed scorer work unchanged". Reusing the renderer was the
point, and it is why the port could be proved correct by `tools/differential-test.mjs` instead
of by re-testing a UI.

The compiler already carries no dependency: `packages/core/src/validation.ts` and `params.ts`
are transcribed verbatim from L0166's compiler, source copied under comment, not imported.

The view layer was never given that treatment. There is exactly one dependency edge left:

```
packages/view/package.json → "@graffiticode/l0166": "^0.1.6"
```

feeding three uses:

| where | what |
| :-- | :-- |
| `src/components/form/Form.tsx` | `export const Form = SpreadsheetForm` — the entire renderer |
| `src/index.css` | `@import "@graffiticode/l0166/style.css"` — its stylesheet |
| `src/index.ts` | re-exports `scoreCells` / `getCellsValidation` |

No other package depends on L0166. The Learnosity integration deliberately imports everything
through `@graffiticode/l0179-view`, so when this edge goes, nothing downstream changes.

## What shedding it means

Porting the renderer, the same way the compiler was ported. In L0166 that is
`packages/app/lib/components/form/`: `TableEditor.tsx` (3,533 lines) plus `Editor`, `FormulaBar`,
`TextEditor`, `MenuView`, `ProtectedCellTooltip`, `ThemeToggle`, `translatex-rules.js` and
`Form.css` — ProseMirror tables, formula evaluation via `@graffiticode/translatex`, cell
formatting, and the scoring functions.

This is a real project, not a cleanup. Two things are worth settling before starting it.

**Is divergence actually wanted?** Today the two languages cannot drift: they render through
one component. A copy makes divergence possible, which is the point if L0179 is meant to grow
its own UI, and a liability if it is not. `Form.tsx` already flags this — "If the two data
models ever diverge, this file is where that shows up first".

**What guards equivalence afterwards?** `differential-test.mjs` compares compiler output and
would not notice two renderers drifting apart. A port needs its own equivalence check, or the
guarantee that today's shared component provides is simply lost.

## Order of work

1. **Scoring first.** It is the smallest piece, it is DOM-free, and the Learnosity scorer
   bundles need it independently — see `l0166/docs/scoring-subpath.md`. Extracting it upstream
   makes it cheap to transcribe here, exactly as `validation.ts` was.
2. **Then the renderer**, with an equivalence test standing before the copy is made.

Until step 1 lands, `packages/view` keeps the edge and every other package stays clean.
