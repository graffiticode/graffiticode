# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Two implementations live here.** `packages/` is the TypeScript L0181 that production runs; `crates/` is L0181 in Rust. Everything down to "The Rust implementation" describes the TypeScript side.

## Commands

### Development
- **Start dev server**: `npm run dev` (the language server on port 50181; expects the Firestore
  emulator at 127.0.0.1:8080 and local auth at 127.0.0.1:4100)
- **Build**: `npm run build` — `core` → `core build-static` → `api` → `view` → `view build:embed`
  → `assemble` (copies `core/dist/static` and `view/dist-embed` into `packages/api/static/`)
- **Start production**: `npm run start`

### Testing
- **All tests**: `npm test` (vitest in `packages/core` and `packages/view`)
- **One package**: `npm run -w packages/core test`, `npm run -w packages/view test`
- **One file**: `npx vitest run --root packages/core errors`
- `packages/core` tests run with that package as cwd — `docs.test.ts` reads `spec/*` relatively.

### Linting
- `npm run lint` / `npm run lint:fix` (ESLint over the monorepo), `npm run format` (Prettier)

### Deployment
- Release with `npm run deploy -- l0181` from the graffiticode repository root (deploy CLI; entry in root `deploy.json`, image from `configs/Dockerfile.l0181.yaml`, runtime `l0181-run`); `npm run gcp:logs` for logs.

## Architecture

L0181 is a Graffiticode dialect for **flashcard study decks** — two-sided cards a learner flips
and rates. It is a child of `@graffiticode/l0000`: an npm-workspaces monorepo of three packages.

- **`packages/core`** — `@graffiticode/l0181`, the language.
  - `src/lexicon.ts` — L0000's base lexicon merged with L0181's words via `mergeLexicon`, which
    throws at import if a child word shadows a base word without a declared override.
  - `src/compiler.ts` — `Checker`/`Transformer` extending L0000's, plus `PROG`.
  - `src/cards.ts` — validating and numbering the deck, and every error message it produces.
  - `spec/` — the language spec, authoring guidance, routing descriptors, schema, template.
  - `tools/build-static.js` — emits `dist/static/` for the API to serve.
- **`packages/api`** — private Express language server. `/compile`, `/form`, and the static
  assets, served before auth. Copied from L0180 and unchanged apart from the language id.
- **`packages/view`** — `@graffiticode/l0181-view`, the card player. Vite + Tailwind.

### The language

```
cards [["hola" "hello"] ["adiós" "goodbye"]] title "Spanish Vocab" theme LIGHT {}..
```

Every word is arity 2 and takes `(value, record)`, contributing one field to the record it is
handed. `cards` carries the deck and starts the chain; the chain ends in a record literal.

| Function | Arity | Description |
| :------- | :---: | :---------- |
| `cards` | 2 | The deck: a list of `["front" "back"]` pairs, then its configuration |
| `title` | 2 | The deck's title |
| `instructions` | 2 | Guidance shown above the deck |
| `theme` | 2 | `DARK` or `LIGHT`, written as a bare tag |

Compiles to `{ cards: [{ id, front, back }], title?, instructions?, theme? }`. `front` is the
prompt, `back` is the answer.

### Where validation goes

**Value checking lives in the Transformer, not the Checker.** `Checker.LIST` visits `elts[0]`
alone, so a rule written there fires on the first pair of the deck and nowhere else. The Checker
walks the tree and checks `theme`'s tag, which is a direct child; everything else is checked in
`cards.ts` and reported by the Transformer.

Two rules that are easy to break:
- Every Checker method must visit **both** children. `elts[1]` is the rest of the program, so a
  method that walks only `elts[0]` silently drops every error below it in the chain.
- A record inside the Transformer is still L0000's internal `Record` (`{_type, _entries: Map}`).
  Run it through `toPlainObject` before spreading it into an emitted value.

### Data flow

```
URL params -> View (from @graffiticode/l0000-view) -> getData -> Form -> Deck
Deck rating -> state.apply({type:"response"}) -> POST /compile -> data merges over the deck
```

The shared `View` owns the URL params, the load, the recompile loop and `postMessage`. L0181
supplies only `Form`, which is controlled (`formModel` stays `"live"`). A rating is reported as
a `response` action because that is one of the two action types the View recompiles on, and
`PROG` merges `options.data` **last** so the learner's state rides over the compiled deck.

