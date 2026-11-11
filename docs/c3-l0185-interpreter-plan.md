# C3: L0185 on the interpreter

**Status:** revised after review (2026-11-11); the owner's choices are recorded in §2. Plan item: `docs/graffiticode-interpreter-plan.md` Track C, item 3 ("fetching moves into `interpret`, results are `shared`, and fetched reads are recorded for commands"). Design: `docs/graffiticode-interpreter-design.md` §5 (pipelines, observations), the cache-class table, and the L0185 line.

## 1. Where we start

**L0185 today** (Rust, `l0185r`, routed since Track A2; `COMPILE_GENERATION_L0185=rust-1`):
- **Fetching.** Only `fetch` does I/O. It makes one HTTPS GET per URL at compile time (`languages/l0185/crates/core/src/lib.rs`), with these limits:
  - at most 10 distinct URLs per compile;
  - 10 s per URL, 5 MB decoded;
  - https on port 443 only, no private addresses;
  - no auth headers and no secrets.
- **Caching.** An in-process cache of fetched bodies, 60 s and 200 URLs.
- **Egress.** The proxy class `compilers-l0185` is "open" (any public host except the denied suffixes).
- **Its `Dialect` leaves the interpreter hooks at their defaults:**
  - `input_independent` is false, so every model is a plan;
  - `interpret` declines, so a plan falls back to `compile`;
  - there are no intents.

  So a plan model of an L0185 program already fetches at `/interpret`, and never when the model is made.
- **Not declared in the interpreter manifest** (v7), and no `INTERPRETER_L0185` flag exists.
- **Legacy caching is effectively permanent.** A connection-free L0185 chain is written to the whole-chain `compiles/` store and served `max-age=31536000, immutable`, so fetched data never refreshes for the same task id. Fixing that is the user-visible gain of C3.

**What the platform has, and lacks:**
- **The api already handles cache classes.** It reads `cache: "<class>"` and `expiresAt` from an interpreted stage's envelope (`packages/api/src/interpret.js`). It stores `immutable` and `shared` results in the stage cache until `expiresAt` (`storage/stage-results.js`), and caps them by the language's manifest caps.
- **The kernel can't emit them.** `Dialect::cacheable()` is one boolean per language, and the server's envelope only ever writes `cache: false`. **No Rust language can say "shared until X" today.**
- **HTTP doesn't express `shared` either.** A chain whose result isn't permanent is `no-store` (`routes/data.js`). The design's "`shared` → `max-age` until `expiresAt`" isn't implemented.
- **Commands.** `ExecContext::observe` records reads only under `start` with a command session. An L0185 stage has no intents and runs through `interpret` without a session, so its fetches can't be recorded today. The L0176 stage after it *does* pin its input, install-once (`commands/worker.js`).

## 2. Decisions (owner's choices, 2026-11-11)

1. **Results that fetched are `shared` for a fixed 5 minutes.**
   - An L0185 result that fetched anything is `shared`, expiring 5 minutes after its earliest fetch.
   - A result that fetched nothing (only `rows`/`from` and input) is `immutable`, as today.
   - Honoring sources' `Cache-Control` headers is out of scope.
2. **The kernel gains a per-result cache class and expiry.**
   - A dialect sets them on the `ExecContext` during evaluation, and the server writes `cache` and `expiresAt` into the envelope.
   - Languages that set nothing are unchanged.
3. **No value models.** Every L0185 model stays a plan, so model-making never fetches. Fetching runs only at `interpret`, through today's fallback from `interpret` to `compile`.
4. **The manifest caps for `0185` are `immutable` in both modes** (review finding 3).
   - A cap is the *loosest* class a language may claim, and the api takes the stricter of claim and cap. A `shared` cap would therefore downgrade a fetch-free `immutable` result to `shared` with no expiry, kept for 30 days.
   - With an `immutable` cap, the result's own claim decides:
     - `shared` with its 5-minute expiry when it fetched;
     - `immutable` when it didn't.
   - The guarantee that a fetching result claims `shared` comes from the dialect, and the fixture test (§4) asserts it for every corpus case.
