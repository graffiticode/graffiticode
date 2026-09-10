## L0014

L0014 authors a TransLaTeX translation rule set. It is internal: it produces compiler input, not
anything a learner sees.

Four statements, in any order:

```
words { "\\alpha": "\\alpha" }
types { "signedExpr": ["-?", "+?"] }
rules { "?+?": "%1 + %2", "?": "%1" }
tests [["1+2", "1 + 2"]]
..
```

- `words` maps a LaTeX token to its replacement.
- `types` names a class of patterns, referenced elsewhere as `\type{name}`.
- `rules` maps a source pattern to its expansion. `%1` and `%2` are the matched operands. An
  expansion may be a record of sub-rules applied within it.
- `tests` is a list of `[source, expected]` pairs, scored against the rule set the program builds.

Rule order is precedence: the first matching pattern wins, so write specific patterns before
general ones and keep `"?": "%1"` last.

**Backslashes must be doubled** — `"\\times"`, not `"\times"`. A single backslash is read as an
escape and silently mangles the pattern. Comments are `/* ... */`; there is no line comment.
