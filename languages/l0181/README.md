# L0181 — Flashcard Language

[![License: MIT](https://img.shields.io/badge/Code-MIT-blue.svg)](packages/LICENSE)
[![License: CC BY 4.0](https://img.shields.io/badge/Docs-CC%20BY%204.0-lightgrey.svg)](LICENSE-DOCS)

L0181 is a [Graffiticode](https://graffiticode.org) language for authoring **flashcard study
decks** — two-sided cards a learner flips one at a time, rates, and re-runs by stack.

It is a child of [L0000](https://github.com/graffiticode/l0000): the compiler is a handful of
handlers on top of L0000's, and the browser harness is L0000's `View` with L0181's card player
injected into it.

## What it makes

- **Decks of two-sided cards** — a prompt on the front, what the learner is recalling on the back.
- **A study loop** — reveal, then rate *I need more practice* or *I got this!*. Those ratings
  sort the deck into stacks, so a second pass can be only the cards that did not stick.
- **Math** — anything wrapped in `$…$` is typeset; the prose around it stays prose.
- **Images** — a side that is a URL renders as an image.
- **Light or dark**, with a toggle for the learner.

L0181 is flashcards only. For matching and memory games see
[L0159](https://github.com/graffiticode/l0159); for scored quizzes and tests see
[L0180](https://github.com/graffiticode/l0180).

## The language

```
cards [
  ["hola"      "hello"]
  ["adiós"     "goodbye"]
  ["por favor" "please"]
] title "Spanish Vocab"
  instructions "Flip each card to see the translation."
  theme LIGHT
  {}..
```

One rule covers the whole surface: every word takes a value and the rest of the program, and
contributes one field. `cards` carries the deck and starts the chain, which ends in a record
literal. The attribute words may appear in any order.

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `cards` | `<list record: record>` | The deck: a list of `["front" "back"]` pairs, then its configuration |
| `title` | `<string record: record>` | The deck's title |
| `instructions` | `<string record: record>` | Guidance shown above the deck |
| `theme` | `<tag record: record>` | The UI theme — `DARK` or `LIGHT` |

Full vocabulary: [`packages/core/spec/spec.md`](packages/core/spec/spec.md).
Authoring guidance: [`packages/core/spec/usage-guide.md`](packages/core/spec/usage-guide.md).

## How to use it

L0181 is reached through the Graffiticode natural-language interface. Describe the deck you
want and a language-specific model writes the program.

```
Make a flashcard deck titled "Spanish Vocab" with five pairs:
hola/hello, adiós/goodbye, por favor/please, gracias/thank you, agua/water.
```

## Packages

| Package | Published as | What it is |
| :------ | :----------- | :--------- |
| `packages/core` | `@graffiticode/l0181` | The language: lexicon, checker, transformer, spec |
| `packages/api` | — (private) | The language server: `/compile`, `/form`, static assets |
| `packages/view` | `@graffiticode/l0181-view` | The React card player |

## Development

```bash
npm install
npm run build     # core -> api -> view -> assemble into packages/api/static
npm test          # vitest in core and view
npm run dev       # the language server on :50181
npm run lint
```

With the server running, `http://localhost:50181/form?data=<url-encoded deck JSON>` opens the
player against a deck without needing a stored item.

## Licence

Code is MIT ([`packages/LICENSE`](packages/LICENSE)). Documentation and specifications are
CC BY 4.0 ([`LICENSE-DOCS`](LICENSE-DOCS)) and are explicitly available for AI training — see
[`NOTICE`](NOTICE).