5. **Commands: recover from the pinned boundary; defer per-read observations to B6** (review finding 1).
   - **The gap today.** The worker runs a chain right to left, so in an L0185 → L0176 command the L0185 stage runs *before* the L0176 stage's pinned input is read (`commands/worker.js` `runStages`). If a save's answer is lost and the source then fails, recovery re-runs L0185, the stage fails, and the command stops before replaying the save, though its input was pinned.
   - **The fix: recovery starts at the furthest pinned boundary.**
     - Before running any stage, the worker reads the pinned inputs (`records/input?stage=`).
     - It resumes at the **last** stage in execution order that has one, the furthest progressed, with that input. It skips every stage to that stage's right: they ran before its input was pinned, so their work is already in that input.
     - Restarting at an earlier pinned stage would re-run the fetches after it. In `fetch A → save A → fetch B → save B`, with both saves pinned and save B's answer lost, restarting at save A runs fetch B again, and a source outage would block recovery before save B.
     - A later effectful stage left of the resume point still pins its own input install-once.
     - **Resuming changes where the run starts, not what guards it.** The resumed stage still opens its session through Policy (live permission), every write is still owner-fenced by the command's generation, and the Broker still replays recorded operations from their receipts with no provider call.
   - **With that, re-fetching is never needed once a save's input is pinned,** and per-fetch observations matter only for B6 materialization and repair, and for Track E. They stay deferred.
   - **Payload size.** Policy's payloads are capped at 512 KiB, against 1 MB for an L0185 result. A larger L0185 output feeding an L0176 save is refused `input-too-large`, which is clear and safe; raising the cap is separate.
6. **HTTP caching is bounded, and carries the final class and visibility** (review finding 2).
   - **Carry the class to the route.** Today `data.js` reduces a chain's restrictions to `action.noStore` and `action.expiresAt`. It will also carry the combined cache class, `immutable` or `shared`, to the route. A multi-id request (`getData` over several ids) combines its ids' classes: the stricter class and the earliest expiry.
   - **The route decides the headers:**
     - **`immutable`:** unchanged.
     - **`shared` and unexpired:** `max-age=<seconds until expiresAt>`, never `immutable`. Visibility is kept as today: `private` for an authenticated request, `public` for an anonymous one.
     - **Anything else, and every existing forced `no-store`:** `no-store`. The forced cases are a connection, a publication, a stale `generations=` URL and an expired result.
7. **A new generation: `COMPILE_GENERATION_L0185=interp-1`.** Legacy `compiles/` entries hold fetched output under `rust-1` and are never served under `interp-1`.
8. **The B5 soak's latency baseline moves to L0000.** `scripts/interpret-soak.js` defaults `--baseline-lang 0000`, which stays compile-only until C7. The plan's B5 budget rule records the change.
9. **Live parity compares meaning, and checks cache metadata separately** (review finding 4).
   - `scripts/lang-parity.js --interpreted` compares each answer's semantic output with `revision`, `cache` and `expiresAt` removed. Today it strips only `revision`, so identical data fails when only the expiry differs.
   - It then validates the metadata on its own: `cache: "shared"` with an `expiresAt` within [now, now + 5 min + skew] exactly when the case fetched, and no class or `immutable` otherwise.

## 3. The kernel (`languages/l0000/crates`)

- **A cache class and expiry for each result.**
  - Add them to `ExecContext` (or to `Compilation`): `cache_class: Option<CacheClass>` and `expires_at: Option<u64>` (ms since the epoch).
  - Add helpers a dialect calls during `eval`, e.g. `cx.exec().restrict(CacheClass::Shared, Some(expiry))`. The stricter class and the earliest expiry win.
- **The server's envelope writes `cache: "<class>"` and `expiresAt` when they're set.** `cache: false` from `cacheable()` stays as is.
- **Tests:**
  - a dialect that sets nothing has a byte-identical envelope;
  - two restrictions in one compile combine as described;
  - the result's `interpret` and `compile` agree on the restriction.
- **Release:** only `l0185r` needs the new kernel. Other `lNNNNr` services pick it up whenever they're next released, unchanged.

## 4. L0185 (`languages/l0185/crates`)

- **`fetch` restricts the result** to `shared`, expiring at the fetch time plus 5 minutes. The earliest fetch in a compile wins.
- **A fetch served from the in-process cache** keeps the original fetch's time, so its expiry is no later than the data's age allows. The 60 s in-process cache is shorter than the 5-minute expiry, so this needs a stored timestamp, not a new one.
- **`crates/core/tests/interpret.rs`, the main correctness gate, as L0184 has:** for every conformance case, with the fixture fetcher:
  - every model is a plan;
  - the plan, interpreted in both modes, equals the compile;
  - the restriction is `shared` with a 5-minute expiry exactly when a fetch ran, and `immutable` (none) otherwise.
- **Fix `languages/l0185/CLAUDE.md`,** which still says TypeScript is what production runs.

## 5. The api

