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
  - `src/bin/emit.rs` — writes the vocabulary-derived files to `generated/`, or `--check`s them.
- `crates/server` (`l0187-server`, binary `l0187`) — `l0000r_server::serve_with(L0187, …)`.
- `generated/` — **committed** emit output (`lexicon.json` so far; `schema.json` later). The
  freshness target for `emit --check`, and what the static assembly copies.
- `crates/core/tests/programs/*.gc` — test programs, one per file; `invalid-*` must be rejected.
  `tools/parse-cases.mjs` parses them with `@graffiticode/parser` and `generated/lexicon.json`
  into `crates/core/tests/cases.json` (there is no Rust parser; the API parses upstream).
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
