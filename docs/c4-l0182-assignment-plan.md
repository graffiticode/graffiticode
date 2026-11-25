# C4: L0182 on the interpreter, with a durable survey assignment

**Status:** draft, revised after the owner's first review (2026-11-25). Nothing in it is implemented or live. The owner accepted the api as where assignment runs and `(survey, session)` as its identity. The other decisions in §2 are proposals, and each one marked **open** needs the owner's choice before its slice starts. Plan item: `docs/graffiticode-interpreter-plan.md` Track C, item 4 ("the durable get-or-create assignment (atomic, stable across revisions, frozen on submission), plus keeping the survey model that answers were given against"). Design: `docs/graffiticode-interpreter-design.md` §12 Phase 3 (the "L0182 version draws" bullets), §12 test 7, and open question 7 in §13.

**What the review changed:**
1. Submission is acknowledged only after its freeze commits, and an unavailable authority check or a lost freeze is a temporary error (decision 7).
2. A public item no longer authorizes submission, and the backfill establishes authority before treating a historical response as a submission (decisions 3 and 10).
3. The backfill has a cutover boundary: catch-up passes, a reconciling window at promotion, and an activation gate for unresolved records (decision 10).
4. Assignment is resolved per occurrence at run time, so several surveys and sessions in one program work, and an input-dependent session keeps a durable record (decisions 1 and 2).
5. Named versions get a submission record and retained content (decision 2).
6. L0182 results stay uncached: no stage-cache hit is expected (decision 8).

## 1. Where we start

**L0182 today** (Rust, `l0182r`, routed since Track A; `COMPILE_GENERATION_L0182=rust-1`; not interpreted and not in the interpreter manifest):
- **A program names a survey and nothing in it.** `survey [id "civic-priorities" session-id get-val-public "itemId" response [...]]`. The options, items, scales and wording are read from `packages/core/data/<id>-<n>.json`, which `crates/core/build.rs` embeds in the binary. The files are never served.
- **An id names a set of versions.** `civic-priorities` has 12 (`-1` … `-12`), `workplace-pulse` 3, and the other seven surveys 1 each (17.5 KB in all). A bare id **draws** a version without replacement, and the marks clear once every version has been taken. A named version (`civic-priorities-7`) loads outright, with no draw and no mark (`crates/core/src/source.rs`, `Files::load`).
- **The session is the console item id.** The console folds `get-val-public "itemId"` into a literal when it parses (`graffiticode-app` `packages/console/src/pages/api/index.ts:532`, `packages/core/src/lib/code-generation/generate-for-request.ts:523`). From the second turn the program carries that literal. A session that drew before gets the same version back, so a response is checked against the options its taker saw. An empty session is no session.
- **A program can take several surveys.** Every `survey` occurrence is evaluated, and 7 of the 3,606 conformance cases have more than one, for example `[survey [id "civic-priorities" session-id "a"] survey [id "civic-priorities" session-id "a"] survey [id "civic-priorities" session-id "b"]]`. Today the memory has **one slot per session**: a session taking a second survey replaces the first, so in a program like `[civic "a", workplace "a", civic "a"]` the two `civic` occurrences draw different versions. Sessionless occurrences of one id draw different versions from each other, without replacement.
- **The draw is process-local.** `Files` keeps `taken` and `drawn` in a `Mutex` per process. `l0182r` runs up to 20 instances, scales to zero when idle (no minimum, checked 2026-11-25), and restarts on every release. So a session that answers later can land on an instance that never drew for it and get a different version. `languages/l0182/CLAUDE.md` records this as a known limit.
- **The draw happens during compile,** so the same task compiled twice can give different output.
- **The compiler is the only enforcement.** `ranked.rs` and `rating.rs` check every answer against the drawn version, so an answer validated against one version can fail against another.
- **The output names what was drawn:** `sessionId` (when there is one), `instance`, and the `response` lifted to the top level (`build_survey`).
- **What is stored today:**
  - `tasks/<id>` with its `lang`.
  - `compiles/<id>`, written once per task and generation, with `firstCompile`, `lastCompile` and `count` (`packages/api/src/storage/compile.js`).
  - The console's append-only version history, `users/<owner uid>/versions/<itemId>__<taskId>`, written under the item owner's account when a version of the item is saved (`graffiticode-app` `packages/core/src/versions.ts:106`). It is best-effort provenance.
  - Nothing records a draw durably. The survey data hasn't changed since 2026-09-22 (`4f12559a`).
