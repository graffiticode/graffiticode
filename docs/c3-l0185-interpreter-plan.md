# C3: L0185 on the interpreter

**Status:** draft for review (2026-11-11). Plan item: `docs/graffiticode-interpreter-plan.md` Track C, item 3 ("fetching moves into `interpret`, results are `shared`, and fetched reads are recorded for commands"). Design: `docs/graffiticode-interpreter-design.md` §5 (pipelines, observations), the cache-class table, and the L0185 line.

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

## 2. Decisions (owner to confirm)

1. **Results are `shared`, with an expiry.**
   - An L0185 result that fetched anything is `shared`, expiring a fixed **5 minutes** after its earliest fetch.
   - A result that fetched nothing (only `rows`/`from` and input) is `immutable`, as today.
   - The manifest caps are `shared` in both modes.
   - **Proposed: a fixed 5 minutes.** The alternative, honoring each source's `Cache-Control: max-age` clamped to [60 s, 1 h], adds header parsing and per-source variance, and could come later.
2. **The kernel gains a per-result cache class and expiry.**
   - A dialect sets them on the `ExecContext` during evaluation; for example, `fetch` marks the result `shared` and records its expiry.
   - The server writes `cache` and `expiresAt` into the envelope.
   - Languages that set nothing are unchanged: their envelope is the same as today.
3. **Fetching stays in `interpret`; models never fetch.**
   - `input_independent` stays false for any program that fetches.
   - Optionally, a program that neither fetches nor reads `data` becomes a value model, as in C1. It's a small win, so decide whether to include it.
   - Today's fallback from `interpret` to `compile` already runs the fetch at interpretation time. "Moving fetching into `interpret`" then means: model-making never fetches, `interpret` fetches, and the new cache class rides on the result.
4. **Commands: rely on the pinned input; defer per-read observations.**
   - The motivating case is an L0185 → L0176 save whose fetched source changes between a command's attempts.
   - B5 already handles it: the worker pins the L0176 stage's input install-once, so a retry or recovery gets the first fetched data and never hits `operation-id-reused`, even though recovery re-runs the L0185 stage live.
   - Recording each fetch as an observation would need a command session for read-only stages: a change across the kernel, the worker and Policy (Policy's claims bind a stage).
   - That only matters for B6 materialization and repair, and for Track E. **C3 adds a test proving the pinned-input path, and leaves observations to B6.**
   - Policy's payloads are capped at 512 KiB, against 1 MB for an L0185 result. A larger L0185 output feeding an L0176 save is refused `input-too-large`, which is clear and safe. Raising the cap is separate.
5. **HTTP caching for `shared`.** Implement the design's rule in `routes/data.js`:
   - a chain whose result is `shared` and unexpired is served `Cache-Control: max-age=<seconds until expiresAt>`, not `immutable`, and not `public`;
   - `immutable` chains are unchanged;
   - anything stricter is `no-store`, as today.

   Without this, an interpreted L0185 chain would be `no-store` at HTTP and refetch on every view (within the stage cache's 5 minutes). That's acceptable, but wasteful.
6. **A new generation: `COMPILE_GENERATION_L0185=interp-1`.** Legacy `compiles/` entries hold fetched output under `rust-1`, so the new generation is what makes interpreted chains stop serving permanent copies. The old entries are never served again under `interp-1`.
7. **The B5 soak's latency baseline moves off L0185.** `scripts/interpret-soak.js` defaults `--baseline-lang 0185` as its compile-only language. Once L0185 is interpreted, use `0000` (compile-only until C7), and record the change in the plan's B5 budget rule.

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
- **(Optional, decision 3) `input_independent`:** true when the program neither fetches nor reads `data`.
- **`crates/core/tests/interpret.rs`, the main correctness gate, as L0184 has:** for every conformance case, with the fixture fetcher:
  - the plan or value model, interpreted in both modes, equals the compile;
  - the restriction is `shared` exactly when a fetch ran.
- **Fix `languages/l0185/CLAUDE.md`,** which still says TypeScript is what production runs.

## 5. The api

- **The manifest (v8):** declare `0185` as an interpreter with caps `{ evaluate: "shared", present: "shared" }`.
- **`routes/data.js`:** `max-age` for unexpired `shared` chains (decision 5).
- **`scripts/interpret-soak.js`:** default `--baseline-lang 0000` (decision 7).
- **Tests:**
  - **chains:** a `shared` L0185 stage under an `immutable` L0184 stage gives a `shared` chain with the earliest expiry;
  - **HTTP:** the headers are `max-age` while unexpired;
  - **the stage cache:** a hit before `expiresAt`, a miss after;
  - **a command:** an L0185 → L0176 command whose fetched source changes between a lost answer and recovery still saves the first data (the pinned input) with no `operation-id-reused`. This is the plan's promotion test 3, run in the worker spec against a fake fetcher.

## 6. Activation and rollback

1. Release `l0185r` with the kernel and dialect changes (§3, §4). Run the canary; legacy compiles are unchanged except for the new envelope fields, which the legacy path ignores.
2. **The interpreted gate:**
   - **Fixtures:** `cargo test` on `tests/interpret.rs` over the 4,002-case corpus.
   - **Live:** `node scripts/lang-parity.js --lang 0185 --interpreted --rust <l0185r>`. Every answer must equal its compile, ignoring `revision`, `cache` and `expiresAt`.
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
| 2 | L0185's `fetch` restriction, `tests/interpret.rs`, the CLAUDE.md fix (and optionally value models) | `languages/l0185` | `l0185r` |
| 3 | Manifest v8; HTTP `max-age` for `shared`; the soak baseline; api tests including the pinned-input command test | `packages/common`, `packages/api`, `scripts` | api, flag off |
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
- **Model-time fetching, if value models are added.** A program misclassified as input-independent and fetch-free would be evaluated at model time. The `interpret.rs` test must assert that no value model came from a fetching program.
