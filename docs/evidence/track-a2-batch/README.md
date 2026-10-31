# Track A2 batch switch (2026-10-30)

One api release switches seven languages to Rust (`BASE_URL_LNNNN` → `lNNNNr`,
`COMPILE_GENERATION_LNNNN=rust-1`). Gates: the envelope-aware `scripts/lang-parity.js` against
each live TypeScript service and its Rust candidate, after regenerating each corpus from the
current TypeScript (all unchanged). Released from `main` at `ae909565` (worktree), every
`lNNNNr` on its `rmvvkq…` release.

| Language | Raw corpus | As delivered (envelopes) |
|---|---|---|
| L0003 | 114 identical + 6 `error-text` | 26 identical + 54 `upstream-envelope` |
| L0010 | 66 identical + 4 `case` | 33 identical + 2 `case` |
| L0177 | 98 identical + 1 `case` | none |
| L0178 | 359 identical + 1 `case` | none |
| L0179 | 1086 identical + 11 `upstream-envelope` | 143 `upstream-envelope` |
| L0181 | 452 identical + 3 `case` + 4 `upstream-envelope` | 33 identical + 44 `upstream-envelope` |
| L0185 | 3997 identical + 4 `error-text` + 1 `case` | none |

New rules (each with its note in `scripts/lang-parity.allow.json`):
- **Documented deliberate differences**, narrow `case` rules: L0177 and L0178 keep a field given
  an undefined value as `null` (TypeScript drops the key); L0181's exact number (TypeScript leaks
  decimal.js internals), reworded ADD error and once-reported mapped error.
- **Error presentation**, `case` rules: L0185's `format-number` error and L0010's `plan "0158"`
  error at their real positions.
- **Owner's decisions (2026-10-30):** L0003 `upstream-envelope` (Rust lays the posted state over
  the result, as its CLAUDE.md says; TypeScript spreads the raw envelope), as for L0174; L0010's
  `plan 158` is now refused (TypeScript accepted a number and returned an empty plan; documented
  as deliberate in its conformance test). This is the one program that compiled before and is
  now refused.

Transient answers during the runs (re-run clean): a TypeScript 401 on L0185 (token expiry), a
502 in front of `l0177r` with nothing logged by the service (cold start, min 0).

L0003, L0010 and L0177 have small corpora (70–120 cases). By the owner's decision the switch
doesn't wait for real items; the staged canary runs each language's corpus checks.

Rollback: an api rollback to the release before this one (each TypeScript service stays deployed).
