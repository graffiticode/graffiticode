# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

L0179 is a Graffiticode dialect for interactive spreadsheets. It is a **source-surface port of
L0166**: same compiled output, field for field; the only difference is that attributes are
written as arity-1 words inside a `[...]` list instead of an arity-2 chain.

```
cell A1 text "10" width 100 {}      # L0166 — a chain
cell A1 [text "10" width 100]       # L0179 — an attribute list
```

That equivalence is the project's central constraint. Because output is identical, the renderer
(`@graffiticode/l0166`'s Form) and the deployed Learnosity scorer work unchanged, and equivalence
is *testable* rather than asserted — see the differential test below.

Output contract (built in `Transformer.PROG`):
`{title, instructions, templateVariablesRecords, validation, interaction: {type: "table", rows, columns, cells}, errors}`.

## Commands

```bash
npm run build          # core tsc → build-static → api tsc → view lib → view embed → assemble
npm run dev            # language server on :50179 with tsx watch (api workspace)
npm start              # run the built server
npm test               # vitest in packages/core, then packages/view (scoring)
npm run lint           # eslint (flat config, all workspaces); lint:fix / format also available
npm run diff-test      # L0166 ↔ L0179 equivalence over the shared corpus

node packages/core/tools/check-corpus.mjs <mapping.json>          # gate one generated batch
node packages/core/tools/check-published.mjs <training-examples.md>  # gate the corpus being embedded
```

Node >= 22 (`.nvmrc`: 22), npm workspaces.

Single test: `npm run -w packages/core test -- -t "the starter template compiles"`.
Vitest must run with `packages/core` as cwd — the tests read `spec/*` by relative path.

`npm run assemble` (part of `build`) wipes and repopulates `packages/api/static/` from
`packages/core/dist/static/` + `packages/view/dist-embed/` + `packages/integrations/learnosity/dist/`.
It is generated output, gitignored; never edit files there — edit `packages/core/spec/`, the view
sources, or the integration sources.

### Differential test

```bash
npm run diff-test                          # defaults: --l0166 ~/work/graffiticode/l0166
                                           #           --corpus ~/work/graffiticode/console/training/l0166-training-examples.md
npm run diff-test -- --limit 20
```

Requires the sibling `l0166` checkout and the `console` corpus, and requires `packages/core/dist/`
to be built (it imports `../dist/index.js`). For each corpus example it parses the L0166 source,
translates the AST to L0179 source, compiles both, and deep-compares. It reports only — it writes
no files, and nothing here generates `spec/examples.md`, which is a hand-maintained list of
prompts.

Assert on **compiled output**, never on source shape — a source-shape check passes on programs
that compile to the wrong thing.

### Corpus integrity gates

Two scripts in `packages/core/tools/`, both importing `../dist/index.js` (build core first), both
exiting non-zero rather than passing vacuously on an empty input:

- **`check-corpus.mjs <mapping.json>`** — gates one generated batch *before* it is embedded. Per
  entry: the pipeline claims success with a taskId and item; it parses **and compiles** against
  this repo's compiler (never trusting the pipeline's status flag); the output has
  `interaction.type === "table"`; and it is written in L0179's surface, with no L0166 chained
  syntax (`cell A1 text "x"`).
- **`check-published.mjs <training-examples.md>`** — gates the *downloaded* corpus. The per-batch
  gate has a hole: items are written to Firestore before the gate runs, so a rejected batch's
  items still get swept into the next download. Checking the exact text that becomes
  `training_examples` closes it.

The corpus is the one artifact where a defect compounds: a bad program is retrieved by every
later generation and teaches the mistake.

## Architecture

Three workspaces:

- **`packages/core`** (`@graffiticode/l0179`) — the compiler. Extends `@graffiticode/l0000`
  (`Compiler`, `Checker`, `Transformer`, `lexicon`).
