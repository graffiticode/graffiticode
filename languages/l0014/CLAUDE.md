# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

L0014 is an **internal** Graffiticode dialect for authoring TransLaTeX translation rule sets. It is
a port of **L120** ("a language for writing LaTeX translators") from the retired `gc.acx.ac` host
onto the modern L0000 framework.

It exists because the rule sets `@graffiticode/translatex` ships were never hand-written JS. They
are compiled L120 output — `translatex/tools/build.js` fetched `data?id=0vgCM11vlfA` and wrote
`data.options` into `src/rules.js`. That pipeline is dead (the host does not resolve; the shipped
`data.txt` is a 404 page), so the rule sets became hand-edited artifacts and drifted. L0014 gives
them an authoring surface again.

## The output contract

`PROG` emits `{options, tests}`.

- `options` is `{data, words, types, rules, ...parser options}` — exactly what a consumer passes to
  `TransLaTeX.buildTranslator`. Every consumer rule set (`evalRules`, `normalizeRules`, …) is a
  subset of that shape.
- `tests` is each corpus case scored `1` or `-1`, with `{score, source, actual, expected}`.

`data` is always present and always empty — a vestige of the old host that every recovered rule set
carries. Emitting it is what keeps the round-trip byte-identical.

## The acceptance test is identity, not plausibility

`src/rules.test.ts` reconstructs the LaTeX-to-LaTeX rule set as L0014 source, compiles it, and
requires the result to equal `@graffiticode/translatex/src/rules.js` **exactly** — including key
order, because translatex's `match()` takes the first hit in `Object.keys` order, so the order rules
are written in IS their precedence.

That artifact is verified: the `data.txt` inside `artcompiler-translatex-0.15.0.tgz` is
byte-identical to the shipping `src/rules.js` (49 words, 1 type, 80 rules). Any weaker test —
"compiles without error" — would pass on a port that reorders rules or eats a backslash, and both
are silent mis-translations downstream.

The comparison is `JSON.stringify(compiled) === JSON.stringify(shipped)` — the whole options
object, not a field-by-field check. That distinction is not pedantic: an earlier version compared
only `words`/`types`/`rules`, went green, and was silently dropping `parsingIntegralExpr` and `RHS`,
both of which are in the shipping rule set.

`spec/latex-to-latex.gc` is the committed reconstruction and is itself under test. **Do not edit it
casually** — an edit that changes the rule set fails the suite. Regenerate it with
`node tools/gen-latex-rules.mjs`.

Its section headings (`/* Sets */`, `/* Trig */`, …) are not invented. They are lifted from a real
L120 **source** program preserved in `github.com/artcompiler/L120` (`tests/*.json`) that is an
ancestor of this rule set — 48/49 words, 69/80 rules — and mapped onto the target's own order via
`src/fixtures/latex-to-latex.sections.json`. That mapping yields ten contiguous runs in exactly the
ancestor's section order with nothing left over, which is itself evidence the shipping rule order
IS the authored order rather than an artifact of serialization. The eleven rules newer than the
ancestor inherit the heading above them.

`optionFields` in `compiler.ts` and `optionWords` in `pretty.ts` must stay in step, in the same
order — the first decides compiled key order, the second decides which options survive a round
trip. They fell out of step once already; that is how the two missing keys got in.

## Two things the modern parser does that L120's did not

Both bite silently, and both are why a recovered L120 source cannot be fed to L0014 verbatim.

- **Backslashes are escapes.** `"\times"` lexes as TAB + `"imes"`, `"\nless"` as NEWLINE + `"less"`,
  `"\right"` as CR + `"ight"`. No error — just a pattern that stops matching. Every string
  L0014 emits goes through `JSON.stringify`, so source here says `"\\times"`.
