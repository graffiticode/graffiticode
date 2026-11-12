# C6 part 2: L0176 on the interpreter, activation evidence

`docs/c6-l0176-reads-plan.md` §7 step 4. The api turns on `INTERPRETER_L0176` with `COMPILE_GENERATION_L0176=interp-1` together (deploy.json).

**Rollback**
- **Immediate:** `npm run rollback -- api --env production --release <the activation release>`. A rollback restores the traffic that preceded the release it names, so it must name the activation release itself; that restores `api-rmwdyh9de-00edf4`, the flag-off api. Naming `rmwdyh9de-00edf4` instead would restore the release before it, `api-rmwcqsbwn-8d1a9b`. After activation, verify the target with `--plan` (its `restoreTraffic`).
- **Forward:** branch `c6-part2-rollback` sets `INTERPRETER_L0176` explicitly to `"off"` (deleting a flag that is live is refused) with a fresh generation, `COMPILE_GENERATION_L0176=commands-2`, in an api release.

- `interpreted-gate-l0176.json`: `node scripts/lang-parity.js --lang 0176 --interpreted --rust https://l0176r-sja7fatcta-uc.a.run.app` against production `l0176r-rmwduyn6c-c054b7` (slices 1 and 2). It compares L0176 field by field: 202/202 identical, 566 metadata checks (every compile and present answer `cache: false`, no evaluate answer with `cache`), and 202 deterministic. Direct calls carry no gateway identity, so they are unsigned. The SDK's signed shapes are covered by `scripts/test/lang-parity.test.js`, and the staged canary signs for real.
- `canary.mjs`: the staged canary, run against the staged api's tag URL with production as the reference. Anonymous, with no connection. Each run builds content naming the run, so the lower stage's first read is a real miss. It checks:
  - `/form` names `@L0176=interp-1`, while production still names `commands-1`;
  - a read is signed and `no-store`, with a fresh signature, `user_id` and Broker `session_id` each read, and equals production apart from those fields;
  - MCP's summary (`data.request.questions`) matches production;
  - the lower stage's cache: L0000 `data {}` over L0176 answers exactly the L0176 stage's cached `evaluate` result, which has no `request`, `signing`, `session_id`, `signature`, `user_id` or `security` anywhere. Its first read is a miss stored as immutable, its second a hit (stage records);
  - L0176 over L0176: the lower stage is a hit every read, and the head is presented, `no-store`, signed afresh each read, and never a hit;
  - `/preview/sign` for questions and items: each a 200, signed and `no-store`, and the whole answer equal to production's apart from each signature's fresh fields (`maskSigned`: the flat questions packet; the items packet's `security` and request session). The staged revision's own routing records (`preview-sign {"run":"interpret",…}`, from `routes/preview.js`, read from that revision's log) show both went through the interpreter. l0176r's request log isn't used: production's commands call `/interpret` too (`operation: start`).
- The canary job against the tag URL (`--api-url`) covers connection reads, publication reads and the command save, which are unchanged.
- `promote-evidence.json`: for `npm run deploy -- promote api --release <id> --evidence …`.

## Activation, 2026-11-12

- **Staged** `api-rmwe179az-dc8f27` from `f7e19428`. A first `--stage` attempt failed locally (a DNS failure reaching Cloud Build) after its build had succeeded. It deployed nothing, and the second attempt built afresh.
- **Staged canary: 26/26** (`canary-output.txt`, run `d146e2e6`). It confirmed:
  - **The lower stage's cache:** a miss stored as immutable, then a hit. Its content (through an L0000 `data {}` head) had no signing or session metadata.
  - **L0176 over L0176:** the lower stage was a hit every read. The head was presented, `no-store`, never a hit, and signed with a fresh signature, `user_id` and Broker session each read.
  - **`/form`** names `@L0176=interp-1`.
  - **`/preview/sign`:** questions and items equal production's answers under `maskSigned`, and the staged revision's routing records show both interpreted.
- **Canary job via the tag: 36/36** (`canary-mxz6t`).
- **Promoted** with `promote-evidence.json`; the stale tag `rmwdyh9de-00edf4` was retired.
- **After promotion:**
  - `npm run rollback -- api --env production --release rmwe179az-dc8f27 --plan` → `restoreTraffic {"api-rmwdyh9de-00edf4": 100}`;
  - `release-check api`: ok;
  - production canary 36/36 (`canary-wfpd2`);
  - live `api.graffiticode.org`: `/form` names `@L0176=interp-1`, and `/data` under it is `no-store` and signed, with a fresh Broker session each read and no activity `session_id`.
