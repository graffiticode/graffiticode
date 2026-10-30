# Graffiticode Interpreter Pass: Implementation Plan

**Status:** Approved plan  
**Date:** 2026-10-28  
**Design:** [graffiticode-interpreter-design.md](graffiticode-interpreter-design.md)

## Context
`docs/graffiticode-interpreter-design.md` is the architecture; this document is its execution plan. Every release point in it is backward compatible.

**Each language switches to Rust first, and is upgraded to the interpreter later.** For each language there are two separate releases:
- **Track A:** switch production to its Rust service with today's semantics unchanged;
- **Track C:** later, upgrade that language to the interpreter model, in Rust.

Reasons:
- **Parity can be verified.** A switch changes the implementation, not the behavior, so the same `/compile` request can be compared on TypeScript and Rust. If the port and the semantic change happened together, there would be nothing to compare against.
- **Each release has one rollback.** A switch is rolled back by a routing change, and an upgrade by per-language flags plus a generation change.
- **The switch doesn't wait for `/interpret`.** Several languages are nearly ready to switch now.
- **One code path serves three kinds of language.** About 20 production languages live outside this repo (L0002, L0158, L0166, L0170, …) and have no Rust implementation, so they keep today's `/compile` protocol permanently. The API's legacy adapter is therefore a permanent stage kind: it serves those languages, switched-but-not-yet-upgraded Rust languages, and unswitched Node languages alike.

## Invariants for every release point
- **Response shapes don't change:**
  - the outer `{status, data}` from `/data` and `/compile`;
  - the inner `{data, errors}`, with bare values still tolerated;
  - L0176's signed preview in the head's `data.request`.

  Every consumer unwraps these itself: the shared View (`languages/l0000/packages/view/src/view.tsx:144`), the ChatGPT widget, MCP `item-content.ts`, and the console `api.ts`. New metadata is additive and optional.
- **A stage's input doesn't change for a language until that language's own upgrade (Track C).** About 6 compilers read `options.data` directly, and L0000's `DATA` merges it.
- **Stored artifacts and publications stay readable.** The registry must not be bumped until artifact compatibility can be declared (step P1), and a bump follows the rollout protocol in P1.
- **TypeScript `lNNNN` services keep running after a switch.** A switch only changes where the API routes. Removing a language's TypeScript source (A6) never touches its deployed service; retiring the service (A7) is a separate, explicit decision per language. The language itself is never retired: its items keep compiling, on Rust.
- **Execution behavior doesn't change for existing callers.** Anything that triggers an effect today through `/compile` (L0176 `save-to-itembank`, L0013 `snap`) keeps doing so until its callers have migrated to explicit commands (Track D). Keeping the envelope the same is not enough.
- **No chain that works today is newly refused** until a step that names the affected chains and migrates them first.
- **Every release names its rollback**, which is either an API rollback (`npm run deploy -- rollback --release <id>`) or a service rollback.

## Track P — Platform prerequisites (no behavior change)
- **P1 Artifact compatibility before any registry bump.**
  - Add a declared compatible set for registry versions, with the default *incompatible*. Readers accept an artifact whose version is in the current version's compatible set:
    - `packages/common/src/protected-registry.ts` (`REGISTRY_VERSION`);
    - `packages/api/src/storage/artifacts.js:68`;
    - `packages/api/src/read.js:58,120`.
  - Ship it without a bump: behavior is unchanged.
- **P1b A registry bump is a rollout across services, not a source edit.**
  - **Why a bump isn't atomic.** A version number reaches every service, but the services are deployed separately:
    - Policy refuses compiler manifests from another version (`registry-version-mismatch`, `packages/policy/src/policy.ts:775`).
    - Tokens carry `rv`.
    - Broker receipts keep the version they were written under (`receipt-registry-version-mismatch`, `packages/broker/src/broker.ts:432`).
    - Admitted plans pin compiler revisions that report the old version.

    Changing the three constants together (registry, `languages/l0176/packages/core/src/compiler.ts:559`, `languages/l0176/crates/core/src/protection.rs:27`) doesn't change deployed or pinned revisions together.
  - **Protocol: expand, then contract.**
    1. **Expand.** Policy and Broker accept a *window* `{N, N+1}`: admission accepts manifests and tokens of either version, and the receipt check treats both as compatible. Deploy Policy, then Broker. Nothing has changed version yet.
    2. **Compilers.** Deploy compilers reporting `N+1`. Pinned revisions reporting `N` stay admissible inside the window, so in-flight and admitted invocations finish.
    3. **API.** Deploy the API with `N+1`, with P1's compatible set naming `N` if the bump is artifact-compatible.
    4. **Contract.** After the longest token lifetime (invocation tokens, 30 min) plus the oldest admitted plan still in use, Policy and Broker drop `N` from admission.
       - Receipts written under `N` stay *readable for replay* indefinitely: a retry returns its recorded outcome.
       - A *new* execution under `N` is refused.
  - **A plan keeps the version it was admitted under.**
    - Accepting two versions is not enough on its own. Admission stamps the *current* global `REGISTRY_VERSION` into the plan, and the plan's digest covers it (`packages/policy/src/policy.ts:782-790`). An `N` invocation retried after the expand would therefore be re-admitted as `N+1` and refused as `plan-binding-mismatch`.
    - So a plan's version becomes **its own, not the global one**:
      - **Admission.** A new invocation is admitted under the current version. A retry of an existing invocation reuses its stored plan, version included, and never recomputes it under the current version.
      - **Session and execution tokens.** Their `rv` is the plan's version.
      - **Broker.** It compares a receipt's version with the token's `rv`, which is the plan's, never with the global version.
    - **The two versions are never interchangeable.** The version is part of the receipt binding. An `N` token matches only `N` receipts and an `N+1` token only `N+1` receipts, so an `N+1` execution can never replay or overwrite an `N` receipt, or the reverse.
  - **Replay after contract** *(implemented)*. Once `N` is dropped, Policy mints no new session or execution tokens for `N` plans, so nothing new executes under `N`. A retry of an `N` invocation still needs its recorded outcome:
    - Policy issues a **replay-only** token for that invocation's plan.
    - The broker accepts it only to return a recorded receipt. It refuses with no provider call when no receipt exists.
    - Replay-only tokens get their own `typ`, so they can never authorize a step.
    - As built: a retry's admission is re-issued for its stored plan; the snapshot gives a replay-only session (`rpl`) holding only write functions; its mints are `gc-replay+jwt` tokens; Policy authorizes them only for the `receipt` replay step; Broker returns an existing receipt for them (read with `getClaim`, never claimed) and refuses `replay-not-found` otherwise, with no provider call.
    - Limits: such a retry's other effects aren't replayed. An L0176 compile's preview signing is refused (`replay-only`), so the retry returns the save's recorded outcome alongside a signing error. Replay also needs the plan's pinned compiler revisions still approved.
  - **Rollback.** Before contract, roll back compilers and API; Policy and Broker still accept `N`. After contract, rollback is a new expand step.
  - **Tests:**
    - An `N` invocation admitted before expand and retried after it replays.
    - An `N` invocation retried after contract gets its recorded outcome through a replay-only token, and nothing executes.
    - Bindings across versions are refused.
  - Add a check that fails the build when the three constants disagree.
