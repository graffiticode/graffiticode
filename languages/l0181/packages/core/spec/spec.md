<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0181 Vocabulary

This specification documents the dialect-specific functions available in the
**L0181** language of Graffiticode. These functions extend the core language
with flashcard deck authoring.

The core language specification including the definition of its syntax,
semantics and base library can be found here:
[Graffiticode Language Specification](./graffiticode-language-spec.html)

## Overview

An L0181 program is one deck. It compiles to a `cards` list — each card a `front` (the
prompt) and a `back` (the answer) — plus whatever the deck was configured with.

The learner sees one card at a time, flips it, and rates it: *I need more practice* or *I got
this!*. Those ratings sort the deck into stacks, so a second pass can be just the cards that
did not stick. The deck is what the program says; the rating is what the learner adds.

## Writing a program

One rule covers the whole surface: **every word takes a value and the rest of the program**,
and contributes one field. `cards` takes the deck and then the chain of everything else, which
ends in a record literal — `{}` when there is nothing more to configure.

```
cards [
  ["hola"  "hello"]
  ["adiós" "goodbye"]
] title "Spanish Vocab"
  instructions "Flip to reveal"
  {}..
```

The order of the attribute words does not matter. Lists are space-separated (`[1 2 3]`, not
`[1, 2, 3]`). Every program ends with `..`.

## Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `cards` | `<list record: record>` | The deck: a list of two-element pairs, then its configuration |
| `title` | `<string record: record>` | The deck's title |
| `instructions` | `<string record: record>` | Guidance shown above the deck |
| `theme` | `<tag record: record>` | The UI theme — `DARK` or `LIGHT` |

### cards

The deck. Its first argument is a list of `["front" "back"]` pairs: the front is what the
learner sees first, the back is what flipping reveals. Its second argument is the rest of the
program.

A deck needs at least one pair, and every pair needs exactly two strings.

```
cards [
  ["photosynthesis" "process by which plants convert light to energy"]
  ["mitosis"        "cell division producing two identical cells"]
] {}..
```

### title

A heading above the deck.

```
cards [["2+2" "4"]] title "Math Facts" {}..
```

### instructions

A line of guidance under the title, for whatever the deck does not say for itself.

```
cards [["hola" "hello"]]
  instructions "Say each word aloud before you flip it."
  {}..
```

### theme

`LIGHT` or `DARK`. Written bare, as a tag — not as a string. The player shows a toggle, so
this sets where the learner starts rather than where they must stay.

```
cards [["hola" "hello"]] theme DARK {}..
```

## Card content

### Math

Wrap math in `$…$` and it renders as math; everything outside stays prose. A card can be all
math, part math, or none.

```
cards [
  ["$x^2 + 2x + 1$"        "$(x+1)^2$"]
  ["The derivative of $x^2$" "$2x$"]
] title "Algebra Identities" {}..
```

### Images

A side that is a URL renders as an image. Use it on either half of a pair, or both.

```
cards [
  ["https://flagcdn.com/w320/jp.png" "Japan"]
  ["https://flagcdn.com/w320/br.png" "Brazil"]
] title "Flags" {}..
```

The URLs above are real and resolve. That is deliberate: nothing in the compiler checks a URL,
so a placeholder host copied out of a spec compiles cleanly and renders as a broken image.

The rule in both directions is that the author owns the link. A URL the author supplies is
emitted exactly as written, whatever its host — there is no list of acceptable image domains,
and an unfamiliar one is not a broken one. A URL the author did not supply is not invented;
flags are the single exception, `https://flagcdn.com/w320/<ISO 3166-1 alpha-2>.png`, because
the path is a published country code rather than a content hash. Confirming a URL means
fetching it and getting an image back; where no request can be made, the URL is emitted
unchecked rather than dropped.

## Program Examples

A vocabulary deck with a title and instructions:

```
cards [
  ["hola"      "hello"]
  ["adiós"     "goodbye"]
  ["por favor" "please"]
  ["gracias"   "thank you"]
  ["agua"      "water"]
] title "Spanish Vocab"
  instructions "Flip each card to see the translation."
  theme LIGHT
  {}..
```
