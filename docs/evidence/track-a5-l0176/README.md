# A5: L0176 switches to Rust (`l0176r`)

Interpreter plan A5 (`docs/graffiticode-interpreter-plan.md`); IAM review Step 18.

| Step | Evidence |
|---|---|
| 1. Parity port | #262 (`db3ad15d`): `init` validation, gateway-only system signing, busy results |
| 2. Policy and Broker trust `l0176r-run` | `policy-callers:6`, `broker-callers:2` (#265); `run.invoker` on both; `policy-rmw14q3w9-a953d6`, `broker-rmw153pw6-4af529` |
| 3. Pinnable `l0176r` | `l0176r-rmw15gmir-6bba5a`, then `l0176r-rmw18bcvb-0b20c8` with the lexicon fix (#270); approved for `0176`, `compilers-l0176`, release-check ok |
| 4. Parity gate | `parity-gate-2026-11-03.json`: 202 cases, 139 identical, 47 volatile, 14 error-presentation, 2 case; lexicon identical |
| 5. Staged api | `api-rmw18zdds-309a6c` (#271: `BASE_URL_L0176` → `l0176r`, `COMPILE_GENERATION_L0176=rust-1`) |
| 6. Connection canary through the tag | `canary-run2-staged.txt`: 27/27 |
| 7. TypeScript invocation replayed | `canary-run2-staged.txt`, "retry across a deploy": a run-1 write (`canary-run1-production.txt`, pinned `l0176-rmvv31tuj-fa4690`) replayed on that revision under the same plan |

Run 1 against production failed one check, the TypeScript compiler's own direct path. `l0176-run` had no canary-window grant, and A5 doesn't change that path. A no-connection `items` preview through the staged gateway came back signed (`no-store`), as it does through production.

`promote-evidence.json` is the `--evidence` file for `npm run deploy -- promote api --env production --release rmw18zdds-309a6c`.
