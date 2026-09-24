# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this is

L0183 is a Graffiticode dialect for **concept webs**: a hub in the centre, nodes on a circle
around it, and lines between them. A node or line with `assess` is a **blank** the learner fills
by dragging from a tray. It succeeds L0169 and is **not** source-compatible with it — see
"Relationship to L0169".

It is also the base of a **Learnosity custom question type**, embedded from L0176 with
`custom [lang "0183" …]`, exactly as L0179 is. That fixes the compiled output's shape; see
"The output contract".

## Commands

```bash
npm run build      # core → build-static → api → view → view:embed → learnosity → assemble
npm run dev        # API on :50183 (expects Firestore emulator :8080, local auth :4100)
npm test           # core + api + view suites
npm run lint       # ESLint over the monorepo
npm run -w packages/view dev   # the renderer on Vite alone; /dev.html is the fixture page
```

Node 22, npm workspaces. `npm run assemble` wipes and repopulates `packages/api/static/` from
`core/dist/static`, `view/dist-embed` and `integrations/learnosity/dist`.

Tests are Vitest, per workspace. **The core suite must run with `packages/core` as the cwd**
(`npm run -w packages/core test -- src/errors.test.ts`): `docs.test.ts` reads `spec/*` relatively.
Core tests compile through `src/harness.ts` (`compile(src, data)`, `errorOf(src)`), which runs
the real parser against the real lexicon. **`packages/api`'s suite reads the assembled
`static/`**, so build first.

Deploying: the three `cloudbuild*.yaml` files carry `--update-env-vars` (never `--set-env-vars`)
and an explicit `--max-instances`. Keep both in any new deploy path. The `/form` cache headers
and the Cloudflare zone rule are documented in L0182's CLAUDE.md, and apply here unchanged.

## The dialect

The style is `console/docs/language-authoring-style.md`. Read it before adding vocabulary. Two
kinds of list, like an HTML element's attributes and its children:

- An **attribute list** is heterogeneous: arity-1 words merged into one object —
  `[id "r" assess [expected "Receptor"]]`.
- A **member list** is homogeneous: children of one kind, in order. The container is arity 2
  and takes the list AND its configuration record — `nodes [ … ] {}`. `{}` is the empty
  configuration, not a terminator.

`concept-web` is arity 2 too: the diagram's attribute list (`hub`, `nodes`, `edges`), then the
program's configuration record. Configuration records are built by **chaining**, and that is the
only place chaining happens:

```
concept-web [ … ] title "…" instructions "…" theme DARK {}..
nodes [ … ] distractors ["…"] tray "left" {}
```

### Two tables drive everything

`src/attributes.ts` holds `attributeFields` (arity 1) and `configFields` (arity 2, the chaining
words). The lexicon entries and the Checker and Transformer methods are **generated** from them,
arity included. Never hand-write an attribute handler. Only the containers (`CONCEPT_WEB`,
`NODES`, `EDGES`) and `PROG` are written out, in `compiler.ts`.

`validAttributes` (what each attribute list accepts) and `validSettings` (what each
configuration record accepts) are maintained by hand, and they are the highest-value check in the
language: an attribute list merges whatever it is handed, so a misplaced word would otherwise
compile clean and do nothing. The error names the legal set **and where the word belongs** —
including "is a setting and goes after the `]` of …", the mistake a generator makes most with
chaining. `docs.test.ts` holds `instructions.md`'s two container tables equal to them.

A chaining word written as the LAST word inside brackets swallows the closing bracket and dies in
the parser ("Too few arguments for TITLE"), which no compiler error can improve. L0182 removed
chaining over exactly this. It is kept here, confined to configuration slots, by decision; the
instructions say "settings go after the closing bracket" prominently for that reason.

### Where validation goes

**Value checking lives in the Transformer, never the Checker.** `Checker.LIST` visits only
`elts[0]`, so a Checker rule fires on a list's first element and nowhere else. The Checker only
walks, and every arity-2 Checker method visits **both** children — `elts[1]` is the rest of the
chain, and walking only `elts[0]` silently drops every error below it.

Web-level rules live in `src/web.ts` (`buildWeb`): a hub and nodes are required; a node has
`text` or `assess`, never both; a blank edge has no `label`; ids are unique and `hub` is
reserved; `from`/`to` resolve by id then exact text, and a reference naming nothing or two nodes
is an error that lists the nodes; a distractor may not equal an answer. Every message names the
fix, and `errors.test.ts` asserts the wording — the generator reads these and retries.

A record inside the Transformer is still L0000's internal `Record`; run it through
`toPlainObject` before reading it. Strings: the parser eats a single backslash before `t`, `n`
and friends (`\theta` arrives as a tab and "heta"), so the docs require doubled backslashes.

## The output contract

```
{ title?, instructions?, theme?,
  interaction: { type: "concept-web", hub, nodes, edges, trays: {nodes?, edges?},
                 cells: { <blank id>: {value?} } },
  validation: { points, cells: { <blank id>: {assess: {expected, points}, pool} } } }
```

This is `@graffiticode/learnosity-cqt`'s **cell-scoring** contract, and it is not negotiable
without changing that shared package:

- `interaction.cells` has one entry per blank. The learner's answer is its `value`. cqt's
  `mergeResponse` folds a stored response in here.
- `validation.cells[id].assess.expected` is what cqt's "show answers" reads.
- The key lives only in `validation`, so a graded delivery can withhold it.

**Pools** are computed at compile time (`assignPools`): blanks with the same kind and the same
incident edges (direction, style, label, other endpoint) share a pool, and the scorer matches
answers across a pool as a whole. This is L0169's runtime `edgeSignature`, moved into the
compiler so the scorer stays trivial and runs server-side.

