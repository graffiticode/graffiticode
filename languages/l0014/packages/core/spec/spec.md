# L0014 (Internal)

A language for writing TransLaTeX translators — a port of L120 onto the L0000 framework.

A program declares a translation rule set and a corpus that validates it.

```
words { "\\alpha": "\\alpha" }
types { "signedExpr": ["-?", "+?"] }
rules { "?+?": "%1 + %2", "?": "%1" }
tests [["1+2", "1 + 2"]]
..
```

## Statements

Four statements, in any order. A repeated statement wins.

| Statement | Argument | Meaning |
| :-------- | :------- | :------ |
| `words` | record | Maps a LaTeX token to its replacement. |
| `types` | record | Names a reusable class of patterns, referenced as `\type{name}`. |
| `rules` | record | Maps a source pattern to its expansion. |
| `tests` | list | `[source, expected]` pairs, run against the rule set. |

## Parser options

Passed through to TransLaTeX untouched.

| Word | Argument |
| :--- | :------- |
| `allow-thousands-separator` | boolean |
| `set-decimal-separator` | string |
| `set-thousands-separator` | string |
| `allow-interval` | boolean |
| `ignore-text` | boolean |
| `ignore-coefficient-one` | boolean |

## Expansions

A rule's expansion is a string, or a record of sub-rules applied within it. Here the
record maps the expansion `"\\lim_{%1}{%2}"` to rules that translate that expansion's operands:

```
rules {
  "\\lim_? ?": {
    "\\lim_{%1}{%2}": {
      "? \\rightarrow ?": "%1 \\to %2"
    }
  },
  "?+?": "%1 + %2",
  "? \\rightarrow ?": "%1 \\rightarrow %2",
  "?": "%1"
}
tests [
  ["\\lim_{x\\rightarrow0}x+1", "\\lim_{x \\to 0}{x} + 1"],
  ["x\\rightarrow0", "x \\rightarrow 0"]
]
..
```

The sub-rules apply only inside the limit. The first test shows `\rightarrow` becoming `\to`
under the limit. The second shows it left as `\rightarrow` everywhere else. Sub-rules take
precedence in the order they are written, just as top-level rules do.

`%1`, `%2` are the matched operands; `%*` repeats over a sequence.

## Output

Compiling emits `{options, tests}`.

`options` is `{data, words, types, rules, ...}` — the rule set a consumer hands to
`TransLaTeX.buildTranslator`. `data` is always an empty record.

`tests` is one record per case: `{score, source, actual, expected}`, where `score` is `1` when the
translation matched and `-1` when it did not. An empty `expected` captures what the rule set does
today rather than asserting anything.

## Escaping

**Backslashes must be doubled.** The parser reads `"\times"` as a tab followed by `imes`, and
`"\nless"` as a newline followed by `less` — silently. Write `"\\times"`.

Comments are `/* ... */`. There is no line comment.
