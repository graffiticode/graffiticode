# Track A: L0186 switch evidence (2026-10-30)

`parity-gate-report.json`: `node scripts/lang-parity.js --lang 0186 --ts https://l0186-sja7fatcta-uc.a.run.app --rust https://l0186r-sja7fatcta-uc.a.run.app`
against `l0186r-rmvv7u6pg-830a8f`, with the corpus regenerated from the current TypeScript
(3,413 cases, unchanged). 3,413/3,413 identical, lexicon identical, probes and form OK; L0186
has no allowlist rules and documents no deliberate differences.

The FigJam plugin (`../figma-plugin`) calls only `api.graffiticode.org`, `auth` and `console`,
never `l0186` directly, so the api's routing covers it.

The switch PR sets `BASE_URL_L0186` to `l0186r` and `COMPILE_GENERATION_L0186=rust-1`; the api
is staged and canaried through its tag before promotion. No separate override soak (owner's
decision): the staged canary stands in for it.
