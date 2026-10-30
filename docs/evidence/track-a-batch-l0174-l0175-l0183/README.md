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
canary with real items (`canary.mjs --items items.json`), not an extended corpus: two public
L0174 items the owner chose (a third was private, so an anonymous canary can't load it).

Rollback: an api rollback to the release before this one (each TypeScript service stays
deployed).

## The L0174 envelope finding (2026-10-30)

The first staged canary failed L0174's `/compile` over data: through the api, a stage's input
is the `{data, errors}` envelope of the stage below it (here, the data task `POST /compile`
appends). TypeScript L0174 spreads that envelope raw, so the compiled form gains `data` and
`errors` keys and the posted values never reach the top level; Rust unwraps it (the kernel's
upstream-envelope behavior), laying the posted state over the form, which is what
`languages/l0174/CLAUDE.md` describes and what the Form reads (`state.data.values`, `title`,
`theme`). A real item recompiled with `{values: {name: "Ada Lovelace"}}` returned
`values` nested under `data` in production and at the top level from the staged Rust.

Owner's decision: accept it (an `upstream-envelope` rule for 0174; it affects every L0174
compile over data, View recompiles included) and improve the gate: every case with upstream
data is now also sent wrapped as the api delivers it. Re-run gates (these reports):

| Language | Raw corpus | As delivered (envelopes) |
|---|---|---|
| L0174 | 90/90 identical | 13 identical + 32 allowed (`upstream-envelope`) |
| L0175 | 297 identical + 1 case | none (no upstream data in the corpus) |
| L0183 | 1695 identical + 3 cases | 22/22 identical |
| L0184 (already switched) | 2864/2864 | 68/68 identical (`docs/evidence/track-a-l0184/`) |

The canary (`canary-output.txt`) applies the same rule: for a language with
`upstream-envelope`, Rust's answer must equal production's with the envelope unwrapped. 25/25
through `api-rmvveu4s3-8566c4`.