- **The manifest (v8):** declare `0185` as an interpreter with caps `{ evaluate: "immutable", present: "immutable" }` (decision 4).
- **`data.js` and `routes/data.js`:** carry the combined cache class to the route, including across multi-id requests, and set the headers by decision 6.
- **`commands/worker.js`:** recovery resumes from the pinned boundary (decision 5).
- **`scripts/interpret-soak.js`:** default `--baseline-lang 0000` (decision 8).
- **`scripts/lang-parity.js`:** semantic comparison plus explicit metadata checks (decision 9).
- **Tests:**
  - **chains:** a `shared` L0185 stage under an `immutable` L0184 stage gives a `shared` chain with the earliest expiry;
  - **HTTP:** a `shared` chain is `max-age` while unexpired, `private` when authenticated and `public` when anonymous. A multi-id request takes its ids' stricter class and earliest expiry. Every forced `no-store` case is still `no-store`;
  - **the stage cache:** a hit before `expiresAt`, a miss after;
  - **commands, in the worker spec against a fake source:**
    - an L0185 → L0176 command whose save's answer is lost, and whose source then **fails**, recovers: it resumes at the pinned boundary, replays the save from its receipts with the original data, and completes with no fetch and no `operation-id-reused`;
    - the same when the source **changes** instead (the plan's promotion test 3);
    - **multiple saves:** in `fetch A → save A → fetch B → save B`, with both saves' inputs pinned and save B's answer lost, recovery resumes at save B, with fetch B's source unavailable. Neither fetch runs, save A isn't repeated, and save B replays from its receipts with its original data;
    - resuming still checks authorization: a connection revoked before recovery stops the resumed stage at its session, recorded from receipts. A stale generation is still fenced out;
    - a command with no pinned input yet still runs every stage, as today.

## 6. Activation and rollback

1. Release `l0185r` with the kernel and dialect changes (§3, §4). Run the canary; legacy compiles are unchanged except for the new envelope fields, which the legacy path ignores.
2. **The interpreted gate:**
   - **Fixtures:** `cargo test` on `tests/interpret.rs` over the 4,002-case corpus.
   - **Live:** `node scripts/lang-parity.js --lang 0185 --interpreted --rust <l0185r>`. Every answer must equal its compile, ignoring `revision`, `cache` and `expiresAt`.
     - Semantic output must match, and the cache metadata is validated on its own (decision 9).
     - **Caveat:** about 3,000 corpus cases fetch `example.org` paths that answer 404 live, so they only compare errors. Real fetch coverage live is the 16 `l0185.graffiticode.org/data` cases; the fixture test carries the rest.
3. Release the api with manifest v8 and the HTTP and soak changes, with the flag off. It's inert until the flag is set.
4. **Stage** an api with `INTERPRETER_L0185=on` and `COMPILE_GENERATION_L0185=interp-1` (the deploy guard requires both). Canary through the tag:
   - L0185 alone, L0184 over L0185, and an L0185 → L0176 save;
   - stage-cache hit, then miss after expiry;
   - `max-age` headers;
   - nothing served from `rust-1` entries.
5. Promote with that evidence.

**Rollback:** set `INTERPRETER_L0185="off"` (by value, never by removing it) with a new generation (`rust-2`), as a forward release. Or roll the api back to the release before activation.

## 7. Slices

| # | Slice | Where | Release |
|---|---|---|---|
| 1 | The kernel's per-result class and expiry; the envelope fields; tests | `languages/l0000/crates` | (with slice 2) |
| 2 | L0185's `fetch` restriction, `tests/interpret.rs`, the CLAUDE.md fix | `languages/l0185` | `l0185r` |
| 3 | Manifest v8 (caps `immutable`); the cache class carried to the route and bounded HTTP caching; recovery from the pinned boundary; the soak baseline; the parity tool's semantic comparison and metadata checks; api tests | `packages/common`, `packages/api`, `scripts` | api, flag off |
| 4 | The interpreted gate, then activation: staged api with the flag and `interp-1`, canary, promote; evidence in `docs/evidence/interpreter-c3-l0185/` | `deploy.json`, `docs/evidence` | api |

## 8. Out of scope

- **Per-read observations** for read-only stages, and anything about materializing or repairing an L0185 stage: B6 and Track E.
- **Honoring sources' cache headers** (decision 1's alternative).
- **Raising Policy's 512 KiB payload cap.**
- **Connections:** interpreted stages never run through one; legacy as today.

## 9. Risks

- **Freshness becomes visible.** A chain's L0185 data now refreshes every 5 minutes instead of never. Anyone relying on a frozen copy for a task id would see changes. That's the intended behavior, but it's a change, and the release notes should say so.
- **Load on sources.** Every 5 minutes per distinct `(program, input)`, against today's once per task id, ever. The stage cache, the 60 s in-process cache and the 10-URL limit bound it.
- **Live parity is network-dependent.** A remote that changes between the three calls for a case makes a spurious mismatch. Re-run before reading it as a difference; the fixture test is authoritative.
- **A fetching result that fails to claim `shared`** would be stored as `immutable`, since the cap no longer bounds it (decision 4). The fixture test checks the claim for every corpus case, and the canary checks it live.
- **Resuming from the pinned boundary changes recovery for every command chain,** not just L0185's. The worker spec covers chains with no pinned input (unchanged) as well as pinned ones.
