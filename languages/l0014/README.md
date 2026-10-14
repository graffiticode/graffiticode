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

## Rust implementation

`crates/` holds L0014 in Rust: the language (`crates/core`), a client for the Node worker that
runs TransLaTeX (`crates/worker`), and a language server (`crates/server`, binary `l0014r`) on
the kernel in `languages/l0000/crates`. TransLaTeX itself stays JavaScript. The TypeScript in
`packages/` remains production.

```bash
cargo test            # the real-translator tests skip without Node or node_modules
npm run rust:build    # ./static, then the release binary (target/release/l0014r)
npm run rust:dev      # run it on :50014
```

See `CLAUDE.md` for the details.