- **There is no line comment.** `/* ... */` is the only form. `|` (L120's), `--` and `#` are
  rejected outright; `//` is *not* rejected — it lexes as two division operators and parses fine
  until the text contains a `.`, then fails somewhere unrelated.

## Commands

```bash
npm test                       # vitest in packages/core (incl. the round-trip identity check), then packages/view
npm run build                  # core tsc -> build-static -> api tsc -> view lib + embed -> assemble
npm run dev                    # language server on :50014
npm run lint

# single file / single test (from packages/core)
npx vitest run src/rules.test.ts -t "round trip"

# tools import ../dist, so run `npm run -w packages/core build` first (from packages/core)
node tools/gen-latex-rules.mjs                 # regenerate spec/latex-to-latex.gc
node tools/emit-translatex-rules.mjs --check   # verify ../translatex/src/rules.js matches the .gc
node tools/emit-translatex-rules.mjs           # write it (translatex is a sibling checkout)
```

Vitest must run with `packages/core` as cwd — the tests read `spec/*` by relative path.

`docs.test.ts` compiles every fenced program in `spec/*.md` and checks that every word in
`spec.md`'s tables exists in the lexicon. Editing the docs is editing tested code: a wrong example
there is copied verbatim into LLM-generated programs.

## Architecture

- **`packages/core`** (`@graffiticode/l0014`) — the compiler. Extends `@graffiticode/l0000`.
  - `lexicon.ts` — the vocabulary. Transcribed from L120's `src/lexicon.js`; its whole surface is
    thirteen words. `equiv` and `apply` are **not** redeclared: L0000 already defines them and its
    `equiv` subsumes L120's.
  - `compiler.ts` — Checker + Transformer. One deliberate departure from L120: there,
    `words`/`rules`/`types` mutated shared `options` and `PROG` took the last expression as the
    tests ("Tests must be last"). Here each statement is a pure single-key contribution that PROG
    merges, then runs the corpus. Same output, no ordering rule.
  - `pretty.ts` — `toSource`, the DATA → source direction. This is what makes an existing rule set
    recoverable at all.
- **`packages/api`** — the Express language server, port 50014. Scaffolded from L0176, with
  L0176's Learnosity credential injection and `cache: false` removed: an L0014 compile is a pure
  function of source and data, so results are safe to cache. Don't bring them back.

- **`packages/view`** (`@graffiticode/l0014-view`) — the `/form` page: the corpus results for an
  item. Scaffolded from L0010's view. It mounts the shared `View` from `@graffiticode/l0000-view`
  (^0.1.4, from npm; the local `../l0000` checkout is older), which fetches the compiled data and
  calls `Form({ state: { data, errors } })` with `data` = `{options, tests}`. The Form is
  read-only and never calls `apply`. The build copies `dist-embed/` into `packages/api/static`,
  where `GET /form` serves it.
  - `results.ts` classifies each case. An empty `expected` is **captured**, not failed: the
    compiler scores it `-1`, but it asserts nothing, and a capture-style corpus would otherwise
    show entirely red. `captured` is checked before `pass`, so an empty expected with an empty
    actual is captured, not passed.
  - Translations render as text, never typeset. The defects an author is looking for are a
    dropped backslash or a changed space, and typeset math hides both.
  - To see it without the platform: build, start the api, and open
    `/form?data=<urlencoded {options, tests}>`. With no `id`, the View seeds itself from `data`.

## Deployment

The service is Cloud Run `l0014` in GCP project `graffiticode`, us-central1, released with
`npm run deploy -- l0014` from the graffiticode repository root (deploy CLI; entry in root `deploy.json`, image from `configs/Dockerfile.l0014.yaml`, runtime `l0014-run`). The only runtime env var is `AUTH_URL`. The pipeline mirrors L0000's, not
L0176's, which also wires Learnosity secrets.

The platform resolves a compiler host with `getCompilerHost` (`graffiticode/packages/api/src/util.js`).
L0014 has no entry in that repo's `config/config.json` `hosts`, so the platform looks for it at
`l0014.graffiticode.org`, the Cloudflare-fronted pattern L0013 and L0179 use. The name needs a
DNS record pointing at the Cloud Run service. Without one, deploys succeed but the platform can't
reach them.

## Not ported, deliberately

The `RHS`/`NoParens`/`EndRoot` context-alternate SYNTAX. These are L120's context alternates, and
the source of the three hard-coded context names in translatex's `core.js:1001-1003`. **No
shipping rule set uses them** (checked across translatex's own set and all four of L0179's). The
machinery in translatex also carries a context-accumulation bug at `core.js:991`. Port them when a
rule set needs them, not on spec.

What does and doesn't work today:

- **Nested sub-rules work.** `{ "%1+%2": { "x": "X" } }` scopes those rules to that expansion's
  arguments. Two shipping rules use this form (`\type{matrix}`, `\lim_? ?`), and the identity test
  covers them.
- **Context alternates work if written as raw records**, because nested records pass through to
  translatex unchanged: `{ "%1+%2": [ { options: { RHS: true }, value: {...} }, {...} ] }`. The
  first alternate whose flag is set wins, and the untagged one is the fallback.
- **`rhs {...}` inside a rule is a silent failure.** The word compiles to L0014's internal
  `{__l0014, value}` wrapper, translatex fails to parse it as a pattern, and every corpus case
  comes back `""`, including unrelated ones. No compile error is reported. `deprecatedWords` is
  empty, so nothing catches it. At the top level, `rhs false` is fine: it just sets the option.
- Only `RHS` ever changes during a translation: translatex sets it for the right operand of
  binary and multiplicative nodes. `NoParens` and `EndRoot` are fixed by the caller's options.

## Related

- `~/work/graffiticode/translatex` — the consumer. `src/rules.js` is what this language produces.
- `~/work/graffiticode/parselatex` — under translatex.
- `github.com/artcompiler/L120` — the original (private; branches `master`, `build`, `contexts`,
  `testing`). `tests/*.json` there carry real L120 **source** programs, including an ancestor of
  the shipping rule set and a ~50-case LaTeX corpus.