- **The manifest is ready:** `packages/common/src/interpreter-manifest.ts` validates a `getOrCreate` declaration. No language declares it, and the api doesn't act on it.
- **The stage cache never holds a `private` result:** `sharable` admits only `immutable` and `shared` (`packages/api/src/interpret.js:97`).
- **The api calls `/interpret` with `{ model, input, mode, auth, options }`** (`packages/api/src/comp.js:38`). `Dialect::interpret(model, input, mode)` can't receive anything else, or ask for anything.
- **`l0182r` has no store and no credentials** (`l0182r-run` holds no roles). Policy's item authority (`packages/policy/src/item-authority.ts`) can say who owns a console item.

## 2. Decisions

1. **The api assigns, per occurrence, at run time.** *(Placement accepted by the owner; protocol proposed.)*
   - `l0182r` stays credential-free, and the model stays the plain plan it is today.
   - **Interpret is a short exchange.** On `/interpret`, the language evaluates the program. Each `survey` occurrence is resolved from an **assignment table** the api passed in, keyed by identity (decision 2).
     - **An identity missing from the table** doesn't draw. The language records a **request**: the identity, the occurrence's ordinal and every candidate version as `{ instance, digest, content }`, where the digest is the SHA-256 of the file's exact bytes. It finishes evaluating, so one pass finds every identity that doesn't depend on survey content, and answers `needsAssignment: [requests]` with no result.
     - The api resolves every request (decision 5), then calls `/interpret` again with the fuller table.
     - The exchange is bounded: at most 4 calls, then the stage fails `assignment-unresolved`. Only a program whose `id` or `session-id` depends on another survey's content needs more than 2.
   - **Why this shape:**
     - Identities computed at run time (an input-dependent `session-id`, several surveys, surveys inside `map`) get durable records like literal ones.
     - The language never draws, so interpretation is a pure function of model, input and table.
   - **Exposure:** a request carries the candidates' content to the api, never to a client. Anyone can already compile `survey [id "civic-priorities-7"]` and read version 7. Slice 3 confirms that no api route returns a request or a model to a client.
2. **Identity, shared where it matches.** *(Identity accepted by the owner; the forms below proposed.)*
   - **With a session:** `(survey ref, session)`, where the survey ref is the id as written: a bare id (`civic-priorities`) or a named version (`civic-priorities-7`). Every occurrence with the same identity, in one program or across programs and revisions, shares one record.
   - **Without a session:** `(survey ref, model digest, ordinal)`, where the ordinal counts that survey ref's sessionless occurrences in evaluation order. It is private to the program (decision 4).
   - **Named versions** don't draw: the version is the ref. They still have identities, so a submission creates a record with its digest and retained content (decision 7). A later interpret of a frozen named record gets the retained content whenever the current file's digest differs or the file is gone. With no frozen record, a missing named version is today's "no survey" error.
   - **The kernel must evaluate deterministically,** so ordinals are stable. The Rust kernel evaluates a list, a record and a sequence one element at a time, in order (`languages/l0000/crates/core/src/eval.rs:246`, `:518`, `:563`). Slice 1 adds a test that pins it.
   - **Deliberate differences from today,** each pinned by its own test and listed in the gate:
     - one record per `(survey, session)`, not one slot per session: in `[civic "a", workplace "a", civic "a"]` both `civic` occurrences get the same version;
     - repeated sessionless occurrences of one id pick by ordinal (decision 4), so they can coincide where today they never do.

     Slice 2 lists every corpus case affected. The gate compares the rest exactly.