### Tailwind

Preflight is off, because this is a published component. `src/index.css` restores the three
preflight rules that are load-bearing, scoped to `.l0181-deck`: `box-sizing: border-box`,
`border-style: solid; border-width: 0`, and `max-width: 100%; height: auto` on replaced
elements. Without the first, every `w-full p-6 border` element overflows its parent by exactly
its padding and border. Without the last, an author's image renders at its intrinsic size.

A card side that is a URL renders as an image, and keeping it inside the card takes both ends
of the chain. The image carries `max-h-full max-w-full object-contain`, but a percentage
max-height resolves to `none` against a parent of indefinite height — so the wrapper in `Deck`
must carry `h-full w-full` to inherit the card's definite `h-64`, plus `min-w-0` because a flex
item's automatic minimum size is its content's, which for a replaced element is the image's
intrinsic width. Drop the wrapper classes and a tall image runs straight through the card's
bottom border while `max-height: 100%` sits there computing to nothing.

Dark mode is `class`-based: the theme comes from the program and the learner's toggle, not from
the OS setting of whoever opens the iframe. `Form` puts `dark` on `.l0181-deck`.

### Key dependencies
- `@graffiticode/l0000` (^0.2.0) — base compiler, inherited by `core`
- `@graffiticode/l0000-view` (^0.1.3) — the shared `View`, inherited by `view`
- `@graffiticode/auth` — used by `api`
- `katex` — math rendering, applied only to `$…$` spans

