# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- `npm run gcp:build` (Cloud Build), `npm run gcp:deploy` (Cloud Run `l0181`, port 50181),
  `npm run gcp:logs`

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
