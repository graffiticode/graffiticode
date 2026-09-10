# L0014 (Internal)

A Graffiticode dialect for authoring [TransLaTeX](https://github.com/graffiticode/translatex)
translation rule sets — a port of L120 onto the L0000 framework.

```
words { "\\alpha": "\\alpha" }
types { "signedExpr": ["-?", "+?"] }
rules { "?+?": "%1 + %2", "?": "%1" }
tests [["1+2", "1 + 2"]]
..
```

Compiles to `{options, tests}`: `options` is the rule set you hand to
`TransLaTeX.buildTranslator`, `tests` is each case scored against it.

See `CLAUDE.md` for the output contract and the two parser differences that bite silently.
