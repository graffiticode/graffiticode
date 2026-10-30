# Interpreter C1: L0184 activation evidence (2026-10-30)

What promoted `api-rmvv585jc-1d4f7e`, the release that turned on L0184's interpreter
(`INTERPRETER_L0184=on`, `COMPILE_GENERATION_L0184=interp-1`; PR #221). The deploy receipt
(`.gc-deploy/releases/rmvv585jc-1d4f7e.json`, local) keeps only the evidence's hash; the
files are kept here.

| File | What it is |
|---|---|
| `promote-evidence.json` | The `--evidence` file given to `npm run deploy -- promote api --release rmvv585jc-1d4f7e`. Its canonical hash, `hash(canonicalJson(evidence))` as the deploy tool computes it, is `8e76d6c2c4fdcfc2bbcefb42448817aa71bdf8dd7fac6cf30db685eb9ae63718`, the receipt's `promotedWith.evidenceHash`. |
| `interpreted-gate-report.json` | `node scripts/lang-parity.js --lang 0184 --interpreted --rust https://l0184r-sja7fatcta-uc.a.run.app` against `l0184r-rmvv42fue-21907b`: 2864/2864 identical (674 value models, 82 plans), both modes. |
| `canary.mjs`, `canary-output.txt` | The canary run through the staged tag URL after staging: 11/11, each output compared with production's legacy path. |

**Reviewer.** The evidence's `reviewer` records that Claude Code ran the canary and promotion
under the owner's authorization ("do it"); it is not an independent human review.

**Also observed, not in the files:** the staged revision's `stage` log records showed L0184
interpreted in `present` at the head and `evaluate` below an L0000 head, stage-cache hits on
repeats, and compile errors never cached; after promotion, a production `/data` for an L0184
item logged `run: interpret` served by `l0184r-rmvv42fue-21907b`.

**Not established by this:** L0184's A6 (TypeScript source removal) gates. Build dependencies
on the TypeScript, a production soak and a demonstrated rollback to a compatible Rust revision
still need their own evidence.

Rollback: `npm run rollback -- api --env production --release rmvv585jc-1d4f7e` (restores
`rust-1` and the legacy path).
