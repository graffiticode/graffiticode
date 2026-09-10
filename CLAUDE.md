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

`spec/latex-to-latex.gc` is the committed reconstruction and is itself under test. **Do not edit it
casually** — an edit that changes the rule set fails the suite.

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
npm test                       # vitest in packages/core — includes the round-trip identity check
npm run build                  # core tsc -> build-static -> api tsc -> assemble
npm run dev                    # language server on :50014
npm run lint
```

Vitest must run with `packages/core` as cwd — the tests read `spec/*` by relative path.

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
- **`packages/api`** — the Express language server, port 50014. Scaffolded from L0176.

There is no `packages/view`: L0014 authors compiler input, and nothing a learner sees.

## Not ported, deliberately

`RHS`, `NoParens` and `EndRoot` — L120's context alternates, and the source of the three
hard-coded context names in translatex's `core.js:1001-1003`. **No shipping rule set uses them**
(checked across translatex's own set and all four of L0179's). The machinery in translatex also
carries a context-accumulation bug at `core.js:991`. Port them when a rule set needs them, not on
spec. `lexicon.ts`'s `deprecatedWords` names them so the failure is legible.

## Related

- `~/work/graffiticode/translatex` — the consumer. `src/rules.js` is what this language produces.
- `~/work/graffiticode/parselatex` — under translatex.
- `github.com/artcompiler/L120` — the original (private; branches `master`, `build`, `contexts`,
  `testing`). `tests/*.json` there carry real L120 **source** programs, including an ancestor of
  the shipping rule set and a ~50-case LaTeX corpus.