- **`packages/api`** (private) — Express language server: `POST /compile`, `GET /form`,
  `GET /` health, and public static assets mounted *before* auth so they need no token
  (`index: false`, so `GET /` stays a health check rather than serving the embed's index.html).
  Auth attaches `req.auth` but does not reject anonymous requests. Every response carries
  `Cross-Origin-Resource-Policy: cross-origin` — without it the `/form` embed is blocked inside
  COEP-isolated hosts (claude.ai / chatgpt.com widget iframes). `npm run dev` presets
  `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` and `AUTH_URL=http://127.0.0.1:4100`.
- **`packages/view`** (`@graffiticode/l0179-view`) — the spreadsheet renderer and its scoring,
  both L0179's own. `Form` is injected into the shared `View` from `@graffiticode/l0000-view` as
  `<View Form={Form} reduce={reduce} />`. Two Vite builds: the library (`vite.config.ts`, React
  external) and the standalone `/form` embed (`vite.embed.config.ts` → `dist-embed/`).

  **There is no dependency on `@graffiticode/l0166` anywhere in this repo.** It was shed in the
  change that added multiple sheets, because tabs are UI L0166 does not have — see
  `docs/shed-l0166.md`. `packages/core` never depended on it; the differential test reaches the
  sibling *checkout* by path, which is a test fixture, not a dependency.

  `src/sheet/` is the spreadsheet ENGINE — evaluation, dependencies, cycle detection, formatting,
  addresses, and the colour/border policy. It was lifted out of `TableEditor.tsx`, where it sat
  among the ProseMirror plumbing importing none of it, for the same two reasons the scoring split
  happened: it is the half that survives any renderer, and it had no tests while it was tangled in
  the editor. Not to be confused with `src/scoring/`, which decides whether an answer is RIGHT;
  `src/sheet/` decides what a cell IS. See `docs/prosemirror.md` for why the renderer under it is
  on notice.

  The library builds **two entries**, and the second is load-bearing: `src/scoring/` is published
  on its own `./scoring` subpath so the Learnosity scorer can import it without the renderer.
  Tree-shaking the root entry does not work — it is one pre-bundled file whose ProseMirror
  initialisation is not provably pure, so React, the grid and dozens of `document` references
  survive into a bundle Learnosity runs **server-side**. The subpath is the guarantee; verified
  by loading `dist/scorer.js` in bare Node with no DOM.

- **`packages/integrations/learnosity`** (private) — the Learnosity custom question type.
  The lifecycle lives in `@graffiticode/learnosity-cqt`, shared with every Graffiticode language
  that ships one; this workspace is only the bindings. Two Vite builds, because Learnosity loads
  each bundle as a plain script that must call `LearnosityAmd.define` on load, and IIFE takes one
  entry: `vite.config.ts` (question) and `vite.scorer.config.ts`.

  Three things here are load-bearing:

  - **The output filenames are a published contract.** L0176's `buildCustom`
    (`packages/core/src/question-types.ts`) synthesizes
    `https://l0179.graffiticode.org/{question.js,scorer.js,question.css}` from the language id.
    Vite would name the stylesheet `style.css`; `assetFileNames` renames it. Moving any of these
    breaks every L0179 item in a Learnosity item bank.
  - **`define: { "process.env.NODE_ENV": "production" }` is not boilerplate.** Vite's lib mode
    preserves `process.env.NODE_ENV` so a library's consumer can substitute it. These are not
    libraries — nothing downstream substitutes anything. Without it React's development build
    ships *and runs*, and the bundles are ~40% larger.
  - **`question.ts` and `scorer.ts` are separate entries on purpose.** Learnosity runs the scorer
    server-side too, so it must not depend on the renderer.

  `question.ts` imports `Form` and the scoring functions from `@graffiticode/l0179-view`;
  `scorer.ts` imports from `@graffiticode/l0179-view/scoring`. That difference is deliberate and
  is the whole reason the subpath exists — importing scoring from the package root drags React and
  ProseMirror into a bundle that has to run in bare Node.

  `src/components/form/reduce.ts` is **not optional wiring** — it is the half of the state
  protocol that is not generic. The grid reports an edited cell as
  `{cells: {A1: {text, formattedValue}}}` and expects it merged into `data.interaction.cells`
  per cell, preserving each cell's `assess` rules and formatting. The shared View's generic
  `update` merges onto the top level instead, which writes a `cells` key nothing renders while
  `interaction.cells` goes stale — the edit never reaches the grid and the next compile redraws
  the sheet from source, erasing what the learner typed. Everything else in the protocol
  (`init`, `compiled`, `response`, `focus`) is handled by the shared View; `reduce` returns
  `undefined` for those so they fall through. With several sheets the edit arrives tagged with a
  `sheetId` and is merged into that sheet — merging it into `interaction.cells` regardless is the
  same mistake one level down, and would write sheet 2's edit onto sheet 1's grid.

### Sheets in the view

Three decisions carry the weight, all in `src/components/form/`:

- **Every visited sheet stays mounted; switching only changes which is visible** (`Form.tsx`).
  This is forced, not stylistic. `TableEditor` is uncontrolled, and the embed runs
  `formModel="loaded"`, so the shared View never hands the Form its own edits back. Unmount a
  sheet on a tab switch and its grid can only be rebuilt from the stale loaded model — the
  learner watches their typing vanish. Mounting is lazy so each sheet is first laid out while
  visible; a ProseMirror table measured inside `display: none` comes back with wrong widths.
- **Response keys are sheet-qualified (`s1!A1`), and the map stays FLAT**
  (`src/scoring/sheets.ts`). `@graffiticode/learnosity-cqt` is a published package shared with
  every other cell-scored dialect, and it is flat-keyed in three places — `mergeResponse`, the
  `response` reducer, and `Scorer.score()`. Qualifying the key rather than nesting the shape
  keeps all three working untouched. An unqualified key means the first sheet, so every response
  already stored against an existing item still reads correctly.
- **Scoring splits by sheet and scores each against its own validation** (`src/scoring/score.ts`),
  keyed off the presence of `validation.sheets` — which the compiler emits only for a real
  multi-sheet program, so there is no flag to keep in step. `score.test.ts` pins the sharp case:
  the same value is right on one sheet and wrong on the other.

`show-sheet-tabs` / `hide-sheet-menu` reach the view as `interaction.showSheetTabs` /
`interaction.hideSheetMenu`. Default: menu always, tabs once there are two or more sheets.

### The attribute table drives everything

`packages/core/src/attributes.ts` is the vocabulary as data. Adding an attribute is **a row in
that table** — the lexicon entry (`lexicon.ts`), the Checker method, and the Transformer method
are all generated from it in loops. Never hand-write an attribute handler.

Two hand-maintained pieces sit alongside it:

- `attributeFields[NAME].field` / `.coerce` are **transcribed from L0166, not inferred**, and are
  deliberately non-uniform: most style attributes emit kebab keys (`background-color`) and coerce
  through `tagValue(v) || ""`; `align` omits the `|| ""`; `method` lowercases; `hide-formulabar`
  emits `hideMenu`. A uniform pass-through table would silently change all of it.
- `validAttributes` — which words each container accepts. This is the payoff of the style: an
  attribute list merges whatever it is handed, so without this check a word written one level too
  high lands in a record nothing reads and compiles clean. The error message names the legal set
  *and* where the misplaced word actually belongs, because the consumer is an LLM code generator
  that reads compiler output and retries.

Only containers are written by hand: `SHEETS`/`SHEET`, `CELLS`/`CELL`, `COLUMNS`/`COLUMN`,
`ROWS`/`ROW`, `PARAMS`, `PROG`.

### Ported-verbatim files — do not "improve"

`packages/core/src/validation.ts` and `params.ts` are transcriptions of L0166's compiler,
including its quirks. `rowInRegion`'s `||`-that-should-be-`&&` is load-bearing for existing
programs and pinned by the differential test. Fixing it is a behaviour change for *both*
languages and belongs in its own change. Same for `PARAMS` discarding its continuation (which is
why the trailing `{"v": "0.0.1"}` never reaches the output).

`packages/view/src/components/form/` and `src/scoring/` are the same kind of thing at a larger
scale — the renderer and scoring lifted out of L0166's `TableEditor.tsx`. They are transcriptions,
so they are not reformatted to this repo's taste; `eslint.config.js` carries an override saying
which rules that costs and why. Two inherited defects are annotated in place rather than quietly
corrected, because fixing either changes behaviour: `[...cell?.deps]` throws when the property is
undefined instead of short-circuiting (four sites), and `getRegionValidations` returns only the
first region, so a program with several row regions scores just one of them.

What was **not** carried over: `TextEditor` (serves `interaction.type === "text"`, which L0179
never emits), `ThemeToggle` (dead in L0166 too), a second hidden `MenuView` that made the layout
depend on a CSS rule to not show two formula bars, and `assert` — the npm polyfill reads `process`
at module scope and throws `ReferenceError: process is not defined` in a browser.

Scoring equivalence was verified against L0166 over all 129 corpus programs (774 comparisons, 80
assessed cells) before the dependency was removed. That check could not survive the removal, so
`src/scoring/score.test.ts` replaces it — and each of its expectations was checked against L0166's
actual behaviour, not just against the transcription.

### Checker vs Transformer

Value validation belongs in the **Transformer**, not the Checker: the base `Checker.LIST` visits
only its first element, so a rule written in the Checker fires for the first attribute of a list
and silently skips the rest. The Checker here is deliberately a thin child-walker.

### Arity is the grammar

Two shapes, distinguished by arity in `lexicon.ts`:
- arity 1 — an attribute; evaluates to a single-key record the enclosing list merges.
- arity 2 — member list (`cells [...] {config}`), keyed entry (`cell A1 [attrs]`), or chaining
  (`params {...} {...}`, `title "..." <rest>`).

A word has **exactly one arity** — `parser/src/folder.js` reads `word.arity`, and there is no
overloading. That is why marking an attribute `chaining: true` in the table *removes* it from
attribute lists rather than adding a second way to write it, and why moving `title` was a
breaking source change. The arity is generated from the same table row as the handler, so a word
can never be arity 1 in the lexicon and arity 2 in the Transformer.

Cell/column addresses are regex-keyed `TAG` lexicon entries (`^[A-Z][0-9]+$`, `^[A-Z]$`), so `A1`
and `A` parse as barewords. Row *regions* stay quoted strings (`row "*"`, `row "1..5"`) because
they are ranges; `row 1` (bare number) is also accepted and stringified.

### Sheet scope

Several sheets are supported. Two rules keep that from breaking everything downstream:

- **`interaction.sheets` is emitted only when it carries something the flat fields cannot** —
  more than one sheet, or an authored `name`. A lone unnamed sheet compiles byte-identically to
  before multiple sheets existed, which is what keeps the differential test meaningful and every
  deployed Learnosity item untouched. `attributes.test.ts` pins both halves of that disjunction.
- **`resolveInheritedPoints` and `getValidation` run per sheet.** Both do global lookups —
  `columns[key[0]]`, `rows[region]`, and `regions[region].rows[rowIndex][col]` — so over a merged
  grid, sheet 2's `A1` would inherit sheet 1's column points and then overwrite its answer key.
  Both failures are silent and both produce a maximum no correct response can reach.

`title` / `instructions` / `show-sheet-tabs` / `hide-sheet-menu` are **program-level**, written in the
`sheets` configuration slot (`sheets [...] title "..." {}`), not inside a sheet. That slot is
where `params` already went, so it needed no new grammar. `params` must come **last** — it
discards its continuation, a transcribed L0166 quirk, so anything after it is dropped.

## Spec is tested, not decorative

`packages/core/spec/` holds the published language surface: `spec.md` (rendered to `spec.html` by
spec-md), `instructions.md` (concatenated onto L0000's at build time), `usage-guide.md`,
`examples.md` (the RAG prompt corpus), `template.gc`, `scope.json`, `schema.json`,
`language-info.json`.

`src/docs.test.ts` enforces that every fenced program in `spec.md` / `instructions.md`
**compiles** (not merely parses), that `template.gc` compiles, that retired L0166 words
(`hide-menu`, `index`, `order`) appear nowhere in code spans, and that every word documented in
spec.md's tables exists in the attribute table. These docs are LLM input — a wrong example is
reproduced verbatim into generated programs.

`examples.md` is exempt from the compile check because it holds **prompts, not programs** — one
numbered line per prompt, in the author's voice, describing *what* to build and never how. It is
inherited from L0166 unchanged for that reason. Its own guards (also in `docs.test.ts`) are
numbering coherence: prompts run `1..N` with no gap or duplicate, each `## Category N: … (lo–hi)`
heading's stated range matches what it actually contains, and the header's `<N> example prompts`
line matches the count. Adding or reordering a prompt means updating the enclosing heading range
*and* the header count.

`src/attributes.test.ts` is the behavioural counterpart: it pins the failures the design exists to
prevent — a bad argument in the **last** position of an attribute list (the Checker-vs-Transformer
trap), `points` rejecting a negative while preserving zero, a sheet with no cells being an error
rather than an empty grid, and a misplaced attribute's error naming where the word belongs.

`language-info.json`'s `authoring_guide` is **injected at build time** from `usage-guide.md`'s
`## Overview` section (`tools/build-static.js` fails the build if it's missing or under 100
chars). Edit the Overview, not the JSON.

## Deploy

Cloud Run, project `graffiticode`, service `l0179`, region `us-central1`, port 50179.
`npm run gcp:build` (Cloud Build) / `gcp:deploy` / `gcp:logs`. `AUTH_URL` is the only runtime env
var — spreadsheets read task data via `get-val-public` and params, never `get-val-private`, so no
`GRAFFITICODE_SECRET_KEY` is needed. If a private value is ever introduced, add the secret to
`cloudbuild.yaml` **and** propagate it with `console/scripts/set-compiler-secret.sh 0179`.

`/lexicon.js` is a back-compat alias serving `lexicon.json` for the still-deployed console; drop
it once the console migrates.

## docs/

Two decision records, not API docs:

- `shed-l0166.md` (**open**) — `packages/view` holds the last dependency edge on
  `@graffiticode/l0166`: the Form component, its stylesheet, and the re-exported
  `scoreCells` / `getCellsValidation`. Core is already independent (`validation.ts` / `params.ts`
  are transcribed, not imported). Shedding it means porting L0166's ~3.5k-line `TableEditor` and
  answering two questions first: is divergence wanted, and what guards equivalence afterwards
  (`differential-test.mjs` compares compiler output and would not notice two renderers drifting).
  Order of work: scoring first (DOM-free, needed by the Learnosity scorer anyway), then the
  renderer, with an equivalence test standing before the copy is made.
- `eval-2026-08-25.md` — the model eval behind L0179's routing case, recorded here because L0179
  is `hidden` in the console and a `MODEL_PRIORITY` line would be inert. This is the evidence for
  that line when L0179 takes over from L0166.

## Related repos (siblings under `~/work/graffiticode/`)

- `l0166` — the language L0179 ports; source of truth for **compiled output** behaviour, and the
  differential test reads it from there by path. It is no longer a dependency of any package
  here: the renderer and scoring were brought in-tree (`docs/shed-l0166.md`), and the view has
  diverged — tabs and a sheet menu are L0179's own.
- `console` — `docs/language-authoring-style.md` (the attribute-list style this language follows,
  referenced throughout the source) and `training/l0166-training-examples.md` (the corpus).
- `l0176` — a sibling in the same style; several files here are ported from it.
- `console` also consumes the grid's `focus` action (`src/components/FormIFrame.tsx`) to drive a
  properties panel keyed on `${type}-${name}`, so those payloads are a cross-repo contract.
