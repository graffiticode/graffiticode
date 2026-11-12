# C3: L0185 on the interpreter

Plan: `docs/c3-l0185-interpreter-plan.md`. L0185's models are all plans; fetching runs only at interpret, and a result that fetched is `shared` until 5 minutes after its earliest fetch.

## The interpreted gate (§6 step 5)

- **Fixtures:** `cargo test --workspace` in `languages/l0185` at `0a073d46`: every suite passes, including `tests/interpret.rs` over the 4,002-case corpus (both modes, and the restriction exactly when a case fetched).
- **Live** (`interpreted-gate-l0185.json`), run 2026-11-11 23:03–23:15Z against `l0185r-rmwcjrz90-673abb`:

  | Identical | Different | Invalid | Plans | Compared | Metadata checked | From fetching cases | Metadata problems |
  |---|---|---|---|---|---|---|---|
  | 4002 | 0 | 0 | 3980 | 4002 | 11962 | 9040 | 0 |

  The 22 cases with no model fail exactly as they compile. An earlier run (22:43Z) had one invalid answer: an `evaluate` request timed out once on case 3859, which answers in 0.3–0.5 s when re-run; the gate was run again in full rather than patched.
- **Caveat** (plan §6): about 3,000 cases fetch `example.org` paths that answer 404 live, so live they compare errors; real live fetches are the 16 `l0185.graffiticode.org/data` cases. The fixture test carries the rest.

## The staged canary (§6 step 6)

`node docs/evidence/interpreter-c3-l0185/canary.mjs <tag URL> <staged revision>` against the staged api, compared with production. About 7 minutes: it waits out one fetch's expiry.

**Deferred:** the L0185 → L0176 save (owner, 2026-11-11). `l0185r` isn't pinnable, so Policy refuses a command chain with an L0185 stage at admission (`stage-not-pinnable`), flag on or off. It's canaried once `l0185r` is pinnable.

## Promotion (2026-11-12)

- Staged `api-rmwcqsbwn-8d1a9b` (0% traffic): `canary.mjs` 23/23 (`canary-output.txt`; the first two runs' failures were in the script and are fixed: `canary-output-1.txt`); the production canary job through the tag, 33/33.
- Promoted with `promote-evidence.json`; production canary job `canary-wq4wn` 33/33; `release-check api` ok.
- Live through api.graffiticode.org: a fetching L0185 program under `@L0185=interp-1` is `public, max-age=299` with `refreshAt`; a program that fetches nothing is immutable; either without generations is `no-store`.
- Rollback: `npm run rollback -- api --env production --release rmwcqsbwn-8d1a9b` (to `rmwcov5os-ec3eb6`, flag off).