**`PROG` takes exactly one thing from `options.data`**: each blank's `value`
(`data.interaction.cells[id].value`). Everything else comes from the fresh compile, so a stale
model riding back in `data` cannot shadow it. Do not reintroduce a blanket `...data` spread.
Through `api.graffiticode.org`, `data` is not the model but L0000's compile response wrapping it
(`{data, errors}`, sometimes nested); `buildWeb` unwraps it. Calling this server directly, as the
tests do, hides that — a missing unwrap made every drop snap back to the tray in production.

## The view

`packages/view` exports `Form` (for the shared View and for cqt), `reduce`, and scoring.

- **Controlled.** `Web.tsx` holds no placement state: `placed` comes in, `onPlace` goes out. A
  placement is `state.apply({type: "response", args: {cells: {n3: {value}}}})` — cqt's shape, so
  one Form serves both hosts. In the embed, `reduce.ts` folds it into `interaction.cells` (the
  shared View would otherwise merge `cells` onto the top level), and the recompile carries it
  back. Under cqt it lands in `responseValue`, which `Form` overlays on `interaction.cells`.
- **Host detection**: `questionState`/`responseValue` in the model means cqt. There, Learnosity
  owns checking (`showValidationUI`), `disabled` and `reset`; in the embed a Check button does.
- **Three ways to move an answer**, each because another fails somebody: pointer-event dragging
  (HTML5 drag-and-drop never fires on touch — L0169's tray did nothing on a tablet),
  select-then-place (the keyboard path, and what a tap does), and activating or Deleting a
  filled blank to return its answer.
- **Geometry** is one 0..1000 square space: nodes are positioned in percentages of a square box
  and lines drawn in an SVG with the same viewBox, so nothing is measured and nothing recomputes
  on resize. Text scales in `cqw` units. The arrow marker id is per instance (`useId`).
- **Trays are shuffled at render** (`lib/tray.ts`, seeded by content), never at compile time —
  every placement recompiles, and a compile-time shuffle would reorder the tray under the hand.
- **Tailwind**: preflight off, `darkMode: "class"` (the program and the toggle decide, not the
  OS), and the restored preflight rules in `index.css` are scoped under `:where(.l0183-web)` —
  `:where()` keeps them below the utilities they reset.
- Logic that can be wrong without looking wrong is pure and tested without a DOM: `scoring/`,
  `lib/layout.ts`, `lib/tray.ts`, `components/web/reduce.ts`.

**`src/scoring/` is published on its own `./scoring` subpath and must stay free of React and the
DOM.** Learnosity runs `scorer.js` server-side; the scorer imports the subpath, never the root.

## The Learnosity integration

`packages/integrations/learnosity` is only bindings over `@graffiticode/learnosity-cqt`, copied
from L0179. The output filenames `question.js`, `scorer.js` and `question.css` are a **published
contract**: L0176's `buildCustom` synthesizes `https://l0183.graffiticode.org/{…}` from the
language id. `define: {"process.env.NODE_ENV": "production"}` is load-bearing (without it React's
dev build ships and runs). `question.ts` passes a `suggestedAnswerLabel` that shows the answer
alone, because cqt's default `key: expected` would show blank ids like `n3`.

Check the scorer in bare Node by stubbing `LearnosityAmd.define`, evaluating
`packages/api/static/scorer.js`, and calling `new Scorer({data}, response).score()`.

## Spec is tested

`docs.test.ts` gates `spec/`: every fenced program in `spec.md`, `instructions.md` and
`usage-guide.md` compiles and validates against `schema.json`; every L0183 word is documented
with the lexicon's signature; the container tables equal `validAttributes`/`validSettings`;
`examples.md` numbering tiles and prompts ask for content, not code; no placeholder image hosts;
every `scope.json` `out_of_scope` sentence carries a keyword the MCP router keeps
(`ONLY when | do NOT | does NOT | not built yet | never`).

`usage-guide.md`'s `## Overview` is injected into `language-info.json` as `authoring_guide`;
the build fails without it. `build-static.js` also serves `examples.md`, which the console's
corpus scripts read.

## Relationship to L0169

L0183 supersedes L0169. It does **not** read L0169 programs or stored data; existing L0169 items
stay with L0169, which is deprecated in the console catalog.

Defects in L0169 deliberately not reproduced — don't reintroduce them by copying from it:

- Arity-2 chains everywhere, so `align` written for one tray leaked into the other.
- `value` vs `text`: a value-only node rendered blank; a graded node carrying its own answer
  rendered correct before the learner did anything.
- A separately authored tray that had to repeat the answer key exactly.
- Edge references that named nothing were dropped silently; `*` wildcards and list-valued
  `from`/`to` expanded into many droppable edges.
- Edge grades coloured only when an incident node was graded.
- Learner answers never left the component: no response, no score, nothing saved.
- HTML5 drag-and-drop (dead on touch), no keyboard path, one global arrow marker id, a hand-kept
  hex palette that drifted from Tailwind, and a Checker that checked three things.
- `method "value"` (the only method), per-element `w`/`h`/`rounded`/`bg`/`border` (replaced by
  closed sets `shape`/`color`/`size`), and a stale `schema.json` and training corpus.

## Related repos

- `l0000` — base language and the shared View (npm dependencies).
- `integrations/packages/learnosity-cqt` — the shared custom-question runtime.
- `l0176` — embeds L0183 as `custom [lang "0183" …]`; `buildCustom` is generic over the id.
- `l0179` — the model for the Learnosity integration and the `./scoring` subpath.
- `console/src/lib/languages.ts` — the catalog. L0183 must be registered there to reach users,
  and L0169's entry marked deprecated in its favour.
- `graffiticode-mcp-server` — `NATIVE_LANGUAGES` and `item-content.ts` need an L0183 entry.
