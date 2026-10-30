# Track A batch switch: L0174, L0175, L0183 (2026-10-30)

One api release switches all three to Rust (`BASE_URL_LNNNN` → `lNNNNr`,
`COMPILE_GENERATION_LNNNN=rust-1`). Gates, run with `scripts/lang-parity.js` against each live
TypeScript service and its Rust candidate, after regenerating each corpus from the current
TypeScript (unchanged):

| Language | Rust | Gate |
|---|---|---|
| L0174 | `l0174r-rmvvaflsb-6a3582` | 90/90 identical (`parity-gate-l0174.json`) |
| L0175 | `l0175r-rmvvafltm-803344` | 297 identical + 1 allowed case (`parity-gate-l0175.json`) |
| L0183 | `l0183r-rmvvaflzr-c2c976` | 1695 identical + 3 allowed cases (`parity-gate-l0183.json`) |

The allowed cases are each language's documented deliberate differences (its `CLAUDE.md`, each
pinned by a Rust test), as narrow `case` rules in `scripts/lang-parity.allow.json`: in every
one, Rust compiles a program TypeScript refuses, or words an error differently; no working item
changes. L0183 also keeps its `upstream-envelope` rule: a chain whose upstream data is a
`{data, errors}` envelope is unwrapped by the Rust kernel (no corpus case needed it).

L0174's corpus is small (90 cases). By the owner's decision its extra evidence is the staged
canary with real items (`canary.mjs --items`), not an extended corpus.

Rollback: an api rollback to the release before this one (each TypeScript service stays
deployed).
