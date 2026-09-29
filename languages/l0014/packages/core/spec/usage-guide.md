# Using L0014

## Overview

L0014 authors TransLaTeX translation rule sets. It is an internal language: its output is compiler
input for `@graffiticode/translatex`, not anything a learner sees. A program declares a rule set —
word substitutions, named pattern types, and pattern-to-expansion rules — together with a corpus of
`[source, expected]` cases that are run against it at compile time, so a rule set validates itself
rather than merely serializing. Compiling emits `{options, tests}`: `options` is the object a
consumer passes to `TransLaTeX.buildTranslator`, and `tests` is each case scored 1 or -1. Rule
order is precedence, so specific patterns go before general ones and the catch-all goes last.
Backslashes in string literals must be doubled — a single backslash is read as an escape and
silently mangles the pattern.

## Writing a rule set

Start from the words, which are the simplest mapping, then the types the rules will reference, then
the rules themselves. Give every rule set a corpus, even a small one — an empty `expected` captures
current behaviour, which is enough to catch an unintended change later.

## Reading the output

A `-1` score is not necessarily a failure. When the corpus was written with empty expectations, a
`-1` just means the case has not been blessed yet; compare `actual` against what you meant and
paste it into `expected` once it is right.