3. **Who may create, and who may submit.** *(Open, proposed.)*
   - **Create:** anyone whose interpret reaches an identity, including an anonymous viewer. Creating chooses nothing: the draw is the api's.
   - **Submit (freeze):** only the **owner** of the item the session names, as Policy's item authority reports it (`ownerUid` equals the caller's uid). **A public item does not authorize anyone else.** C5's public-capture exception covers thumbnail capture, not survey submission. A sessionless identity has no item, so it can be submitted only by a signed-in caller, and its record notes who.
   - **A response from anyone else is a read, not a submission.** It is interpreted against the current assignment and served, and nothing is frozen. The canonical submission is the owner's.
   - **Every answering path must carry the owner's uid.** Slice 0 verifies this for the console signed in, MCP signed in, MCP free plan, the claim flow and REST. A path that doesn't can't submit until it does, and is listed for the owner.
4. **A program without a session.** *(Open.)* Proposed: a **stateless** pick per occurrence, candidate index `sha256(model digest, survey ref, ordinal) mod n`. It writes nothing until a submission (decision 7), and never balances: with no respondent there is nothing to balance. Alternatives: refuse a bare program (slice 0 counts existing ones), or keep a record per identity from the first read.
5. **Balancing a draw.** *(Open.)* Proposed: today's draw without replacement, made durable. The taken set is one `l0182-draw-cycles/<survey id>` document, updated in the same transaction as the assignment. Every first assignment of a survey writes it, within Firestore's ~1 write/s per document, far above L0182's traffic. Alternatives: a uniform random pick, or least-assigned counts.
6. **Stable across revisions, of the item and of the survey data.** *(One open sub-choice.)*
   - **A new program for the same item** has the same identity, so the same record.
   - **A release removes the assigned version:** reassigned only if not frozen, by a fresh draw in the same transaction. If frozen, the retained content is used.
   - **A release changes the assigned version's content under the same name** (its digest differs). *Open.* Proposed: if not frozen, keep the version and move to the new digest, since nobody has answered against the old one. If frozen, use the retained content.
7. **Submission freezes durably before it is acknowledged.** *(Follows from the design and the review.)*
   - **What submission is:** an interpret, by a caller allowed to submit (decision 3), whose result carries an error-free `response` for an identity. L0182 has no submit action: a response is code.
   - **The api holds the result until every identity it submits is frozen.** For all of them, in **one** Firestore transaction:
     - each record must still hold exactly the version and digest the interpret used;
     - it is set `frozen`, with `submittedAt`, the task id and the submitter;
     - the version's content is written to `l0182-survey-models/<digest>`. If a model already exists under that digest it must be byte-identical; otherwise the freeze fails.
   - **Outcomes:**
     - **Committed,** or every record already frozen with the same version and digest (an idempotent retry): the result is served.
     - **A record changed** after the interpret read it (a concurrent reassignment or freeze): the api runs the stage again from the get-or-create, at most 3 times, then fails it with the temporary `assignment-contended`. The result is not served.
     - **Item authority unavailable,** or Firestore unavailable: the temporary `item-authority-unavailable` or `assignment-unavailable`. The result is not served, and the caller retries. There is never an unfrozen success for an owner's submission.
     - **The caller may not submit:** served as a read (decision 3), with nothing frozen.
   - **From then on,** a frozen record never changes. If the current candidates still include its digest, the language uses that content. If not, the api passes the retained content in the table.
   - **How long:** answers are task code, and tasks are kept forever, so retained models are kept forever. (Owner to confirm.)
8. **L0182 results are never cached.** *(Follows from the review.)*
   - Declare `0182` with `cacheCaps { evaluate: "private", present: "private" }` and `getOrCreate: true` (manifest v11).
   - `sharable` never stores or reads a `private` result, so every L0182 read runs its get-or-create and interprets. No stage-cache hit is expected, and the canary checks that none is written. By C3's routing rule a `private` chain is sent `no-store`.
   - A per-viewer private cache is out of scope. If latency ever needs one, it is its own design.
