<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0181 Dialect Extensions

L0181 authors **flashcard study decks**. A program compiles to a deck of two-sided cards that
a learner flips and rates, one at a time.

## Writing a program

One rule covers the whole surface. There is no per-word syntax to memorize.

**Every word takes a value and the rest of the program**, and contributes one field. So the
whole program is a single chain that ends in a record literal — `{}` when there is nothing
more to configure. `cards` carries the deck and starts the chain:

```
cards [["hola" "hello"] ["adiós" "goodbye"]] title "Spanish Vocab" {}..
```

- The attribute words may appear in any order after the deck.
- Lists are space-separated (`[1 2 3]`, not `[1, 2, 3]`).
- Every program ends with `..`.
- Never drop the trailing `{}` — it is the record the chain merges into.

## L0181 Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `cards` | `<list record: record>` | The deck: a list of `["front" "back"]` pairs, then its configuration |
| `title` | `<string record: record>` | The deck's title |
| `instructions` | `<string record: record>` | Guidance shown above the deck |
| `theme` | `<tag record: record>` | The UI theme — the tag `DARK` or `LIGHT` |

## Guidelines

- Each card is a two-element list, `["front" "back"]`. The front is the prompt the learner
  sees first; the back is what flipping reveals. Put the term on the front and the definition
  on the back, not the other way round.
- Both sides must be strings. A deck needs at least one card.
- Wrap math in `$…$` — `["$x^2$" "x squared"]`. Text outside the delimiters stays prose, so
  do not wrap ordinary words in `\text{}`.
- A side that is a URL renders as an image. There is no separate word for images.
- **A URL the author gave you goes into the card exactly as they wrote it.** Character for
  character, whatever the domain. It is the author's link and they can see whether it works;
  you cannot. Do not rewrite it, do not swap its host for one you recognise, and do not
  replace the card with a note saying the link looked wrong. A caller who pastes a URL has
  already decided.
- **Never judge a URL by its domain.** An unfamiliar host is not a broken host, and there is
  no list of blessed image domains. `thumb.wikimedia.org`, `upload.wikimedia.org`, a company's
  own CDN, an S3 bucket and a personal server are all equally valid. Rejecting a link because
  the domain is not the one you expected is the single worst thing you can do here: it throws
  away a working image on a hunch and hands the learner a sentence about domains where the
  picture should be.
- **Never invent an image URL.** This is the opposite failure and just as bad. A URL assembled
  from memory or from a plausible-looking pattern does not resolve, the learner gets a broken
  image, and nothing in the compiler catches it. Only one source may be constructed rather
  than copied, because its paths are a published code and not a content hash: country flags
  are `https://flagcdn.com/w320/<ISO 3166-1 alpha-2>.png` — `jp`, `br`, `eg`, `ca`. Wikimedia
  is not a second exception. Its thumbnail paths embed a hash of the file (`/thumb/1/1b/…`)
  that cannot be derived from anything, and while
  `https://commons.wikimedia.org/wiki/Special:FilePath/<file name>?width=330` needs no hash,
  it still needs the exact Commons file name — which is the part you would be guessing.
  Knowing the URL's shape is not knowing that the image exists.
- **If you can fetch, verify; if you cannot fetch, pass it through.** Where you have a way to
  make a request, check the URL returns a `2xx` and an `image/*` content type —
  `curl -sIL -o /dev/null -w '%{http_code} %{content_type}' <url>` — and tell the author about
  any that fail. Where you have no such way, emit the author's URL unchanged. Verification
  means a request that came back; it never means an opinion about how the link looks. An
  unverified URL is emitted, not dropped.
- If the author asks for pictures but gives no URLs, **do not go looking for some.** Write the
  side as text naming what the picture would show and say the deck needs URLs. A text card is
  usable; a broken image is not. This is the ONLY case where an image card becomes a text
  card — never when a URL was supplied.
- `theme` takes a bare tag, `theme DARK`, never the string `theme "dark"`.
- Do not shuffle or order the deck in the program — the player shuffles, and the learner's
  ratings decide what comes back.

## Example Patterns

- A bare deck:
  ```
  cards [["term" "definition"]] {}..
  ```
- Titled, with instructions:
  ```
  cards [
    ["photosynthesis" "process by which plants convert light to energy"]
    ["mitosis"        "cell division producing two identical cells"]
  ] title "Cell Biology"
    instructions "Flip each card to check yourself."
    {}..
  ```
- Math, in a dark deck:
  ```
  cards [
    ["$a^2 - b^2$"           "$(a+b)(a-b)$"]
    ["$\sin^2 x + \cos^2 x$" "$1$"]
  ] title "Identities" theme DARK {}..
  ```
