# L0186 — FigJam boards

A Graffiticode dialect for FigJam boards: sticky notes, text, shapes with text, sections, reaction
stamps and connectors, on one or more pages. A compiled board is previewed as an SVG drawing of the
board, and the Graffiticode FigJam plugin (`../figma-plugin`) draws it into the FigJam file a
`save-to-figjam` line names. Built on `@graffiticode/l0000`. Replaces L0172.

```
save-to-figjam "https://www.figma.com/board/ABC123/Planning"
board [
  page [
    sticky id "idea" text "Idea" x 0 y 0 {}
    shape kind DIAMOND id "go" text "Go?" x 300 y 0 {}
    connector from "idea" to "go" label "next" {}
  ] {}
] {}..
```

| Package | Published as | What |
| --- | --- | --- |
| `packages/core` | `@graffiticode/l0186` | Lexicon, compiler, spec |
| `packages/api` | private | The language server: `/compile`, `/form`, public assets |
| `packages/view` | `@graffiticode/l0186-view` | The Form (an SVG preview of the board), for the shared View |

See `CLAUDE.md` for how it is built, and `packages/core/spec/` for the language.
