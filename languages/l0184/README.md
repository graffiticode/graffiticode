# L0184 — charts

A Graffiticode dialect for charts drawn with Apache ECharts: bar, line, pie (donut, rose) and
scatter plots over inline data or datasets, one chart or a collection shown as tabs. Built on
`@graffiticode/l0000`. Replaces L0173.

```
charts [
  chart [
    plots [ plot kind BAR name "Visitors" values [120 132 101 134] {} ] {}
  ] title "Weekly visitors" {}
] {}..
```

| Package | Published as | What |
| --- | --- | --- |
| `packages/core` | `@graffiticode/l0184` | Lexicon, compiler, spec |
| `packages/api` | private | The language server: `/compile`, `/form`, public assets |
| `packages/view` | `@graffiticode/l0184-view` | The Form (ECharts), for the shared View |

See `CLAUDE.md` for how it is built, and `packages/core/spec/` for the language.
