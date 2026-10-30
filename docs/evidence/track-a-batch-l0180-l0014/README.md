# Track A batch switch: L0180, L0014 (2026-10-30)

Released with L0175's interpreter activation (PR #229) in one api release. Gates, run with the
envelope-aware `scripts/lang-parity.js` against each live TypeScript service and its Rust
candidate, after regenerating each corpus from the current TypeScript (unchanged):

| Language | Rust | Raw corpus | As delivered (envelopes) |
|---|---|---|---|
| L0180 | `l0180r-rmvvhxwoe-d81e70` | 2680 identical + 2 `case` + 1 `upstream-envelope` | 1 identical + 6 `upstream-envelope` |
| L0014 | `l0014r-rmvvhxwkb-f45f63` | 27/27 identical | none (no upstream data in the corpus) |

L0180's two `case` rules are its documented undefined-in-a-list wording (TypeScript says
`undefined`, the kernel list holds `null`; `crates/core/tests/conformance.rs`, `diverges`), and
its `upstream-envelope` rule is the agreed P4 decision. L0014's corpus is small (27 cases), so
its staged canary also runs real public items (`canary.mjs --items items.json`) when given.
L0014's Rust image runs a Node worker for TransLaTeX: watch its cold starts after the switch.

Rollback: an api rollback to the release before this one (each TypeScript service stays
deployed); it also turns L0175's interpreter off.
