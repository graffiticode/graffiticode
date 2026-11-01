# Track A3: L0182 switch (2026-11-01)

Routes L0182 to `l0182r` (`BASE_URL_L0182`, `COMPILE_GENERATION_L0182=rust-1`). Gate: the
envelope-aware `scripts/lang-parity.js` against `l0182` and `l0182r-rmvyehmny-071f09`, with the
corpus regenerated from the current TypeScript (3,606 cases, unchanged): **3584 identical + 22
allowed** (`parity-gate-l0182.json`); lexicon, probes and form identical; no upstream data to
wrap.

The 22 allowed cases (18 `case` rules, some programs recur):
- **20 survey draws.** A fixture survey id (`civic-priorities`, `workplace-pulse`) draws one of
  its versions without replacement from memory each process holds (`drawn: Map<session,
  instance>`). Two services pick different versions by their own history; the items, options
  and instructions follow. Named versions (`civic-priorities-7`), which don't draw, are
  identical. Isolated by a run over the corpus without the draws: 3582 identical + the two below.
- **2 documented differences** (`diverges` in `crates/core/tests/conformance.rs`): a number too
  precise for a float (TypeScript's Decimal fields leak into the error) and an unresolved
  `get-val-public` (the kernel's checker refuses it; TypeScript refuses it later). Both refuse.

## Release notes (A3)

L0182's draws and session memory are process-local, so the switch is like any redeploy: a
session that drew a version on the TypeScript service and **hasn't answered yet** draws again on
`l0182r`. An answered session is unaffected: adding a response rewrites the program with the
literal drawn version (`languages/l0182/CLAUDE.md`, "`session-id` is what survives the answering
turn").

The staged canary (`canary.mjs`) samples programs no `case` rule covers, so a draw never stands
in for a compile.

Rollback: an api rollback to the release before this one (`l0182` stays deployed).