9. **A new generation: `COMPILE_GENERATION_L0182=interp-1`.** Legacy `compiles/` entries under `rust-1` are never served under `interp-1`. The backfill carries what they recorded into the store first.
10. **Backfill, with a cutover boundary.** *(Open: the rules below are proposed.)*
    - **Why it is needed.** Once `interp-1` is active, an item answered under `rust-1` is interpreted afresh. With no record its identity would draw anew, and its response could fail against the new version.
    - **Source.** Each `tasks/<id>` with `lang` 0182 and its `compiles/<id>` under `rust-1`, re-evaluated offline with the legacy compiler's own record (`instance` per occurrence). From those: identity, version, whether there is an error-free response, and `lastCompile`.
    - **Authority before submission.** A historical response counts as a **submission** only if:
      - item authority names the session's item with an owner, `ownerUid`;
      - and the console recorded that task in the owner's own history: `users/<ownerUid>/versions/<session>__<taskId>` exists.

      Otherwise it is a draw, not a submission. Sessionless responses have no item, so they are draws. Slice 0 measures how much history the version records cover.
    - **Rule per identity:**
      - **one version across its authorized submissions:** that version, **frozen**, with content retained from the current data (unchanged since 2026-09-22; an older compile is listed for review instead);
      - **no authorized submission:** the latest compile's version, **not frozen**, so what the respondent saw last doesn't change at cutover;
      - **authorized submissions that drew different versions** (today's process-local loss): **unresolved**.
    - **Unresolved records never fall through to a draw.** An interpret that reaches one fails with the permanent `assignment-under-review`. The owner resolves each one with `scripts/c4-resolve-assignment.js`, choosing its version and frozen state, or leaves it blocked.
    - **Who writes the store, and when.** Until activation, only the backfill writes it, since the flag-off api never touches it. So backfill records stay mutable until then. Each pass upserts by identity and records its watermark: the latest `lastCompile` it covered.
    - **Catch-up.** `--catchup` processes the compiles whose `lastCompile` is past the last watermark (`compiles/` is append-once per task, and a reused compile moves `lastCompile`). It applies the same rules to the existing records:
      - an unfrozen record moves to a later draw, or freezes on a later authorized submission;
      - a frozen record with a later authorized submission of another version becomes unresolved.

      Run it as often as needed until the delta is small.
    - **The cutover window.** Legacy draws continue until promotion, so the last window, from the last catch-up to promotion, is closed in two steps:
      - the api reads a control document, `l0182-cutover/state`, re-read at most every 10 s. While it says `reconciling`, an identity with **no record** fails with the temporary `assignment-reconciling` instead of drawing. Identities with records, and frozen ones, are served normally;
      - after promotion, `rust-1` compiles stop. A final `--catchup --final` covers the window, then sets the document to `done`. New identities then draw.

      So no live draw can race a legacy one. The cost is that brand-new sessions get a retryable error for the minutes between promotion and the end of the final catch-up.
    - **The activation gate:** before staging, zero unresolved records, or each remaining one decided by the owner (resolved, or kept blocked). The final catch-up's report must be reviewed. A record it newly marks unresolved stays blocked until decided.
    - **Mechanics.** `scripts/c4-backfill-assignments.js` is `--dry-run` by default and writes a report: counts, unresolved, authority misses, and pre-2026-09-22 compiles. Its writes carry the script's attribution. It reads the console's item store and versions read-only. It is a live production write, run only with the owner's approval.
11. **Rollback restores today's semantics, defect included.** *(Owner to accept.)*
    - With `INTERPRETER_L0182` off, `/compile` draws per process again and ignores the store. Records are kept.
    - Turning the flag back on needs a new catch-up over the legacy window since rollback, with the same reconciling step, because answers given under `rust-2` aren't in the store.

## 3. The kernel (`languages/l0000/crates`)

- **`/interpret` accepts an optional `assignments` table** (identity → assigned `{ instance, digest, content? }`), which reaches `Dialect::interpret` as a new argument.
- **A dialect may answer `needsAssignment`** instead of a result: a `Compilation` variant carrying the requests, written by the server as `{ status: 200, needsAssignment: [...] }`. A dialect that never uses it produces byte-identical envelopes.
- **`/compile` is untouched.**
- **Tests:**
  - dialects that don't use either are byte-identical (L0000 corpus);
  - a fake dialect's two-call exchange round-trips;
  - evaluation order is deterministic: the same program gives the same ordinals in repeated runs and inside `map` and `filter`.
- **Release:** only `l0182r` needs the new kernel.

## 4. L0182 (`languages/l0182/crates`)

- **A new `SurveySource`, `Assigned`,** used only by `interpret`. It looks each occurrence's identity up in the table. A hit serves that content: from the candidates by digest, or the retained content the api passed. A miss records a request with every candidate, and the occurrence stands in `{}` so evaluation goes on. A named version is a request with one candidate. A sessionless occurrence uses the stateless pick (decision 4) and is reported only so it can be submitted.
- **`/compile` is unchanged**, process-local draw included: the legacy and rollback path.
- **The backfill's evaluator:** a library function that re-runs a stored program with `Files`'s legacy semantics and reports `instance` per occurrence and identity. The backfill script calls it through a small CLI.
- **`crates/core/tests/interpret.rs`, the correctness gate,** over every conformance case:
  - the exchange ends in at most 2 calls for every case;
  - interpreting with the table that `Files::installed(|_| 0)` would have produced equals the compile, in both modes, except the listed deliberate differences (decision 2), each with its own test;
  - with the version removed from the candidates, a retained copy validates a response exactly as the original did, for a bare id and a named version;
  - an input-dependent `session-id` produces a request with the runtime identity.
- **Fix `languages/l0182/CLAUDE.md`:** it still says production runs the TypeScript, and lists the durable memory as not built.

## 5. The api

- **The manifest (v11):** declare `0182` (decision 8). It stays inert until the flag is on.
- **`packages/api/src/assignments.js`** (new), used by `interpret.js` for any declaration with `getOrCreate`, never by language number:
  - **`resolve(requests, { authority })`:** one transaction over the identities' records and the draw cycles they touch. A frozen record is returned with retained content when needed. A valid unfrozen one is returned or updated (decision 6). An unresolved one fails `assignment-under-review`. A missing one is created, unless the cutover document says `reconciling`.
  - **`submit(identities, { taskId, submitter, used })`:** the freeze of decision 7, one transaction, all or nothing.
  - **`retained(digest)`.**
- **`interpret.js`:** for an L0182 stage, run the exchange (decision 1); after an error-free result carrying responses from a caller allowed to submit (item authority, decision 3), submit before returning, with the retry and temporary errors of decision 7. No stage-cache read or write (decision 8).
- **`firestore.rules`:** `l0182-assignments`, `l0182-draw-cycles`, `l0182-survey-models` and `l0182-cutover` are server-only. Every access is a get by id, so no composite index is needed. Releases don't deploy `firestore.indexes.json`, so slice 3 confirms that with a read-only check.
- **Scripts:** `scripts/c4-backfill-assignments.js` and `scripts/c4-resolve-assignment.js` (decision 10). `scripts/lang-parity.js --interpreted` learns the exchange, and sends the deterministic table for L0182 cases.
- **Tests (emulator, `--runInBand`):**
  - concurrent first reads of one identity produce one record; a "restart" (fresh module state) returns it; a revision keeps it;
  - several surveys and sessions in one program get one record per identity, shared where identities match;
  - an owner's error-free response freezes every identity in one transaction before the result returns;
  - a non-owner's response, on a private **or public** item, is served and freezes nothing;
  - item authority unavailable → `item-authority-unavailable`, not served, nothing frozen;
  - a record changed between interpret and freeze → retried, then `assignment-contended`; never a served, unfrozen submission;
  - a retained model that exists with different bytes fails the freeze;
  - a removed version reassigns when unfrozen and serves retained content when frozen, for a bare id and a named version;
  - changed content under the same name follows decision 6;
  - an unresolved record fails `assignment-under-review` and never draws;
  - `reconciling` refuses only identities with no record;
  - no stage-cache entry is written for L0182;
  - with the flag off, nothing reads or writes the store.

## 6. Release order, activation and rollback

Every step is a separate approval. Nothing below is approved by this plan.

0. **Inventory** (read-only, production):
   - L0182 tasks, identities, multi-survey and sessionless programs, named versions, answered identities and conflicting draws;
   - how far the console's version history covers answered tasks;
   - which answering paths carry the owner's uid (decision 3).
1. **The kernel and `l0182r`** (slices 1 and 2) released together. `/compile` is unchanged, so this needs no api floor. Canary: legacy L0182 output identical.
2. **The api with the flag off** (slice 3): inert.
3. **The floor.** Add an api milestone `c4-assignments` to `deploy.json`'s baselines, and `requires` on `l0182r`. While `INTERPRETER_L0182` is on, neither can roll back below the exchange support.
4. **Backfill:** `--dry-run`, owner review; `--apply`; catch-up passes until the delta is small. Unresolved records go to the owner. Reports go to `docs/evidence/interpreter-c4-l0182/`.
5. **The activation gate:** unresolved records decided (decision 10), and the interpreted gate: `cargo test` on `interpret.rs`, and live `lang-parity.js --lang 0182 --interpreted --rust <l0182r>` with no difference beyond the listed deliberate ones.
6. **Stage.** Set `l0182-cutover/state` to `reconciling`, then stage an api with `INTERPRETER_L0182=on` and `COMPILE_GENERATION_L0182=interp-1`. Canary through the tag, with the canary account as owner of a test item:
   - a backfilled frozen item still compiles without errors, with its version;
   - an identity with no record gets `assignment-reconciling`;
   - nothing is served from `rust-1` entries, no stage-cache entry is written, and `/data` is `no-store`.
7. **Promote,** then run the final catch-up (`--final`), review its report, and set the document to `done`. Canary again:
   - two concurrent first reads of a new identity get one version, and a re-read returns it;
   - a program with two surveys and two sessions gets one record per identity;
   - the owner's response (a new task, same item) freezes before the answer returns, and the record shows it;
   - a non-owner's response on a public test item freezes nothing;
   - a named-version submission creates a frozen record with its retained model.

**Rollback:**
- **Activation:** set `INTERPRETER_L0182="off"` (by value) with a new generation (`rust-2`), as a forward release, or roll the api back to before activation, at or above the floor. Records are kept, and re-activation repeats the catch-up and reconciling steps for the legacy window (decision 11).
- **`l0182r`:** free while the flag is off, and refused by `requires` while it's on.
- **Backfill before activation:** records carry the script's attribution, so they can be listed and deleted. After activation, deleting records would reassign live items, so that needs its own decision.

## 7. Slices

1. **Kernel:** the assignment table, `needsAssignment`, and the evaluation-order test (§3).
2. **L0182:** `Assigned`, the stateless pick, the backfill evaluator, `interpret.rs`, the list of deliberate differences, the CLAUDE.md fix (§4).
3. **api:** manifest v11, `assignments.js`, `interpret.js`, rules, the parity tool, tests (§5).
4. **Backfill and resolve scripts,** with emulator tests for every rule in decision 10: authority, catch-up, unresolved, reconciling, `--final`.
5. **Evidence:** the inventory, backfill and catch-up reports, owner decisions on unresolved records, the gates and canaries, in `docs/evidence/interpreter-c4-l0182/`.

Slices 1 to 4 are code PRs. Each live step in §6 is a separate approval.

## 8. Out of scope

- Aggregating responses, an interactive flow, survey authoring, or enforcing one response per person (all L0182 "Not built yet", unchanged).
- Reading surveys from anywhere but the embedded files. `SurveySource` stays the seam.
- Commands: an assignment and its freeze are a declared `get` with no external effect or business transaction (design §12), so no Policy admission, Broker or command record is involved.
- A private stage cache (decision 8).
- The MCP server's deleted-proxy tools (`open_survey`, `answer_survey`).

## 9. Risks

- **An answering path without the owner's uid** can't submit until it's fixed (decision 3). Slice 0 finds such paths before activation.
- **Gaps in the console's version history** turn real historical answers into draws, which are not frozen. Slice 0 measures them. A gap the owner can't accept needs another source of authority before backfill.
- **Unresolved records** block their items with `assignment-under-review` until the owner decides them.
- **The reconciling window** gives brand-new sessions a retryable error for minutes after promotion.
- **The hot draw-cycle document,** if traffic grows (decision 5).
- **Firestore or item authority outages** now fail L0182 reads or submissions that today succeed with a local draw. That is the price of durability, and each error is temporary and names it.
- **Rollback re-exposes today's defect** for items answered while the flag is off, and re-activation needs another catch-up (decision 11).
