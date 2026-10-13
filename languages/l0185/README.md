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
