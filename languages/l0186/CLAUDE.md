# CLAUDE.md

Guidance for Claude Code when working in this directory.

## What L0186 is

L0186 is a Graffiticode dialect for **FigJam boards**: sticky notes, text, shapes with text (30
FigJam shape kinds), sections, reaction stamps and connectors, on one or more pages. It replaces
L0172 (a legacy `@graffiticode/basis` language) and does NOT accept L0172 programs. It is built on
`@graffiticode/l0000` ^0.10.1 and `@graffiticode/l0000-view` ^0.4.0.

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
(cd packages/core && npx tsx tools/fixtures.ts)   # refresh those fixtures (incl. the fidelity board)
```

Release from the **graffiticode repository root**: `npm run deploy -- l0186` (deploy CLI; entry
in root `deploy.json`, image from `configs/Dockerfile.l0186.yaml`, runtime `l0186-run`, which
must be provisioned first).

## The language

Style: `docs/language-style-typed-chains.md` (repo root). Four construct shapes:

- CONTAINER (arity 2): a member list, then a settings chain — `board`, `page`, `section`.
- MEMBER (arity 1): one description chain — `sticky`, `shape`, `textbox`, `stamp`, `connector`.
- PROPERTY (arity 2): a value, then the rest of the chain — everything else.
- TAG (arity 0): an UPPERCASE closed-set value spelled as FigJam's enums — `kind DIAMOND`,
  `to-cap ARROW_LINES`, `font-size LARGE`.

Plus one **statement**, `save-to-figjam "<link or file key>"` (arity 1), written on its own line
beside the board. It evaluates to a marker record that `PROG` merges into the board as `fileKey`;
anywhere else (a list, a chain, a settings record) it is an error that says where it goes.

Every program is one `board [ page [ … ] settings {} … ] settings {}..` — a board is a FigJam
file, and holds one or more pages, even for a one-page board (as L0184's `charts [ chart … ]`).
The shape kind `OR` is a tag, so L0000's logical `or` keeps working (L0172's `or` shadowed it);
no L0000 word is overridden.

## How the core is organized

- `attributes.ts` — the vocabulary as data: `chainFields`, `memberFields`, `containerFields`,
  `SAVE_TO_FIGJAM`, the legality tables (`validAttributes`, `validSettings`,
  `containerMembers`), `checkValue`, and the error helpers (`hintFor`, `assert*`). Adding a word
  is a row here; handlers are generated from it.
- `compiler.ts` — generated handlers; the containers, `SAVE_TO_FIGJAM` and PROG are written out.
  PROG's Checker reports a `{}` that ended a description early (a second top-level description).
- `board.ts` — members → the nodes the plugin draws (`toNode`), page names and tab defaults, id
  uniqueness and connector resolution per page (mirroring the plugin's `primaryKey`: id, else
  text; a section by its name, which must not be any other node's key; a stamp by its reaction),
  `parseFileKey`.

Value checks live in the Transformer (`Checker.LIST` visits only `elts[0]`). Errors are a product
surface: `errors.test.ts` pins their exact wording.

## Output — the plugin's contract

`{type: "board", title?, showPageTabs, showPageMenu, pages: [{name, background?, nodes}],
fileKey?}`. Nodes carry exactly the fields `figma-plugin/src/code.ts` reads, and only the ones the
program wrote: `type` (`sticky`/`shape`/`text`/`stamp`/`section`/`connector`), `shapeType` in
Figma's enum spelling, `stamp` lowercase, line enums lower-kebab (`elbowed`, `arrow-lines`),
size presets as pixels, opacity on 0–100. A compiled page's nodes match L0172's `nodes` output
node for node (tested). `spec/schema.json` describes the output exactly.

Compiling never writes to FigJam: Figma's REST API cannot create nodes. `save-to-figjam` only
records `fileKey`; the plugin, opened in that file, draws the board. It is not a protected
function — no policy, broker or registry entry.

## The view

`packages/view` exports `Form` and `./style.css` (the MCP widget contract). The view is an **SVG
preview only** — no FigJam iframe. `lib/layout.ts` (pure, tested) reproduces the plugin's
placement: nodes at x/y and FigJam default sizes, sections fitted to children + 24px with the
children centred, connector ends resolved and fanned out as `resolveEndpoints` does, AUTO/CENTER
magnets, elbowed/straight/curved routes. `lib/shapes.ts` draws all 30 shape kinds;
`lib/text.ts` wraps text (shrinking a sticky's to fit); `lib/figjam.ts` holds every FigJam
default in one place. Pages show as tabs (`PageChrome`, ported from L0184's chart chrome) when
there are two or more; one page shows neither tabs nor menu.

**Fidelity.** Values the plugin sets are copied exactly. FigJam's own defaults in `figjam.ts`
were measured on 2026-10-08: each node was created through the Plugin API (via the Figma MCP's
`use_figma`) exactly as the plugin creates it and read back, and the fidelity board
(`tools/fixtures.ts`, "fidelity: shapes") was drawn with the plugin's own drawing code and
screenshotted next to `/dev.html`. Shape outlines (`shapes.ts`), cap placement, elbow rounding and
the AUTO side rule (`layout.ts` `autoSides`) come from those screenshots. The same day a scratch
board measured waypoints and curves: a connector with `waypoints` is one FigJam connector per leg
(`legs`); FigJam refuses a CENTER magnet on elbowed and curved connectors (the compiler rejects
it, the plugin defaults both to AUTO); curved AUTO sides (`autoSidesCurved`) and how a curve
meets a free point are commented where they are encoded in `route`. To recalibrate after a
FigJam change, repeat that: create a scratch board, draw the fixture, compare, adjust in one place.

## The corpus gate

`npm run check-corpus -- <file>` compiles every program in a generated corpus batch and lints its
boards with `packages/view/src/lib/lint.ts`, on the routes the preview draws. The console's
`generate-embeddings-from-examples` runs it automatically on the rows it is about to write (found
through this script's name, `console/scripts/lang-gate.ts`) and stores nothing when it fails;
`--skip-gate` overrides. It compiles with the built code, so `npm run build` first — a gate that
cannot run blocks the embedding. Run it by hand on `create-items-from-prompts --output <file>` to
check a batch early, or on the embeddings log (`console/training/l0186-embeddings.json`).
Exit 1 = do not embed: a line through a node it does
not join, a line that runs through its own end node or doubles back on itself at a waypoint, a
waypoint inside a node, a waypoint level with a node but off its centre, or one where the line
turns anyway. Each finding names the fix; the summary prints the `--only` list to regenerate. The
rules mirror the instructions' "Keep every line clear of other nodes" and waypoint bullets —
change both together. Regenerate with `create-items-from-prompts --refresh --only <list>`:
`--refresh` deletes the replaced items' vectors too, so retrieval cannot hand the generator the
program being replaced; embedding an item that was edited since replaces its older row.

## Related repos

- `../figma-plugin` — draws the board into FigJam. It reads `pages` (falling back to L0172's
  `nodes`), refuses a board whose `fileKey` names another file, and registers section keys.
- `../console` — `src/lib/languages.ts` registers L0186 (L0172 is marked Deprecated).
- `../graffiticode-mcp-server` — `NATIVE_LANGUAGES` renders `@graffiticode/l0186-view` natively.
- After any surface change, rebuild the RAG corpus from `spec/examples.md`: deploy, then
  `create-items-from-prompts --lang 0186 --mark 1 --refresh` (it reads the served `examples.md`
  and clears replaced items' vectors), then `generate-embeddings-from-examples --lang 0186`,
  which runs the corpus gate before it writes.
