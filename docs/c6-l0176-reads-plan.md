# C6 part 2: L0176 reads on the interpreter

**Status:** decisions approved by the owner 2026-11-12, decision 3 amended, with four implementation amendments (below). Slices 1 and 2 in progress. Plan item: `docs/graffiticode-interpreter-plan.md` Track C, item 6 ("interpretation of reads is part 2"); `docs/c6-l0176-commands-plan.md` "Out of scope". Design: `docs/graffiticode-interpreter-design.md` §5 (`get`: a narrowly scoped, repeatable signing action; compile emits unsigned models and the head's `get` signs) and the cache-class table. Template: `docs/c3-l0185-interpreter-plan.md`.

## 1. Where we start

**L0176 today** (Rust, `l0176r`, pinnable; `COMMANDS_L0176=on`, `COMPILE_GENERATION_L0176=commands-1`, `BRIDGE_L0176=off`):
- **Saves are commands** (C6 part 1, complete 2026-11-11): only `POST /command` writes, through `start`.
- **Every read is a legacy compile.** The api posts each L0176 stage to `l0176r`'s `/compile`, with `X-Caller-Identity` (`caller-identity.js`, `CALLER_IDENTITY_LANGS = ["0176"]`). `PROG` signs the activity through the system preview session (gateway-only), or `init` signs it explicitly. The answer is `cache: false`, the chain is `no-store`, and nothing is cached (`requiresProtected` forces `bypassCache`, `data.js:290`).
- **Signing happens at every stage, not only at the head.** In an L0176 → L0176 chain the lower stage's signed `request` is produced, forwarded and then dropped (`without_signing`). `data.js:567` logs every chain where a no-store stage feeds another; that log is the motivation in the plan ("Before L0176 is upgraded (plan C6) …").
- **Connection reads and publications** sign through `read.js` (READ-01): the stored, unsigned artifact is wrapped in a fixed sign program (`signProgram`, `read.js:18`) and compiled with `stage: "read"` (or `"view"`), so Policy's read snapshot allows the view-safe functions only (`policy.ts:823`).
- **`POST /preview/sign`** (`routes/preview.js`) compiles `init data {}` with the posted activity as input, as the api, without a connection. The L0176 Form calls it to sign or re-sign questions activities.

**What blocks interpretation as things stand** (survey, 2026-11-12):
1. **No `0176` declaration** in the interpreter manifest (v8), so `INTERPRETER_L0176=on` is ignored as undeclared (`interpret.js:31`).
2. **Every `/interpret` answer is `cache: false`.** `Dialect::cacheable()` is `false` for L0176 (`l0176/crates/core/src/lib.rs:159`), and the server stamps it on every envelope, evaluate included (`l0000/crates/server/src/lib.rs:385`). The api reads that as `no-store`, and refuses an interpreted `no-store` result that feeds another stage (`no-store-intermediate`, `data.js:504`). Turning the flag on today would break every chain with an L0176 stage below the head.
3. **The dialect can't see the mode.** `Compiler::interpret` passes `mode` to `Dialect::interpret`, but L0176 declines it, and the fallback `compile` drops `mode` (`compiler.rs:211-236`). `ExecContext` has no mode. So "sign only in `present`" needs a kernel change.
4. **Nothing is cached for L0176 even when interpreted.** `taskRequiresProtected` is always true for L0176 (`init` is implicit), and `interpretStage` skips the model cache and the stage cache for protected tasks (`data.js:418`, `:438`).
5. **Output that isn't a function of the program.** `session_id` on every activity, and every `questions` activity's `data.id`, are random UUIDs (`activities.rs:88`, `:240`); `questions` ignores `lrn-id` for `data.id` (it only names the questions' references), so 36 corpus cases with `lrn-id` set still differ on every compile. Broker already sets the signed request's own `session_id` (`pinnedPreview`, `packages/broker/src/operations.ts:261`), so the activity's copy is redundant. The dynamic-content reference is already a content digest (C6 part 1, decision 2).
6. **Parity.** `lang-parity --interpreted` applies no volatile masking (only the TS-vs-Rust comparison does), so L0176 fails it on UUIDs alone, and it requires `evaluate == present`, which is exactly what this changes. `lang-parity.allow.json`'s timestamped dynamic-content rule is stale.

**Already done (doc fixes in this PR):**
- `generation.ts` was retired on 2026-10-30 (`f2cf608c`, the shared View carries the generation). The interpreter plan and the C6 plan still list it as open.
- The content-digest dynamic-content reference shipped with C6 part 1.

**Consumers of a signed result** keep working if the head's answer keeps today's shape, `{ type, data, request?, signing? }` with `request` at the activity's top level:
- **The L0176 Form** renders `request`; it signs through `/preview/sign` only when there is none, or a questions activity's substitution changed or went stale. A connection-signed `items` activity can't be re-signed by the system consumer.
- **MCP** (`graffiticode-app/packages/mcp-server/src/item-content.ts:709`) reads `data.request.questions[]` for the item summary; without it, it falls through without crashing but loses the summary. The widget frames the Form.
- **The console** renders through the Form; no direct `data.request` reads.
- **The api's artifact checks** (`unsignedContent`, `carriesSignature`, `data.js:36-68`) strip `data.request` and refuse to store anything signed.

## 2. Decisions for the owner

Each has a recommendation; the plan below assumes it.

1. **Sign only at the head, in `present`.** `evaluate` returns the activity unsigned, with no `request` or `signing`; `present` signs exactly as today (system session, gateway-only, busy reasons). *Recommended.* It is the design's rule, removes the wasted signatures in L0176 → L0176 chains, and is what lets an evaluate result be cached.
2. **The cache classes.** A result whose evaluation *attempted* to sign (every `present`, signed or unsigned for a reason) is `no-store`; an `evaluate` result is `immutable`. Manifest caps for `0176`: `evaluate: "immutable"`, `present: "no-store"`. *Recommended.* An evaluate result is a function of the program and its input, with nothing private or expiring; a present result carries an expiring signature, or a transient refusal (busy) that must not be kept.
   - **The legacy contract is kept.** The api's legacy path treats only `cache === false` as no-store (`interpret.js:67`): any other value is permanent. So a no-store result is still written `cache: false`, on `/compile` and `/interpret` alike, never `cache: "no-store"`. *Amended:* **every** legacy `/compile` answer and every `present` answer is `cache: false`, errors and non-activity results included, decided per mode at the envelope, not by the dialect before it signs (an early return would miss it).
   - *Amended:* an `evaluate` result is immutable only as far as its input allows: a cached L0176 stage inherits its upstream's expiry (an L0185 fetch below it), exactly as C3's stage cache already enforces for any stage.
3. **Every activity id deterministic; no `session_id` in the activity.** *Amended by the owner.* An explicit activity id is kept (an `items` activity's `data.id` is its `lrn-id`, as today); a generated one (every `questions` activity's `data.id`) is `graffiticode-<16 hex>` of the activity's unsigned content, as the dynamic-content reference is. The activity carries no `session_id` in either mode: Broker sets the signed request's own, fresh per signature. So a cached result never hands two viewers one Learnosity session, and nothing in an activity changes from one compile to the next.
4. **`/preview/sign` interprets.** With the flag on, it runs `init data {}`'s model in `present` with the posted activity as input, instead of a legacy compile. Same request and answer, same limiter. *Recommended*, under the same flag, so every no-connection L0176 signature goes through one path.
5. **Connection reads and publications stay on `read.js`** (legacy compile with `stage: "read"` / `"view"`) in this part. Moving them to `/interpret` with the read stage's connection fields is a follow-up. *Recommended:* the kernel's `/interpret` already reads those fields, but the read path is security-sensitive (Policy's read snapshot) and works; this part's gain is the connection-free reads, which are almost all reads.
6. **L0158 → L0176 stays as today** (the `/form` redirect with the generation), not a declared producer → interpreter pair. *Recommended:* declaring `interprets: ["0158"]` is a separate step with its own parity corpus.
7. **A new generation: `COMPILE_GENERATION_L0176=interp-1`.** Legacy `compiles/` never held L0176 output (always `cache: false`), so this is for the View's `generations=` checks and rollback. *Recommended*, as C3.

## 3. The kernel (`languages/l0000/crates`)

- **The mode reaches the dialect.** `ExecContext` gains the stage's mode (`present` for `/compile` and a command's `start`, the request's mode for `/interpret`), readable as `exec.mode()`. `Compiler::interpret`'s fallback to `compile` passes it through. Additive: no other dialect reads it.
- **Cacheability per mode.** `Dialect::cacheable_in(mode)`, by default `cacheable()`. A `Compilation` records its mode, and the envelope is `cache: false` whenever `cacheable_in(mode)` is false, whatever the result: a value, a compile error, or anything else. *Amended:* this replaces restricting `NoStore` before signing, which an early return would miss.
- **The envelope is built in the kernel** (`Compiler::envelope`), the server adding only `revision`, so a language's tests check exactly what its server answers.
- **Tests:** `/interpret` in each mode reaches the dialect with that mode; a dialect not cacheable in `present` answers `cache: false` to `/compile` and `present`, errors included, and nothing to `evaluate`; a `Shared` restriction still yields C3's `cache: "shared"` + `expiresAt`.

The kernel change ships in every Rust language's next release; it changes nothing for a dialect that doesn't call `exec.mode()` or override `cacheable_in`.

## 4. L0176 (`languages/l0176/crates`)

- **`cacheable_in`: `evaluate` true, `present` false** (`cacheable()` stays false). Every `/compile` and `present` answer is `cache: false` exactly as today. A test runs the whole corpus, plus compile errors and non-activity programs, and asserts every `/compile` and `present` envelope carries `cache: false` and no `evaluate` envelope carries `cache` (the legacy contract).
- **`evaluate` doesn't sign.** In `evaluate`, `PROG` returns the activity without `request`, `signing` or `session_id`, and `init` returns its activity unsigned (it is the explicit sign word; in `evaluate` it validates and passes the activity through). `save-to-itembank` is unchanged: under `get` it is reported skipped, as a no-connection compile is today; saves run only as commands.
- **`session_id` and `data.id`.** Decision 3 (amended): no `session_id` in any activity; an explicit `data.id` kept; a generated one is the digest of the unsigned activity. Tests: the same program gives the same id on every compile, and a change to any question changes it.
- **Fixtures.** `tests/interpret.rs` over the conformance corpus: for every case, `evaluate` equals the `/compile` output with `request` and `signing` removed; `present` equals `/compile` with signature fields masked; the envelope assertions above. `tests/brokered.rs` adds the mode cases (no policy call in `evaluate`).
- **Conformance** (`tests/conformance.rs`), *amended*: field-specific comparisons instead of the UUID mask for these two fields. `data.id`: where the TypeScript's is a random UUID, the Rust one must be `graffiticode-<16 hex>`; otherwise equal. `data.session_id`: present in the TypeScript, absent in the Rust. Deliberate differences, listed.

## 5. The api

- **Manifest v9:** `0176: { interpreter: "interpreter", cacheCaps: { evaluate: "immutable", present: "no-store" } }` (no `interprets`, decision 6). `INTERPRETER_MANIFEST_VERSION = 9`.
- **Caching protected stages.** `interpretStage` skips the caches for protected tasks today. For a declared interpreter language it uses the stage's own restrictions instead: the model cache always (a model is unsigned and compile-time), the stage cache when the result's class allows it (an L0176 `evaluate` result), with its upstream's expiry inherited as C3 enforces. A `present` result is `no-store` and is never cached, as now. The chain-level `bypassCache` for `requiresProtected` stays (the whole-chain `compiles/` store is legacy-only).
- **`no-store-intermediate` stays.** With decision 1, an L0176 stage below the head is `evaluate` and immutable, so it never trips it; a test pins that.
- **`/preview/sign`** (decision 4): with `INTERPRETER_L0176` on, the model of `init data {}` (cached) is interpreted in `present` with the activity as input and the gateway identity; the answer mapping (`signResult`) is unchanged.
- **`read.js` unchanged** (decision 5); `isInterpreted` keeps excluding connection compiles.
- **Signing limit:** unchanged; it charges every L0176 stage of a no-connection `/data`, `/compile` or `/preview/sign`. With decision 1 only the head signs, so it could charge only the head; left as is (stricter) and noted.
- **Tests** (`interpret.spec.js`, `data.spec.js`, `preview.spec.js`): an L0176 → L0176 chain interpreted, the lower stage cached and unsigned, the head signed and `no-store`; a present answer without `cache: false` is refused; `/preview/sign` through the interpreter; flag off unchanged.

## 6. Parity, gate and soak

- **`lang-parity --interpreted` for `0176`**, *amended*: field-specific comparisons, not the UUID mask (which would not normalize a digest id or a removed `session_id`). Compare `evaluate` with `compile` minus `request`/`signing`, and `present` with `compile` with only the signature fields masked (`request.security.signature`, `.timestamp`, `.expires`, the request's Broker-set `session_id`). Against a baseline from before slice 2: `data.id` compared as in conformance, `data.session_id` expected gone. Drop the stale timestamped dynamic-content rule.
- **Determinism, asserted separately:** each case compiled twice gives the same generated ids; a case with one question changed gives a different one.
- **The gate:** `cargo test --workspace` in `languages/l0176`; live `lang-parity --interpreted --lang 0176` over the corpus against `l0176r`, all identical; metadata: `evaluate` never `cache`, `present` always `cache: false`.
- **Gateway identity in parity.** A direct call to `l0176r` has no gateway identity, so `present` answers `signing: { unsigned: "gateway-only" }` on both sides. Signed `present` is checked by the staged canary (§7), through the api.
- **Soak:** `interpret-soak` for `0176` against the `0000` baseline (C3 decision 8).

## 7. Release order, activation and rollback

1. **Kernel + `l0176r`** (one PR): released with the flag off. The legacy path is unchanged: `/compile` is `present`, answers `cache: false`, and signs as today. Check: canary 36/36; a legacy L0176 read is signed and `no-store`.
2. **Api** (manifest v9, protected-stage caching, `/preview/sign`): released flag off. Check: canary; `release-check api`.
3. **Interpreted gate** (§6).
4. **Activation PR:** `INTERPRETER_L0176=on`, `COMPILE_GENERATION_L0176=interp-1`; staged; a staged canary through the tag:
   - a no-connection L0176 read: signed `request`, `no-store`, the same activity as production modulo signatures;
   - an L0176 → L0176 chain: the lower stage interpreted unsigned and cached (stage records), the head signed;
   - `/preview/sign`: questions and items;
   - MCP's item summary from the head (`data.request.questions`);
   - a connection read and a publication read (unchanged path), and the command save (unchanged);
   - the View's `generations=` URL names `@L0176=interp-1`.
   Then promote with evidence, canary, `release-check api`.
5. **Rollback:** `INTERPRETER_L0176=off` with a fresh generation, `COMPILE_GENERATION_L0176=commands-2` (*amended*: not a reuse of `commands-1`), in a forward api release, or roll the api back to the release before activation. `l0176r` stays: its legacy contract is unchanged.

## 8. Slices

1. Kernel: mode on `ExecContext`, `cacheable_in(mode)`, the envelope in the kernel; tests.
2. L0176: present-only signing, `cacheable_in`, `session_id`/`data.id`, `tests/interpret.rs`, the corpus envelope test, fixtures. Released with slice 1 as `l0176r`, the flag off.
3. Api: manifest v9, protected-stage caching, `/preview/sign`, parity volatility in interpreted mode; tests. Released flag off.
4. Gate, staged activation, canary, promotion, evidence.

## 9. Out of scope

- **Follow-up:** connection reads and publications through `/interpret` (decision 5).
- **Follow-up:** the L0158 → L0176 producer → interpreter declaration (decision 6).
- Charging the signing limit for the head only.
- Track E and `dispatch`.

## 10. Risks

- **A signed result cached.** Mitigated three ways: `evaluate` never signs (dialect), every `/compile` and `present` envelope is `cache: false` whatever it holds (kernel, per mode), and the manifest caps `present` at `no-store` (api). A test asserts no `/compile` or `present` answer of the corpus, errors included, lacks `cache: false`.
- **Shared Learnosity sessions.** Decision 3 keeps `session_id` out of anything cached.
- **Consumers that read a lower stage's `request`.** None found: only the head's answer reaches the Form, MCP and the console; lower stages' `request` is dropped by `without_signing` today.
- **Items activities.** A connection-signed items activity can't be re-signed by the system consumer; unchanged here, because connection reads stay on `read.js`.