### Environment variables
- `PORT` (default 50181)
- `AUTH_URL` (default https://auth.graffiticode.org; dev uses http://127.0.0.1:4100)
- `FIRESTORE_EMULATOR_HOST` (dev only)

## Relationship to L0159

L0181 supersedes [L0159](https://github.com/graffiticode/l0159)'s `flashcards` mode. It does
**not** read L0159's stored data shape — existing L0159 items stay with L0159, which keeps
serving them. L0159's `match` and `memory` modes are not ported.

Defects in L0159 that this deliberately does not reproduce, so don't reintroduce them by
copying from it: everything pushed through KaTeX in display mode (prose came out as italic
math); `\text{}` auto-wrapping in the compiler; `face` meaning the answer and `back` the prompt;
a wasted `{face: null, back: null}` in every pair; a double shuffle on load; next/previous
commented out so rating was the only way to advance; a `Checker` that checked nothing.

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0181**. `packages/core` and `packages/api` are the TypeScript compiler and server, which production runs (Cloud Run service `l0181`). `crates/` is the same language in Rust, released to its own service `l0181r` so it can be vetted before it replaces the TypeScript. `packages/view` (the card player) and the spec are shared by both.

- `crates/core` (`graffiticode-l0181`) — `src/lib.rs`: `L0181` implements `Dialect` from `graffiticode-l0000`. `CARDS`, `TITLE`, `INSTRUCTIONS` and `THEME` evaluate as `compiler.ts` and `cards.ts` do (`cards_from_pairs`, `show`, and `plain` for `toPlainObject`); `Dialect::check` is the TypeScript Checker's one rule (`theme` takes the literal tag `DARK` or `LIGHT`); the dialect claims `Op::Prog` to merge the upstream data over the program's value. `src/lexicon-additions.json` is **generated** from `src/lexicon.ts`; L0181 redefines no base word. `src/js.rs` orders object keys as JavaScript does.
- `crates/server` (`l0181r-server`, binary `l0181r`) — `l0000r_server::serve(L0181, lexicon())`.
- `tools/assemble-static.mjs` — builds the static assets and the `/form` bundle into `./static` for the Rust server (the same files `npm run build` assembles into `packages/api/static`).

**The Rust side depends on `languages/l0000` by relative path.** Read "The Rust implementation" in `languages/l0000/CLAUDE.md`.

Not ported, and why: the view, the spec and `tools/build-static.js` are not on the compile path (the Rust server serves what they build), and `packages/api` is replaced by the shared `l0000r-server`. Nothing on L0181's compile path calls a JavaScript library, a network service or a secret, so nothing stays behind in JavaScript.

```bash
cargo test            # conformance and unit tests; needs no Node and no network
npm run rust:build    # rust:static, then cargo build --release -p l0181r-server
npm run rust:dev      # cargo run -p l0181r-server on :50181 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then regenerate src/lexicon-additions.json and the fixture
```

### What the Rust must get exactly right

- **Spread.** Each word does `{...(toPlainObject(rest) || {}), field}`, so `spread` takes from the rest of the chain exactly what JavaScript's spread does: a record's fields (key kinds dropped), a list's indices, a string's UTF-16 code units, a tag's `tag` and a function's `lambda`; nothing from a falsy value, a number or a boolean. `PROG` spreads the program's value when it is an object (a record, a tag or a function) and then the upstream data over it; any other value is left alone.
- **Key order.** Every object in the TypeScript output is a JavaScript object, so integer-like keys come first; `PROG` puts the whole value through `js::order`.
- **The Checker's walk.** The TypeScript Checker visits only some children (L0000's `LIST` its first element; `RECORD`, `MAP` and `IF` none), so a bad `theme` in an unwalked position compiles and emits its argument as it is (`[1 theme 5 {}]..` is `[1,{"theme":5}]`). `checked` lists what each node visits; a `theme` drops its first argument's errors and reports its own after the chain it wraps. The argument is named as the Checker sees it: `tag X`, a string JSON-quoted, a number as `String()` writes it lowercased, any other node by its lowercased tag (`bool`, `list`, `get_var`, `paren`).
- **`show`.** A value is named as `cards.ts` names it: a string JSON-quoted, a list by its length, `nothing` for null or undefined, and `a record` for every JavaScript object — tags, functions, and numbers no `f64` holds (a `Decimal`) included.
- **Error order.** A word's argument's errors, then the rest's, then its own.

### Conformance

`crates/core/tests/conformance/generate.mjs` generates most of the corpus: each attribute word given 26 kinds of value; each word handed 14 kinds of rest, inside and outside a deck; 39 decks of every shape; every order of the attributes and errors along the chain; a bad `theme` or `title` in every position the Checker does and does not walk; seven kinds of program result under 13 kinds of upstream data; and tags the lexicon cannot spell (`BLUE`, `Σ`), put into the parsed tree by hand. Then the spec's programs, the TypeScript suite's (`compile`/`errorOf` strings), and hand-written cases. A case may carry its upstream `data`. `tests/conformance.rs` requires the same JSON text (key order included), or the same errors in the same order, for all 473 cases (218 with errors, 91 with upstream data) but the ten below; every error message `cards.ts` and `compiler.ts` can produce appears. `tests/dialect.rs` checks where errors point: a bad `theme` at its argument's `coord` (-1/-1 for a number literal, which has none), the Transformer's errors at -1/-1.

Deliberate differences, each with its own test:

- **An upstream `{data, errors}` envelope is unwrapped** (seven cases). The kernel does this for every Rust language and merges what the envelope carries; the TypeScript merges the envelope itself, so `data` and `errors` become fields. The view sends the learner's state, not an envelope.
- **A number no `f64` holds is a number** (`12345678901234567890..`). In TypeScript it is a `Decimal` object, which `PROG` spreads into its internals (`{"s":1,"e":19,"d":[…]}`). The same goes, untested, for such a number handed to a word as its rest.
- **`add` given a record** says `expected a number, got a record` (the kernel's message), not decimal.js's `[DecimalError] Invalid argument: [object Object]`.
- **An error in an applied function is reported once**; TypeScript's `LAMBDA` reports its body's errors twice.

Also different, and not in the fixture: a string spread into the chain that splits an astral character (`theme DARK "😀"..`) gives U+FFFD fields where JavaScript keeps the lone surrogates, which a Rust string cannot hold (unit-tested); and a program with both a syntax error and a bad `theme` gets the kernel's syntax errors first rather than in tree order.

### Deploying the Rust server

`deploy.json` has an `l0181r` entry (own service, `l0181r-run@graffiticode.iam.gserviceaccount.com`, image from `configs/Dockerfile.l0181r.yaml`, snapshot this directory and `languages/l0000`, build step `cargo test --locked`). Its only env var is `AUTH_URL`, like the TypeScript's; L0181 has no protected functions, secrets or compile-time network calls, and the account needs no roles. Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later (see `languages/l0000/CLAUDE.md`). Nothing routes to `l0181r` by default.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored build outputs; `src/lexicon-additions.json` and `tests/conformance/cases.json` are generated, not edited.
