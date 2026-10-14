# CLAUDE.md

Guidance for Claude Code when working in this directory.

## What L0186 is

L0186 is a Graffiticode dialect for **FigJam boards**: sticky notes, text, shapes with text (30
FigJam shape kinds), sections, reaction stamps and connectors, on one or more pages. It replaces
L0172 (a legacy `@graffiticode/basis` language) and does NOT accept L0172 programs. It is built on
`@graffiticode/l0000` ^0.10.1 and `@graffiticode/l0000-view` ^0.4.0.

It lives in the graffiticode monorepo as a **self-contained npm project**: its own lockfile,
install, build and tests, all run from this directory.

> **Two implementations live here.** `packages/` is the TypeScript L0186 that production runs; `crates/` is L0186's compiler in Rust. Everything down to "The Rust implementation" describes the TypeScript side.

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

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0186's compiler**. `packages/core` and
`packages/api` are the TypeScript compiler and server, which production runs (Cloud Run service
`l0186`). `crates/` is the same compiler in Rust, to be released to its own service `l0186r` so it
can be vetted before it replaces the TypeScript.

- `crates/core` (`graffiticode-l0186`) — `L0186` implements `Dialect` from `graffiticode-l0000`.
  `src/lib.rs` has the properties, members, containers, `save-to-figjam`, the `PROG` override
  and the early-`{}` check (`Dialect::check`, the TypeScript Checker's `PROG`); `src/vocab.rs`
  has `checkValue`, the hints and the `assert*` checks; `src/board.rs` is `board.ts` (nodes, page
  names, ids, connector resolution, `parseFileKey`). The vocabulary tables are read from
  `src/vocab.json`, which is **generated from `packages/core/src/attributes.ts`** by `npm run rust:fixtures`
  (each tag's `emit` function written out as the value it emits, and `exampleOf` for every word);
  `attributes.ts` stays the single source of truth. `src/lexicon-additions.json` is generated the
  same way. `src/plain.rs` is the plain-JavaScript value model the words work on (see below).
- `crates/server` (`l0186r-server`, binary `l0186r`) — `l0000r_server::serve(L0186, lexicon())`.
- `tools/assemble-static.mjs` — builds `packages/core`'s static assets and `packages/view`'s embed
  bundle into `./static` for the Rust server: exactly what `npm run assemble` puts in
  `packages/api/static`.

**Not ported, and why.** The SVG preview is not on the compile path: the compiler emits the board
and `packages/view` (TypeScript/React, `lib/layout.ts`, `lib/shapes.ts`, `lib/text.ts`) draws it
in the browser, so it is shared by both servers unchanged. Also left in TypeScript: the spec and
its static build (`tools/build-static.js`), the dev fixtures (`tools/fixtures.ts`) and the corpus
gate (`npm run check-corpus`), none of which a compile runs. Compiling makes no network call and
needs no secret; `save-to-figjam` only records `fileKey`.

**The Rust side depends on `languages/l0000` by relative path.** Read "The Rust implementation"
in `languages/l0000/CLAUDE.md`.

```bash
cargo test            # conformance, dialect and unit tests; needs no Node and no network
npm run rust:build    # rust:static, then cargo build --release -p l0186r-server
npm run rust:dev      # cargo run -p l0186r-server on :50186 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then regenerate src/vocab.json, src/lexicon-additions.json and the fixture
```

### What the Rust must get exactly right

The TypeScript unwraps every argument to a plain JavaScript value (`toPlainObject`) and builds
plain objects, and its messages print those values. `plain::Plain` models them, not JSON: a field
given nothing keeps its key with `undefined` (dropped from the output, as `JSON.stringify` drops
it); `div 1 0` is `Infinity` in a message; a number literal no double holds (a decimal.js object
in TypeScript, `Number::Exact` here) is seen as a record, with decimal.js's own keys
(`constructor`, `s`, `e`, `d`). Keys take JavaScript's order (array-index keys first). Strings
are `String()`'s (`1e+21`, `[object Object]`, lists joined with commas), quoting is
`JSON.stringify`'s, `trim` is JavaScript's white space, `Math.round` rounds halves up.

Where the TypeScript reads a property of a record a literal wrote in the wrong shape, it throws a
`TypeError` that becomes the error; `Plain::get`, `Plain::keys` and `board::walk` return the same
V8 messages (`Cannot read properties of null (reading 'id')`, `nodes is not iterable`). Lookups in
plain objects find `Object.prototype`: `fill "constructor"` is a named colour, and a record key
`toString` is reported as `function toString() { [native code] }` (`vocab::source_word`).

Errors accumulate as in TypeScript: a word reports its own error and yields `{}`, a property
still checks its value when the rest of its chain failed, and a container (or `PROG`) whose
arguments reported anything builds nothing more. A word's error has no position (`-1`); the
early-`{}` error points at the second description, as the TypeScript's does.

### Conformance

`crates/core/tests/conformance/generate.mjs` generates most of its corpus from `attributes.ts`:
every property with 42 values (good, wrong, quoted tags, tags from other sets, `_`, non-finite
and undefined values, nested descriptions, `save-to-figjam`) in each description that takes it;
every setting of every container with the same values; every word in every description and
settings chain that does not take it, and as a bare list item; every member and container in
every list; every tag of every tag word, bare and quoted; every side on every line type. Then the
spec's programs (and its fragments, alone and on a page), the TypeScript suite's
(`compiler.test.ts`, `errors.test.ts`, with `${two}` substituted and `nodesOf`/`conn` wrapped),
and about 220 hand-written cases: literal records of every wrong shape, keys, connectors and
sections, multi-page boards, `save-to-figjam` forms, decimals, L0000 expressions inside a board.
3413 cases, 2776 of them errors; every error message in the TypeScript source appears except three
the TypeScript cannot reach (the opacity-percentage hint, `describe`'s stray-`{}` branch,
`Object.keys(null)` in `assertKnownAttributes`). `tests/conformance.rs` requires the same JSON
text or the same messages in the same order for every case;
`tests/dialect.rs` checks error positions, that upstream data never reaches the board, and the
lexicon.

There are no deliberate differences. (Integers above 2^53 − 1 once came out in serde's float
form, `1e+20`; the kernel now writes every number as `JSON.stringify` does.)

### Deploying the Rust server

`deploy.json` has an `l0186r` entry (own service, `l0186r-run@graffiticode.iam.gserviceaccount.com`,
image from `configs/Dockerfile.l0186r.yaml`, snapshot this directory and `languages/l0000`, build
step `cargo test --locked`, env `AUTH_URL` only). Like the TypeScript it needs no secret and has
no protected function. The service and its account must be provisioned before the first release.
Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later (see
`languages/l0000/CLAUDE.md`). Nothing routes to `l0186r` by default.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and
`cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored build
outputs; `src/vocab.json`, `src/lexicon-additions.json` and `tests/conformance/cases.json` are
generated, not edited.
