# L0183

[![License: MIT](https://img.shields.io/badge/Code-MIT-blue.svg)](packages/LICENSE)
[![License: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-lightgrey.svg)](LICENSE-DOCS)

L0183 is a Graffiticode dialect for **concept webs**: a hub in the centre, nodes on a circle
around it, and lines between them that may carry labels. Any node — the hub included — and any
line can be a **blank** the learner fills by dragging an answer from a tray. It inherits the base
vocabulary of [@graffiticode/l0000](https://www.npmjs.com/package/@graffiticode/l0000), and
succeeds [L0169](https://github.com/graffiticode/l0169).

```
concept-web [
  hub text "The Cell" {}
  nodes [
    node text "Nucleus" {}
    node text "Mitochondria" assess [expected] {}
    node text "Ribosome" assess [expected] {}
    node text "Cell membrane" assess [expected] {}
    node text "Chlorophyll" assess [distractor] {}
  ] {}
] title "Parts of a cell" instructions "Drag each part onto an empty node." {}..
```

- A blank carries its answer as its text; the compiler hides it and builds the tray from the
  answers plus the `assess [distractor]` members, so the tray can never disagree with the key.
- Blanks whose places in the web cannot be told apart accept each other's answers.
- Scoring is partial credit per blank, and the compiled output is in the cell-scoring shape of
  Graffiticode's Learnosity custom questions — an L0176 item embeds a web with
  `custom [lang "0183" …]`, served from this repo's `question.js` / `scorer.js`.
- Drag with mouse or touch, or select-then-place from the keyboard.

See [`packages/core/spec/spec.md`](packages/core/spec/spec.md) for the language and
[`CLAUDE.md`](CLAUDE.md) for how the repo fits together.

## Packages

| Package | Published as | What it is |
| :------ | :----------- | :--------- |
| `packages/core` | `@graffiticode/l0183` | The compiler and the spec |
| `packages/view` | `@graffiticode/l0183-view` | The Form, and DOM-free scoring on `./scoring` |
| `packages/api` | private | The language server: `/compile`, `/form`, static assets |
| `packages/integrations/learnosity` | private | The Learnosity custom question type |

```bash
npm install
npm run build
npm test
npm run dev    # the language server on :50183
```
