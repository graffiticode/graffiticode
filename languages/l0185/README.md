# L0185 — fetch and shape data

A Graffiticode dialect that fetches JSON or CSV from a public https URL — or takes data written
inline — and reshapes it: filter, pick, rename, derive, group and summarize, sort, join. The
output is the transformed data itself. Built on `@graffiticode/l0000`. Replaces L0170.

```
sort-by ["revenue" DESC]
summarize {orders: COUNT revenue: [SUM "amount"]}
group-by ["region"]
where ["status" EQUALS "paid"]
fetch "https://l0185.graffiticode.org/data/sales.csv"
{}..
```

| Package | Published as | What |
| --- | --- | --- |
| `packages/core` | `@graffiticode/l0185` | Lexicon, compiler, spec, sample data |
| `packages/api` | private | The language server: `/compile`, `/form`, the guarded fetcher, public assets |
| `packages/view` | `@graffiticode/l0185-view` | The Form (a record table or a JSON tree), for the shared View |

See `CLAUDE.md` for how it is built, and `packages/core/spec/` for the language.

## Rust implementation

`crates/` holds L0185 in Rust: a `Dialect` on the kernel in `languages/l0000/crates`, with a
language server (`crates/server`, binary `l0185r`) that fetches through the same guarded HTTPS
fetcher. The TypeScript in `packages/` remains production; `attributes.ts` remains the single
source of truth for the vocabulary.

```bash
cargo test            # needs no Node and no network
npm run rust:build    # ./static, then the release binary (target/release/l0185r)
npm run rust:dev      # run it on :50185
```

See `CLAUDE.md` for the details.
