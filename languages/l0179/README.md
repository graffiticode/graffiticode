# L0179

A Graffiticode dialect for interactive spreadsheets, in the attribute-list style. See
`CLAUDE.md` and `packages/core/spec/`.

## Rust implementation

`crates/` holds the L0179 compiler in Rust: a `Dialect` on the kernel in `languages/l0000/crates`,
with a language server (`crates/server`, binary `l0179r`). The TypeScript in `packages/` remains
production; `attributes.ts` remains the single source of truth for the vocabulary, and the view,
its scoring and the Learnosity bundles stay TypeScript.

```bash
cargo test            # needs no Node and no network
npm run rust:build    # ./static, then the release binary (target/release/l0179r)
npm run rust:dev      # run it on :50179
```

See `CLAUDE.md` for the details.