- **P1c Interpreter declarations are versioned separately.**
  - The interpreter declarations (B2) go in their own manifest with their own version (`INTERPRETER_MANIFEST_VERSION`), next to the protected registry but not part of `REGISTRY_VERSION`.
  - Adding or flipping a declaration therefore touches no token, receipt, admission or artifact check.
  - `REGISTRY_VERSION` changes only when protected functions themselves change (C6), and then follows P1b.
- **P2 Per-language routing switch with a cache namespace.**
  - Generalize `packages/api/src/generation.js` from L0158 only to any language, for example env `COMPILE_GENERATION_LNNNN`, read per request.
  - Key `compiles/` by `id@gen` when a generation is set. For a chain, the key includes the generation of *every* language in it.
  - The switch is then `BASE_URL_LNNNN` plus `COMPILE_GENERATION_LNNNN` in the `api` env (`deploy.json` api entry ~86-105), released by `npm run deploy -- api`.
  - With nothing set, it's inert. Rollback is an API rollback.
  - Keep the L0158 behavior identical: its `form.js` View swap stays.
- **P3 A repeatable live parity gate.**
  - Turn the egress-proxy replay (`deploy/egress-proxy/step3/exercise.js`, which records `outputDigest`) into `scripts/lang-parity.js`.
  - It replays each language's `crates/core/tests/conformance` corpus against the live TypeScript service and the `lNNNNr` candidate, and compares the full response (status, envelope, errors).
  - It also checks `/form`, `/assets` and `/lexicon` headers and bodies.
  - A per-language allowlist records the accepted differences each `CLAUDE.md` documents. The gate's output is the `--evidence` file for `promote`.
  - Regenerate the `cases.json` fixtures from current TypeScript first, because some are stale (L0176's predate `init`).
- **P4 Shared Rust server parity fixes** (`languages/l0000/crates/server/src/lib.rs`):
  - per-language `/form` no-store or no-cache and `/assets` immutable headers *(done: `HttpCaching` and `serve_with` in the shared server; L0180 `/form` no-cache, L0182–L0186 `/form` no-store, and all six with immutable `/assets`. The first live parity run (L0184, 2026-10-29) then found Express's own defaults on static files: every file the TypeScript servers serve (the form, the lexicon, public files) has `Cache-Control: public, max-age=0` unless set otherwise, and `charset=UTF-8` on text types; the shared server now adds the same)*;
  - HTTPS-redirect behavior that matches TypeScript *(no change needed: every production TypeScript image sets `NODE_ENV=production`, so both redirect plain HTTP behind the proxy identically)*;
  - the upstream-envelope behavior in chains (l0179/l0180/l0181/l0183 differ today). *Decision (2026-10-28): keep the Rust kernel's unwrapping rather than copy the TypeScript's raw spread of the envelope.* It is an allowed difference in the parity gate (`upstream-envelope`, scripts/lang-parity.allow.json), so this is the one place where a language's input does change at its switch. Each of the four languages' switch release notes must list the production chains in which it sits downstream of another stage, since those chains' results change.

  Redeploying the `lNNNNr` services is safe: nothing routes to them.
- **P5 Tester soak.** Use the existing `lang-overrides/{uid}` Firestore bindings to point the canary and test accounts at `lNNNNr`. This only covers paths that don't go through a connection (connection paths refuse overrides).

## Track A — Switch each language to Rust, with today's semantics
For each language, one API release:
1. Close or allowlist its documented differences.
2. The P3 gate passes.
3. The P5 soak passes.
4. Set `BASE_URL_LNNNN` and `COMPILE_GENERATION_LNNNN` and release the API.

Rollback is an API rollback. The TypeScript service stays deployed.

**Order, by readiness** (from the Oct 19–21 exercise digests and the CLAUDE.md files):
1. **A1** l0174, l0184, l0186, l0183, l0180, l0014. Their digests were identical; they need P4's headers.
   - **A1b l0013, separately.** Its identical digests prove little: its conformance tests deliberately exclude a successful `snap`, and no test touches real storage or a real item (`languages/l0013/CLAUDE.md:149`, `:160`). So promotion also needs **capture evidence**:
     - `l0013r` configured with an **isolated bucket** through `THUMBNAIL_BUCKET`, the variable the Rust capture reads (`languages/l0013/crates/capture/src/lib.rs:81`). It defaults to the production bucket `graffiticode.appspot.com`.
       - First make `l0013r` **fail closed**: refuse to capture when `THUMBNAIL_BUCKET` is unset.
       - Report the effective bucket on `/egress` (or a health field). The evidence run checks that it is the isolated bucket before the first capture, and aborts otherwise.
       - Only the production switch sets it to the production bucket, explicitly.
       - This way no evidence run can overwrite production `thumbnails/{item}.png`.
     - successful captures of real items through authenticated rendering, with the verify account's token reaching the app;
     - upload permission checked for `l0013r-run` on the isolated bucket and, before the switch, on the production bucket;
     - defined image tolerances against the TypeScript capture of the same items: equal output dimensions and crop box, and a perceptual-difference threshold (pixels are not byte-identical, `CLAUDE.md:143`).

     The evidence goes into the `promote --evidence` file.
2. **A2** l0003, l0010, l0175, l0177, l0178, l0179, l0181, l0185. Small known differences, each closed or allowlisted. For L0003 and L0010, the lexicon served by Rust is a superset; allowlist that, or pin it.
3. **A3** l0182. Its per-process session memory is lost on a switch, the same as on any redeploy, so state that in its release notes.
4. **A4** l0000. Needs `pinnable`, `POLICY_URL` and `PREFLIGHT_GATEWAYS` for `l0000r`, and admitted-plan stages and `/preflight` must work there. IAM review entry: `docs/capability-policy-iam-review.md`, Step 15. The order:
   1. **Configure** (one PR): `l0000r`'s `deploy.json` entry like `l0000`'s; the parity allowlist's `case` rules for L0000's six documented divergences; the docs.
   2. **Policy trusts `l0000r-run`:** a new `policy-callers` version (validated with `parseCallers`), `run.invoker` on `policy`, `deploy.json`'s `policy` pinned to the version Secret Manager returns, `policy` released.
   3. **Release `l0000r`** as a pinnable service (its approval is recorded before promotion). Then remove the old, never-approved serving revision's tag, after checking that no approved revision or admitted plan needs it.
   4. **Parity gate** for L0000, with only the narrow `case` rules and `error-text`.
   5. **Stage an API revision** (`npm run deploy -- api --stage`) with `BASE_URL_L0000` and a new `COMPILE_GENERATION_L0000`. It gets a tag URL and no traffic.
   6. **Run the connection canary through the staged API's tag URL.** Verify full admission and execution, with L0000 as the appended data stage, not just `/preflight`.
   7. **Retry an existing TypeScript invocation** through the staged API, and verify it replays through its pinned `l0000` revision.
   8. **Promote the staged API** (`npm run deploy -- promote api --release <id> --evidence <file>`) only after 4, 6 and 7 pass.
5. **A5** l0176, last.
   - Port the parity gaps: `init` validation, and gateway-only signing with the busy results.
   - Make `l0176r` pinnable with approvals.
   - Set `POLICY_URL` and `BROKER_URL`, have Policy accept `l0176r-run`, and move it to the `compilers-l0176` egress subnet.
   - Run the canary through a connection before switching.

### Retiring the TypeScript implementation (per language, after its switch)
Retirement is its own milestone for each language, after its Track A switch. It needn't wait for that language's Track C upgrade. It has two steps with separate decisions: **A6** removes the TypeScript compiler and server source from `main`; **A7** retires the deployed TypeScript service. Removing source never requires deleting a service.

- **A6 Remove a language's TypeScript compiler and server source.** Allowed only when all five hold, each recorded in the language's `CLAUDE.md` with its evidence:
  1. **Accepted behavioral parity.** The live parity gate passes for compilation, errors, authorization, mixed chains, lexicons, forms and assets. Every deliberate difference is documented and tested. A language with protected functions also has its real protected paths exercised (admitted plans, preflight, broker operations), not only previews.
  2. **Production confidence.** Rust has passed the applicable soak and canaries, including cold starts and the language's uncommon operations. A low-traffic language needs targeted exercises: elapsed time alone isn't evidence.
  3. **A tested recovery path that doesn't rebuild TypeScript.**
     - Known-good images and release receipts are retained.
     - A rollback to a compatible Rust revision has been demonstrated.
     - Any exact TypeScript revision still needed is preserved: by pinned (admitted) plans, by direct callers, or by a supported rollback procedure. For L0000, admitted plans pinned to `l0000` revisions replay through them.
  4. **No remaining dependency on the TypeScript implementation.** Rust builds, static-asset generation, vocabulary generation, CI, package consumers and deployment scripts all work without it. Known dependencies to remove first:
     - **Static assets.** Each Rust language's `tools/assemble-static.mjs` builds the TypeScript core (`npm run -w packages/core build` and `build-static`; e.g. `languages/l0184/tools/assemble-static.mjs:24`). The static outputs (lexicon, schema, spec, instructions, language info) need a source of their own: spec files and a generator that doesn't import the compiler.
     - **Generated Rust data.** Vocabulary generators and conformance generators import TypeScript exports (e.g. `languages/l0182/crates/core/tests/conformance/generate.mjs:44`, L0184's `vocab.json` and `lexicon-additions.json` from `attributes.ts`). Their outputs become checked-in sources edited directly, or generated from data that isn't TypeScript code.
     - **The shared-package rollout.** `scripts/lib/upgrade-and-deploy.js:118` deploys `lNNNN`, the TypeScript service. For a switched language it must deploy the service the API routes it to (`lNNNNr`). This is already true for L0184 and L0000, whose View 0.5.0 rollout needed hand deploys of `l0184r` and `l0000r`.
     - **L0000 is separate.** `@graffiticode/l0000` (the TypeScript kernel) is consumed from npm by the other TypeScript languages, and `@graffiticode/l0000-view` by every language. L0000's TypeScript compiler is removed only after every consumer has its own A6, and its View stays.
  5. **Regression coverage survives deletion.**
     - The last trusted TypeScript corpus, its expected outputs, the accepted differences and their provenance (commit, date, generator) are preserved in the repository.
     - Rust keeps being tested against those fixtures.
     - Expected results are never regenerated from Rust and called parity. A later language change updates the fixture by hand, with review, as a change to the language.

  **Kept:** the TypeScript View, browser components and shared assets wherever Rust still uses them (every language's `/form` is the TypeScript View).
  **The final check is the deletion PR itself:** it builds, tests and releases the Rust language from a clean checkout with the TypeScript compiler and server absent.
  **Rollback:** a source revert. The deployed services and images are unchanged by A6.

- **A7 Retire the deployed TypeScript service.** A separate decision per language, made explicitly by the owner, after A6. Never part of A6, and never implied by it. Before retiring:
  - nothing routes to it: no API `BASE_URL`, no override, no domain mapping or DNS record (`lNNNN.graffiticode.org` repointed to the Rust service first), and no client that calls it directly, by logs over an agreed period;
  - no admitted plan, receipt replay or supported rollback procedure names one of its revisions;
  - its last images and receipts stay retained, so it could be redeployed.

  Until that decision, the service stays deployed (at `min 0`), as every switched language's does today.

## Track B — Interpreter platform (a no-op until a language opts in)
- **B1 Rust contract** *(done: `crates/core/src/model.rs`, `Compiler::model`/`interpret`, `/interpret` and `"form": "model"` in the shared server; documented in `languages/l0000/CLAUDE.md`. A plan model carries the stored source, so interpreting it equals today's compile, checked over the whole L0000 conformance corpus. `Dialect::input_independent` decides value models and defaults to never)*.
  - Add `/interpret` to the shared `app()`.
  - Add `Dialect::interpret` (identity for value models, the kernel evaluator for plans) and `Dialect::materialize`.
  - `/compile` keeps today's behavior. The model form is produced only when the request asks for it, for example `{"form":"model"}`.
  - Every `lNNNNr` service inherits this on redeploy, and nothing calls it.
- **B2 Interpreter declarations** in their own manifest (P1c), not the protected registry.
  - Add an interpreter declaration per language: compile-only (the default), interpreter, per-mode `cache` caps, producer → interpreter pairs.
  - This needs no `REGISTRY_VERSION` bump, so tokens, receipts, admission and artifacts are untouched.
  - No language is declared yet, so nothing changes.
- **B3 API orchestration.**
  - Compile each task on its own and interpret right to left, with stage ids from chain position (`s0` is the head).
  - Set the `evaluate` or `present` mode.
  - Keep a stage cache keyed by model, input, interpreter version, mode and authority. A stage's result is combined with its input's restrictions before it is stored and on every cache hit.
  - Languages without a declaration go through the **legacy adapter**, which is today's `/compile` call. While nothing is declared, every chain behaves exactly as today.
  - **The design's mixed-chain refusal is scoped, not global.** A `no-store` stage feeding a downstream stage is refused (design §5 rule 2, and §12's "legacy L0176 below the head").
    - That refusal applies **only to declared (upgraded) stages**.
    - A legacy-adapter stage forwards its output downstream exactly as today, including L0176's signed output in chains such as `L0176→L0176`, which the canary inventory shows (`docs/capability-policy-as-built.md:760-768`).
    - Its `no-store` class still keeps the result out of every cache.
    - The refusal can only start to matter at C6. There, L0176 in `evaluate` mode is unsigned, so the rule is met without refusing anything.
    - Before C6 ships, the API logs every chain in which a `no-store` stage feeds another stage, to confirm that none relies on a signed intermediate.
    - Amend the design doc's §12 legacy-adapter bullet to say this.
  - Test it with a declared fake language. Code: `packages/api/src/data.js` (`getData`), `comp.js`, `routes/data.js`, `routes/compile.js`.
  - **As built (2026-10-29).** `packages/api/src/interpret.js`, `data.js`, `comp.js` (`buildInterpreter`), `storage/stage-results.js`; tests in `interpret.spec.js` with declared fake languages.
    - Activation: declared `interpreter` in the manifest **and** `INTERPRETER_LNNNN=on`, read per request. No per-user activation: the first real-language canary is a staged API revision (Track C).
    - Through a connection, every stage stays legacy (commands are B5/C5/C6). Connection and publication reads return before any stage runs, unchanged.
    - Legacy stages keep their call order and receive the exact upstream envelope. The API strips `cache`, `expiresAt`, `revision` and `responseLost` from an interpreted stage's answer before anything downstream or the client sees it.
    - Restrictions: a legacy stage is `no-store` on `cache: false`, else `immutable`. An interpreted stage takes the class it names (none is `immutable`, `false` is `no-store`, an unknown one is `no-store`), capped by the manifest for its mode, and its `expiresAt`. Each stage's result takes the stricter class and the earlier expiry of its input and itself, on a fresh result and on a cache hit alike. The manifest's current caps (interpreter's and producer's) are reapplied on every hit, and an entry they no longer let be shared is a miss.
    - The scoped refusal: a declared stage whose result is `no-store` and carries data never feeds another stage. The chain stops there with `no-store-intermediate`, and nothing downstream runs. At the head it is presented, uncached. Legacy stages forward as today.
    - A chain with an interpreted stage never reads or writes the whole-chain `compiles/` store, and is answered `no-store` until B4 puts the generation in the URL.
    - Stage cache key: language, interpreter language, model digest (language, kind, contents), interpreter revision (reported by the Rust server on the model and `/interpret` responses), options digest, generations, mode, authority (`anonymous` or the caller's uid) and the input's canonical digest. Looked up and written only when the input is `immutable` or `shared` and unexpired; written only when the result, combined with its input's restrictions, is too (and stored with that combined class and expiry, so no entry outlives or outshares its input), has no errors, and was interpreted by the revision the key names. Never for an override or a protected task. `refresh` skips the lookup and writes.
    - Every chain where a legacy `no-store` stage feeds another stage is logged (the C6 inventory).

- **B4 Shared View.**
  - Carry the generation from `?url=` onto `/data` and `POST /compile`, and into the SWR keys.
  - Read optional refresh metadata; when it is absent, behave as today.
  - Publish `@graffiticode/l0000-view` and roll it out with `npm run upgrade-l0000-view-and-deploy`.
  - Then retire L0176's `generation.ts` middleware.
  - **As built (2026-10-29, view 0.5.0, not yet published).** `/form` adds `generations=<languageGenerationSuffix>` to the data URL; the View reads `generation` and `generations` from `?url=` (only a `/data` URL for the same id) and adds them to its `/data` load and SWR key. `/data` accepts `generations`: a URL naming generations that aren't the chain's current ones is `no-store` on every path (legacy chains and cache hits too, since the same URL may later name another namespace's output), and an interpreted chain is held immutable only when its URL names the current ones. A stale URL never errors. Refresh metadata: `/data` adds `refreshAt` when the result expires. It is a staleness deadline, not permission to reload: the View never replaces mounted content (an assessment may be under way, edits or not); when the deadline passes it sets `expired` for the Form and posts `data-expired` to the host. Content is initialized from one load: later updates of the shared SWR entry (another View's reload) never reach a View that has content. Only a load already expired before any content was initialized from it is loaded again, once, through the same `GET /data` and credentials, and initialized from directly (an identical answer is no SWR update); if that fails, nothing is shown and the host is told it expired. A Form-signalled safe refresh is later work. Without `refreshAt`, nothing changes. Recompiles carry L0158's requested generation: `POST /compile` checks it against the item's own chain before adding the data task, and getData allows exactly that one generated task (`checkGenerationWithDataTask`); other mixed chains and connections are refused. L0176's `generation.ts` is retired once L0176 takes view 0.5.0.

- **B5 Commands, part 1.**
  - A command store with:
    - idempotency keys;
    - admission bound to the ordered stage model digests;
    - pinned inputs per stage, with recorded external reads;
    - an outcome per operation, aggregated into the command's.
  - Lease and fencing: execution tokens carry the fencing generation, and authorize-execution refuses a stale one. Code in `packages/policy/src/` and `packages/broker/src/`.
  - Used only by languages that declare commands.
- **B6 Commands, part 2.** The repair ledger keyed by `(command, stage, occurrence)`, `materialize` replay, and resuming stages the original never reached. Before B6 ships, a partial command is reported, and repairing it is manual reconciliation.

## Track C — Upgrade each switched language to the interpreter (Rust only)
Prerequisites: the language is switched (A), and B1–B4 have shipped. A language that needs commands also needs B5, and B6 before repairs can be offered.

**Each upgrade is one release:**
1. Its Rust compile produces models.
2. Its declaration is added to the interpreter manifest (P1c) and activated by API env.
3. Its generation is bumped.
4. The P3 gate, in "interpreted" mode, shows that `interpret(compile(task), input)` equals the previous `compile(task, input)` for every corpus case.

Activation is API env, like the switch: `INTERPRETER_LNNNN=on` (and, for C5 and C6, `COMMANDS_LNNNN=on`), always together with a new `COMPILE_GENERATION_LNNNN`. The interpreter manifest (P1c), released with the API, holds the language's declaration (caps, pairs), and the env turns it on. Rollback procedures are in "Rollback procedures" below.

**Order:**
**When a model may be a value.** A model is a value only when the compiler proves that *this program* is independent of its input: it neither reads `data` nor goes through a language step that merges input. Otherwise it is a plan, and constant folding happens only inside input-independent subexpressions. This is decided per program, not per language.

1. **C1 Languages whose programs can be input-independent:** l0184 and l0186, which deliberately ignore input, and l0175. Programs that use the `data` operator are still plans.
   - **C1 as built, L0184: active since 2026-10-30** (api `rmvv585jc-1d4f7e`, `INTERPRETER_L0184=on`, `COMPILE_GENERATION_L0184=interp-1`; evidence in `docs/evidence/interpreter-c1-l0184/`).
     - Kernel: `Ast::reads_input` (a reachable `data` form, or a `get-var` whose name isn't a literal other than `"data"`). L0184's `Dialect::input_independent` is `!reads_input()`. A program whose value is undefined stays a plan (a value model would answer `data: null` where `/compile` answers no `data`).
     - Proof: `languages/l0184/crates/core/tests/interpret.rs` interprets every conformance case that compiles (674 value models, 82 plans) in both modes and requires the server's JSON to equal its compile; `languages/l0000/crates/core/tests/interpret.rs` does the same for the L0000 corpus with a dialect declaring the same rule.
     - Live gate: `node scripts/lang-parity.js --lang 0184 --interpreted --rust <l0184r URL>` compares, per case, `/compile` with `/compile {form: "model"}` then `/interpret` in both modes, with no allowance.
     - Manifest: `0184` declared `interpreter`, caps `immutable` in both modes (`INTERPRETER_MANIFEST_VERSION` 2). Inert until the API sets `INTERPRETER_L0184=on`.
     - Deploy tool: a release or rollback that changes `INTERPRETER_LNNNN` or `COMMANDS_LNNNN` without changing `COMPILE_GENERATION_LNNNN` is refused (`flagGenerationProblems`).
     - Activation, as done: `l0184r-rmvv42fue-21907b` released with this kernel; the live interpreted gate 2864/2864; the api staged with the flag and the new generation; the canary through its tag 11/11 (outputs equal production's legacy path, cache headers by generation, stage-cache hits, mixed chains, `/data` and `/compile`); promoted with that evidence. Each interpreted stage's log record carries its call timings (`ms.model`, `ms.cache`, `ms.interpret`), so stage-cache hits (a model compile and a lookup) and misses are measured apart.
     - Rollback: `npm run rollback -- api --env production --release rmvv585jc-1d4f7e` (back to `rust-1` and the legacy path).
     - Not A6: L0184's TypeScript source stays until its own gates have evidence (no build dependency on it, a production soak, a demonstrated rollback to a compatible Rust revision).
   - **C1 for L0186 (2026-10-30), after its A1 switch the same day** (`api-rmvvabb4r-083249`; evidence in `docs/evidence/track-a-l0186/`): `input_independent = !reads_input()`. All 637 corpus programs that compile are value models and interpret as they compile in both modes against three inputs; a board with a `data` expression is a plan. Declared in the manifest (v3). Activation follows L0184's route: release `l0186r`, the interpreted gate, then `INTERPRETER_L0186=on` with `COMPILE_GENERATION_L0186=interp-1`, staged and canaried.
2. **C2 Languages that read their input:** l0174, l0003, l0179, l0180, l0181, l0183, l0177, l0178, l0010, l0014. These are plan models run by the kernel evaluator.
   - **L0174 is never a value model.** Its `PROG` merges upstream data into the form (`languages/l0174/packages/core/src/compiler.ts:168-174`), and its corpus expects the upstream `title` and extra fields, so returning the compiled value unchanged would lose them. Its interpreter performs that merge at runtime.
   - Do these as their chains allow: an upgraded downstream stage must receive the same input it did through the legacy adapter.
3. **C3 L0185:** fetching moves into `interpret`, results are `shared`, and fetched reads are recorded for commands.
4. **C4 L0182:** the durable get-or-create assignment (atomic, stable across revisions, frozen on submission), plus keeping the survey model that answers were given against.
5. **C5 L0013 snapshots become brokered commands.** Today `l0013` uploads directly with its own service account (`languages/l0013/crates/capture/src/storage.rs:51`, `predefinedAcl=publicRead`). There is no Policy invocation, broker receipt or fencing, so nothing exists to adopt or replay. C5 builds that path first:
   - **C5a Authorization without a provider connection: scopes per intent, within the chain's one invocation.**
     - Policy's allocation requires a connection today (`allocateInvocation`, `packages/policy/src/policy.ts:171`), and the broker normally loads credentials from that connection. Snapshot callers have neither.
     - Binding a whole invocation to one item wouldn't cover a chain either: the design uses **one invocation across the chain** (design §5, "Pipelines"), and a chain can capture several items, or capture one and save another through a connection.
     - **So an invocation carries a set of authorization scopes, one per effect intent:**
       - Each intent `(stage, occurrence)` in the admitted plan names its scope: a **connection scope** (a provider connection, as today) or an **item scope** (an item id).
       - Admission authorizes every scope the plan contains, and authorize-execution re-checks the scope of the specific operation before each step.
       - The connection becomes optional at allocation: it is required only if some intent needs a connection scope.
       - Provider-backed effects work exactly as today inside the same invocation, alongside item-scoped ones.
     - **The registry declares each function's credential.** It lists `snap` as `kind: write`, `credential: service`, `scope: item`, not delegable.
     - **The broker matches credential to scope:**
       - a `credential: connection` operation uses its connection scope's credentials, as today;
       - a `credential: service` operation uses **the broker's own runtime identity** and its item scope.

       It refuses an operation whose scope doesn't match its credential, such as a service operation presenting a connection or a connection operation presenting an item.
     - **What an item scope authorizes:**
       - **Private items** need edit permission: the user must be able to edit the item, checked against the item store the console writes. This is the same rule as resolving with an owner token today.
       - **Public items, as a compatibility exception.** Today L0013 captures public items with no owner token (`languages/l0013/packages/core/src/snap.ts:249-252`), so an owner-only rule would break requests that work today.
         - From activation, an item scope on a **public** item is authorized for any caller the gateway admits, including one that isn't signed in. Such a caller is recorded as `anonymous`.
         - A per-item rate limit applies, since today's thumbnail overwrites have none.
         - The registry marks the exception explicitly (`publicCapture: true`) and dates it.
       - **Whether the exception stays is a separate, announced decision.** D3 inventories who captures public items without owning them. If the exception is to end, those callers move to owner tokens or to an owner-run job first, and it ends only with a dated compatibility notice, never at activation.
     - Registering `snap`, and adding scopes to tokens, is a `REGISTRY_VERSION` bump rolled out under P1b. Scopes are part of the admitted plan, so they keep the plan's own version.
   - **C5b Upload and publish, ordered by a capture sequence.**
     - **The item's thumbnail record has two separate fields:**
       - `nextCaptureSequence`, allocated by an atomic increment;
       - `publishedCaptureSequence`, the sequence of the capture the pointer shows. It starts at 0.
     - **When the command starts**, before rendering, the API increments `nextCaptureSequence` and pins the value in the command record. That value is the capture's sequence.
     - **The broker operation** (for example `gcs.put-thumbnail`) takes `(item id, PNG digest, capture sequence)` as its arguments, so retries bind the same way. It:
       1. writes the PNG to an immutable, content-addressed path, `thumbnails/{item}/{sha}.png`;
       2. publishes, with a compare-and-set that sets the pointer and `publishedCaptureSequence` to this capture **only if its sequence is greater than `publishedCaptureSequence`**.
     - **The first capture** (sequence 1, published 0) always publishes.
     - **An older capture that finishes after a newer one has published** still uploads its immutable object, but doesn't publish. Its outcome is `completed` with `superseded: true`.
     - **Allocating never publishes**, so an abandoned capture leaves `publishedCaptureSequence` alone.
   - **C5c IAM handoff, covering both runtime accounts.**
     - Grant the broker runtime account write access on the thumbnails bucket.
     - Two accounts can upload directly today or during migration:
       - `l0013-run` (TypeScript);
       - `l0013r-run` (Rust, `deploy.json:786`), which A1b grants production upload access for the switch.
     - Both keep direct write *only* until D4 retires legacy snapshots for L0013. Then **both** lose it, in the same release, and a check confirms that neither can write the bucket.
     - Record each grant and removal in `docs/capability-policy-iam-review.md`.
     - Give `l0013r` egress to Policy and Broker.
   - **C5d The snapshot as a command.**
     - The rendered PNG is a **recorded observation**: its bytes are staged and its digest recorded in the command record before the upload.
     - A retry or recovery uploads the staged PNG and never re-renders, so a different render can't cause `operation-id-reused`.
     - Fencing and outcomes follow B5.
   - **C5e Bridge.**
     - Legacy snapshot compiles have no keys today. Through D2 each one becomes a command with a fresh key, which is today's behavior of a new capture every time, but now brokered and receipted.
     - D2a's legacy-receipt guarantees don't apply to snapshots made before C5.

   C5 needs B5, D2b's floor, P1b and the IAM review.
   - **Tests:**
     - The first capture of an item publishes.
     - An older capture that finishes after a newer one publishes leaves the pointer and `publishedCaptureSequence` on the newer one.
     - An abandoned capture, allocated and never uploaded, doesn't block the next capture from publishing.
     - A snapshot of a **private** item by a user who can't edit it is refused at allocation, and again at execution after access is revoked.
     - A snapshot of a **public** item without an owner token succeeds as it does today, rate-limited and recorded as `anonymous` or as the caller.
     - A chain capturing two different items, and one mixing a snapshot with an L0176 save through a connection, is admitted with one invocation and a scope per intent. Each operation runs only under its own scope, and a mismatched credential and scope is refused.
     - A `credential: service` operation carrying a connection is refused.
     - After D4, neither `l0013-run` nor `l0013r-run` can write the bucket.
6. **C6 L0176:**
   - Signing only in `present` mode, unsigned in `evaluate`.
   - Read-stage signing and `/preview/sign` become `get`.
   - `save-to-itembank` becomes a `start` command (needs B5 and Track D; repair needs B6). This needs a `REGISTRY_VERSION` bump under P1b.
   - The content-digest dynamic-content reference.
   - Check the consumers that read `data.request`: MCP `item-content.ts:714`, the widget iframe, and the console.
7. **C7 L0000** last, because it is the kernel the others depend on.

Durable executions (`dispatch`, long-lived executions) stay deferred, as in the design doc.

## Rollback procedures
**Track A (switch to Rust):**
- Roll back the API release that set `BASE_URL_LNNNN` and `COMPILE_GENERATION_LNNNN` (`npm run deploy -- rollback --release <id>`), or release a forward one without them.
- Traffic returns to the TypeScript service, which was never removed, and the old cache namespace comes back.
- The `lNNNNr` service itself needs no rollback.

**Track C (interpreter activation):**
- **Two flags per language, rolled back separately:**
  - `INTERPRETER_LNNNN` turns on interpretation of reads (`get`).
  - `COMMANDS_LNNNN` turns on effects as commands (C5, C6). With it off, effects run through legacy compiles.
- **The generation always moves with a flag.**
  - Turning either flag on or off, by API rollback or by forward release, also restores the previous `COMPILE_GENERATION_LNNNN` or sets a new one. It never keeps the generation the interpreter's results were cached under.
  - The cache lookup returns before anything executes (`packages/api/src/data.js:234`), so a kept generation would keep serving the interpreter's cached, possibly defective, results.
  - The deploy tool refuses an `api` release that changes either flag without changing that language's generation.
  - The B3 stage cache is keyed by the generation too.
- Either way the result must not be older than the D2b floor, and the deploy tool enforces that.
- **Reads and effects follow different flags.**
  - With `INTERPRETER_LNNNN` off, reads go through the legacy adapter.
  - **Protocol allocation follows `COMMANDS_LNNNN` alone** (D2a): new keys allocate as `command` while it is on, and as `legacy` only when it is off. Turning interpretation off doesn't change how effects run.
- **After D4, `COMMANDS_LNNNN` can't be turned off for a language whose legacy effects used credentials D4 removed.** That means L0013: once neither `l0013-run` nor `l0013r-run` can write the bucket (C5c), a legacy compile's snapshot would fail.
  - Rollback for such a language turns off only `INTERPRETER_LNNNN`. Snapshots keep running as brokered commands, which never need the compiler's credentials.
  - **Rollback doesn't re-enable the bridge.** D4 has retired it (`BRIDGE_L0013` off), so after D4 fresh snapshots arrive only through `POST /command`. A legacy compile that reaches `snap` is refused with an error that names `POST /command`; it isn't executed. Re-enabling the bridge would be its own release and would need an announcement.
  - The deploy tool refuses a release that turns `COMMANDS_LNNNN` off for that language after its D4.
  - L0176 isn't affected: its legacy saves already go through the broker.
- Existing `command` keys stay `command` (D2a) and are still served.
- **Do not roll back the `lNNNNr` service below a revision that existing commands need.** Each command record names the interpreter revision it ran on, by tag URL, the same way admitted plans pin `tagUrl`, and its retries and recovery go to that revision.
- A service rollback may move *traffic*, but every tagged revision a live command names is retained: services and revisions are never deleted, and those tags are excluded from `retireTags`.
- If an interpreter revision is defective, recovering its commands is a forward fix plus reconciliation. Retrying them on another revision is not allowed.
- **Rollback tests:**
  - After a forward release turns `INTERPRETER_LNNNN` off, a cached result from the interpreter generation is no longer served: the next read recompiles under the restored or new generation.
  - After L0013's D4, with `INTERPRETER_L0013` off:
    - a **fresh** snapshot through `POST /command` succeeds as a brokered command;
    - a legacy compile that reaches `snap` is refused and not executed;
    - the bridge stays off.
  - A release that turns `COMMANDS_L0013` off after D4 is refused.

## Track D — Move command callers to explicit commands (before C5 and C6 enforce them)
Today an effect runs as a side effect of `/compile`. An L0176 save runs on any compile through a connection, the console's Learnosity save being one; L0013 `snap` runs on a compile. Idempotency keys are optional today (`packages/policy/src/invocations.ts:57`). Changing either one without the callers would break them.
- **D1 Public command contract.**
  - `POST /command { id, connection, idempotencyKey, … }` returns an outcome: `pending`, `completed`, `failed`, `partial` or `uncertain`, plus a status URL.
  - The key is **required**.
  - It is documented in the API, and it is additive: nothing calls it yet.
- **D2 Compatibility bridge.** For a language whose effects have moved to `start` (C5, C6), a legacy compile that reaches an effect intent is **translated by the API into a `start`**, with the same execution behavior callers get today:
  - The caller's `idempotencyKey` is used when it supplies one.
  - Otherwise a fresh key per request, which is today's "new invocation every time".
  - The result goes back in today's compile envelope.

  The bridge is on by default for each upgraded language, so C5 and C6 change no caller's behavior.
- **D2a The protocol is decided once per key, at allocation, and never changes.**
  - **Allocation is authoritative.** Policy's `allocate` (`packages/policy/src/invocations.ts:57`) records, atomically with the key, the invocation's **execution protocol** (`legacy` or `command`), plus the command id for a command.
    - The first allocation in the transaction wins. A concurrent request with the same key gets the winner's record and follows its protocol.
    - A preliminary `findByKey` never decides the protocol: under overlapping releases two requests could otherwise each see "none" and choose differently.
    - Invocations allocated before this field existed read as `legacy`.
  - **Every request with a key dispatches on the recorded protocol:**
    - **`legacy`** (a save made before activation, with source-based admission): it stays on the legacy protocol for the invocation's whole life, compiled through its admitted plan at its pinned revisions, which still exist because services and revisions are never deleted. No command record is created.
    - **`command`** (created after activation): load the command record and continue it under its own rules: pinned inputs, fencing, and the recorded outcome. Never recompile the chain.
    - **No record:** allocate now, choosing `command` if `COMMANDS_LNNNN` is on and `legacy` otherwise. `INTERPRETER_LNNNN` plays no part. The allocation decides it from then on.
  - **The two protocols never cross for a key.** A legacy invocation is never adopted into a command, and a command is never retried by legacy compilation.
  - **Legacy receipt guarantees apply only where receipts existed.** Today that means L0176's `save-to-itembank`, the only effect that goes through Policy and the broker. L0013's snapshots have no invocation and no receipt (§C5), so a legacy snapshot has nothing to replay. Its retry behavior stays today's: a new capture and an overwrite, until C5.
- **D2b A command-aware API is the rollback floor.**
  - An API that doesn't know about command records would retry a command by recompiling the chain. It would run upstream stages again instead of using pinned inputs, so in an L0185 → L0176 chain changed fetched data gives different arguments and `operation-id-reused`. It would also bypass command outcomes and fencing. Matching occurrence ids don't prevent this.
  - So, **before any language is activated**, release and soak an API that dispatches on the recorded protocol and that holds command records, pinned inputs and terminal outcomes (B5 plus D2a). This release is the **rollback floor**.
  - **Activation and rollback are flips of the language's flags, never a rollback below the floor.** That means `INTERPRETER_LNNNN` for reads and `COMMANDS_LNNNN` for effects, each with its generation. Rolling back flips a flag, by an API rollback that stays at or above the floor or by a forward release.
    - Turning `COMMANDS_LNNNN` off makes new keys allocate as `legacy`.
    - Turning only `INTERPRETER_LNNNN` off leaves allocation unchanged.
    - Existing `command` keys stay `command` and keep being served (see "Rollback procedures").
  - **The deploy tool refuses an API rollback below the floor** once any command record exists. The release receipt records the floor, and `rollback --release` checks it, so an emergency can't silently drop command handling.
- **Promotion tests spanning activation and rollback,** each showing that a completed effect never runs again:
  1. A legacy L0176 save completed before activation, retried with the same key after activation, stays `legacy` and returns its recorded receipt with no provider call.
  2. A command save completed after activation, retried after the declaration is flipped back, stays `command` and returns its recorded outcome.
  3. An L0185 → L0176 command whose fetched source changed is retried after a declaration rollback. It uses the pinned inputs, never `operation-id-reused`.
  4. Concurrent first requests with one key during an overlapping release: one allocation wins, and both follow its protocol.
  5. A legacy L0176 save that was `partial` at activation, retried: completed operations aren't repeated, and the failed one runs at most once.
  6. `rollback --release` to a pre-floor API is refused once a command record exists.
- **D3 Find and migrate the callers.**
  - Inventory the callers from audit logs and code: console save (`graffiticode-app`), L0013 thumbnail requests, anything else invoking a compile through a connection. MCP authoring never writes.
  - Move each one to `POST /command` with a stable key.
  - Ship the clients first. The bridge keeps old clients working meanwhile.
- **D4 Retire the bridge, per language.**
  - Turning `BRIDGE_LNNNN` off ends compile-triggered effects for that language. A legacy compile that reaches an effect is then refused with an error that names `POST /command`, and is not executed.
  - The bridge is a third flag, separate from `INTERPRETER_LNNNN` and `COMMANDS_LNNNN`. No rollback of those two turns it back on.
  - Only once telemetry shows no legacy-triggered effects for an agreed period.
  - Announced as a compatibility change. Rollback is re-enabling the flag.
  - For L0013, D4 is also when both runtime accounts lose direct write (C5c). From then on `COMMANDS_L0013` stays on (see "Rollback procedures").

## Decisions this plan records

The design doc's §5, §11, §12 and §14 are amended to match.
- Each language switches to Rust first (A) and is upgraded later (C), replacing "switch compile and interpret together".
- The legacy adapter is permanent, for the out-of-repo Node languages.
- P1 artifact compatibility must ship before any registry bump, and a bump follows the P1b expand/contract protocol. Interpreter declarations have their own manifest version (P1c).
- Commands get a public contract and a compile-to-command bridge. Callers migrate before the bridge is retired (Track D).
  - Policy's allocation records each key's protocol, atomically, and it never changes: legacy keys stay legacy, command keys stay command.
  - A command-aware API is the rollback floor, and activation is rolled back by a declaration flip.
  - L0013 snapshots get a brokered, receipted upload path before they become commands:
    - per-intent scopes (connection or item) within the chain's one invocation;
    - a dated public-capture exception, kept until an announced decision;
    - separate `nextCaptureSequence` and `publishedCaptureSequence` fields, with the capture's sequence bound into the upload;
    - both runtime accounts lose direct write at D4.
- Track A and Track C have separate rollback procedures. Interpreter revisions that live commands name are retained and routed to by tag.
  - Track C uses separate `INTERPRETER_LNNNN` and `COMMANDS_LNNNN` flags, and each flag change moves the language's generation.
  - After D4 removes direct credentials, commands can't be turned off for that language.
- A plan keeps its admitted registry version, and versions are never interchangeable. Replay after contraction uses replay-only tokens.
- The mixed-chain refusal applies only to declared stages. Legacy stages forward their output as today.
- Value models are decided per program. L0174 is a plan language.
- L0013 is promoted with capture evidence against an isolated bucket.
- P2 makes each language's routing switch a pair of API env vars, so rollback is an API rollback.
- Retiring a language's TypeScript implementation is a per-language milestone after its switch: source removal (A6) behind five gates, and service retirement (A7) as a separate, explicit owner decision. The language itself is never retired.
