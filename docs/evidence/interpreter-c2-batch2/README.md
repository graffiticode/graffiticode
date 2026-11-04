# C2 batch 2: L0003, L0010, L0014, L0177, L0178 and L0180 on the interpreter

Interpreter plan C2. These languages don't declare input independence, so every model is a plan the kernel evaluates against the stage's input.

**Live interpreted gate** (`node scripts/lang-parity.js --lang NNNN --interpreted --rust https://lNNNNr-sja7fatcta-uc.a.run.app`), run on 2026-11-04 against the deployed Rust services:

| Language | Identical | Different | Invalid | Skipped | Plans | Values |
|---|---|---|---|---|---|---|
| L0003 | 120 | 0 | 0 | 0 | 102 | 0 |
| L0010 | 70 | 0 | 0 | 0 | 36 | 0 |
| L0014 | 27 | 0 | 0 | 0 | 25 | 0 |
| L0177 | 99 | 0 | 0 | 0 | 95 | 0 |
| L0178 | 360 | 0 | 0 | 0 | 352 | 0 |
| L0180 | 2683 | 0 | 0 | 1 | 1610 | 0 |

- **Rust test:** `crates/core/tests/interpret.rs` in each language checks the same thing over the whole corpus, against each case's recorded data, against none, and against an upstream value and envelope.
- **L0014:** its test answers translations from each case's recorded results, as its conformance test does.
