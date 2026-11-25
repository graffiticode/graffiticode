# C4: L0182 on the interpreter, with a durable survey assignment

**Status:** draft, revised after the owner's third review (2026-11-25). Nothing in it is implemented or live. The owner accepted the api as where assignment runs and `(survey, session)` as its identity. The other decisions in §2 are proposals, and each one marked **open** needs the owner's choice before its slice starts. Plan item: `docs/graffiticode-interpreter-plan.md` Track C, item 4 ("the durable get-or-create assignment (atomic, stable across revisions, frozen on submission), plus keeping the survey model that answers were given against"). Design: `docs/graffiticode-interpreter-design.md` §12 Phase 3 (the "L0182 version draws" bullets), §12 test 7, and open question 7 in §13.

**What the review changed:**
1. Submission is acknowledged only after its freeze commits, and an unavailable authority check or a lost freeze is a temporary error (decision 7).
2. A public item no longer authorizes submission, and the backfill establishes authority before treating a historical response as a submission (decisions 3 and 10).
3. The backfill has a cutover boundary: catch-up passes, a reconciling window at promotion, and an activation gate for unresolved records (decision 10).
4. Assignment is resolved per occurrence at run time, so several surveys and sessions in one program work, and an input-dependent session keeps a durable record (decisions 1 and 2).
5. Named versions get a submission record and retained content (decision 2).
6. L0182 results stay uncached: no stage-cache hit is expected (decision 8).

**What the second review changed:**
1. Reconciling is a write barrier. Every live write transaction reads the cutover state and refuses unless it is `done`, so no creation, reassignment or submission happens while reconciliation can still rewrite records. Old api revisions are drained and retired before the final catch-up (decision 10).
2. The backfill uses only recorded evidence: the saved output's survey records, and the console's version history for order and authority. It never re-runs a draw. Anything it can't demonstrate is unresolved, and `lastCompile` is used only to find changed documents, never as a time (decision 10).
3. During discovery an unassigned survey is an explicit **pending** value, not `{}`. Anything that depends on it is suspended, so no request is made for a survey the resolved program never reaches. Exchanges are bounded by progress, not by a fixed four calls (decision 1, §3).
4. An identity is reported even with zero current candidates, so a removed named version still finds its frozen content (decision 2).
5. An isolated canary namespace exercises creation, owner submission and non-owner refusal on the staged revision while production stays fenced (decision 12).

**What the third review changed:**
1. Evidence whose identity can't be recovered quarantines its **task**. The api checks the quarantine before assignment resolution, answers `assignment-under-review`, and creates nothing until the task is resolved or migrated (decision 10).
2. Suspension also covers variables a suspended subtree could have set, and success requires that nothing was left unresolved anywhere in the run, even in a value a sequence discards (decision 1, §3).

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
     - **An identity missing from the table** doesn't draw. The language records a **request**: the identity, the occurrence's ordinal, and every current candidate version as `{ instance, digest, content }`, possibly none (decision 2). The digest is the SHA-256 of the file's exact bytes.
     - **The occurrence evaluates to `pending`, never to a stand-in value.** `pending` may be placed in a list or record, but anything that inspects it is **suspended**, not evaluated: a condition, a filter or map predicate, an arithmetic or string operation, a lookup, or computing another survey's `id` or `session-id` (§3). A suspended expression is itself `pending`, so neither branch of a conditional on it runs, and no survey inside it is reached or requested.
     - Every request is therefore for a survey that the resolved program reaches too. The control decisions that led to it depended only on resolved values, which are the same in the final call.
     - **Suspension covers variables too.** A suspended subtree may hold a `set-var` that would have run. So every variable it could assign reads as `pending` afterwards: the literal names of its `set-var`s, or **every** variable if any of its `set-var` names is computed or it applies a user-defined function. A later `get-var` of such a variable is `pending`, and anything depending on it is suspended in turn. That prevents a request built from a value the resolved program would have overwritten.
     - **Success means nothing was left unresolved anywhere.** The run counts every miss and every suspension, including ones whose value a sequence discards (`pending` followed by another expression) or a record drops. If either count is non-zero the language answers `needsAssignment: [requests]` with no result, whatever the final value is. The api resolves every request (decision 5), then calls `/interpret` again with the fuller table.
     - **Bounded by progress, not by a fixed count.** Each call must add at least one identity to the table, or the stage fails `assignment-stalled`. There is a ceiling of 16 calls, past which it fails `assignment-depth`. A program that compiles today with a dependency chain deeper than the ceiling would newly be refused. That is a compatibility question for the plan's invariant, not a limit to accept silently: slice 0 measures the deepest chain in production programs, slice 2 in the corpus, and any program over the ceiling is named and handled before activation (raising the ceiling for it, or migrating it).
   - **Why this shape:**
     - Identities computed at run time (an input-dependent `session-id`, several surveys, surveys inside `map`) get durable records like literal ones.
     - The language never draws, so interpretation is a pure function of model, input and table.
   - **Exposure:** a request carries the candidates' content to the api, never to a client. Anyone can already compile `survey [id "civic-priorities-7"]` and read version 7. Slice 3 confirms that no api route returns a request or a model to a client.
2. **Identity, shared where it matches.** *(Identity accepted by the owner; the forms below proposed.)*
   - **With a session:** `(survey ref, session)`, where the survey ref is the id as written: a bare id (`civic-priorities`) or a named version (`civic-priorities-7`). Every occurrence with the same identity, in one program or across programs and revisions, shares one record.
   - **Without a session:** `(survey ref, model digest, ordinal)`, where the ordinal counts that survey ref's sessionless occurrences in evaluation order. It is private to the program (decision 4).
   - **Named versions** don't draw: the version is the ref. They still have identities, so a submission creates a record with its digest and retained content (decision 7).
   - **An identity is reported even with zero current candidates:** a named version whose file is gone, or a bare id whose every version is gone. The request carries the identity and an empty candidate list, and the api answers from the record:
     - a frozen record → its retained content, so the response still renders and validates;
     - otherwise (no record, or an unfrozen record with nothing to draw from) → today's "no survey" error, with today's wording. Only an identity without retained content gets it.

     A frozen named record whose file still exists but whose digest differs gets the retained content too.
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
    - **Evidence, never reconstruction.** A stored compile holds the final output, not a trace of every occurrence, and a `refresh` can overwrite it (`packages/api/src/storage/compile.js`, `overwrite`). Re-running `Files` can't recreate the original random choices or process memory. So the backfill only **extracts** what the saved output demonstrates:
      - each survey record in the output carries `instance`, `sessionId` (when there was one) and its own `response`. The identity is `(survey ref, session)`: the survey ref is the program's literal `id` for that occurrence. A bare ref is confirmed by `instance` being `<ref>-<n>`, a named one by `instance` equalling the ref;
      - an output record is matched to a program occurrence only when the match is unique (the literal `id` and `session-id` of exactly one occurrence fit it);
      - **unrecoverable:** an occurrence whose survey doesn't appear in the output (consumed by a computation, or dropped by `PROG` taking the last expression), whose `id` or `session-id` isn't a literal, or whose match is ambiguous. Such an identity is **unresolved**, never guessed.
    - **Chronology from records that keep it.** `lastCompile` moves on every cache read (`compileGet`) and `firstCompile` survives a refresh, so neither says when the stored output was produced. The backfill orders evidence only by the console's version history `createdAt` (when the owner saved that task to the item). Where several pieces of evidence for one identity disagree and the history can't order them, the identity is unresolved. `lastCompile` is used only to **find** documents that may have changed since a pass (the catch-up's selector), never as a time.
    - **Authority before submission.** A historical response counts as a **submission** only if:
      - item authority names the session's item with an owner, `ownerUid`;
      - and the console recorded that task in the owner's own history: `users/<ownerUid>/versions/<session>__<taskId>` exists.

      Otherwise it is a draw, not a submission. Sessionless responses have no item, so they are draws. Slice 0 measures how much history the version records cover.
    - **Rule per identity:**
      - **every authorized submission shows one version:** that version, **frozen**, with content retained from the current data (unchanged since 2026-09-22; evidence that may predate it is listed for review instead);
      - **no authorized submission, and every demonstrated draw shows one version:** that version, **not frozen**, so what the respondent saw doesn't change at cutover;
      - **no authorized submission, and draws that disagree:** the version of the latest **owner-saved** task by version history, not frozen; if the history can't order them, unresolved;
      - **authorized submissions that show different versions** (today's process-local loss): **unresolved**;
      - **any unrecoverable occurrence** for the identity: **unresolved**.
    - **When the identity itself can't be recovered, the task is quarantined.** For a computed `session-id`, or an `id` whose survey is absent from the saved output, the extractor can't name a `(survey, session)` key at all. An assignment-level record can't block that: at run time the api would find no record under the key the program computes, and draw afresh. So the backfill writes `l0182-task-quarantine/<taskId>`, with the reasons and the evidence it did find.
      - **Checked first.** `resolve` reads the quarantine for the stage's task in the same transaction, **before** any record lookup or creation. A quarantined task answers `assignment-under-review`, writes nothing, and makes no request to the language beyond the first discovery call. Submission checks it too.
      - **Until it is lifted:** by `scripts/c4-resolve-assignment.js --task <id>`, which records the owner's decision. Either supply the identities and versions it should have (written as resolved records, frozen or not), or mark it migrated: the owner accepts that it will draw fresh.
      - The quarantine is task-level because nothing finer is knowable. A new task for the same item (a later revision) isn't quarantined: its identities come from its own program at run time. If its identities can be recovered from its own saved output, they are backfilled normally.
    - **Unresolved records never fall through to a draw.** An interpret that reaches one fails with the permanent `assignment-under-review`. The owner resolves each one with `scripts/c4-resolve-assignment.js`, choosing its version and frozen state, or leaves it blocked.
    - **Two writers, never at once.** The control document `l0182-cutover/state` is `backfill` (the initial state), `reconciling` or `done`.
      - **Every write transaction reads it inside the transaction.** The backfill and resolve scripts write only while it is `backfill` or `reconciling`. The api writes (creation, reassignment, a draw-cycle update, a freeze) only while it is `done`. A state change commits through a transaction too, so a writer whose transaction overlaps the change is retried by Firestore and then sees the new state. No cached copy of the state ever authorizes a write.
      - Before `done`, backfill records stay mutable, and each pass upserts by identity.
    - **Catch-up.** `--catchup` re-reads every `compiles/` document whose `lastCompile` has moved since the previous pass, and every version-history entry created since then. That selects new results, refreshed results and reused ones alike; a reused one simply yields the same evidence. It re-extracts the evidence (above) and re-applies the rules per affected identity:
      - an unfrozen record follows the evidence;
      - a frozen record that the evidence now contradicts becomes unresolved.

      Run it as often as needed until the delta is small.
    - **The cutover is a write barrier, not just a refusal of new draws.** From the moment the state is `reconciling` until it is `done`, the api in production:
      - **reads** existing records (frozen ones serve their version; unfrozen ones serve theirs as a read);
      - **refuses every write** with the temporary `assignment-reconciling`: creating an identity, reassigning one, and **every submission**. A response from the owner is not acknowledged, because the final catch-up could still rewrite or unresolve the record it would freeze.
      - Refusals are enforced by the transaction's own read of the state (above), not by a cached flag, so no write can slip in at the boundary.
    - **Draining legacy writers before the final catch-up.** Promotion moves traffic, but in-flight requests on older api revisions, and any revision still reachable by tag, can keep writing `rust-1` compiles. So after promotion:
      1. retire every older api revision's tag and traffic (`npm run deploy -- retire`), leaving only the promoted revision reachable;
      2. wait at least the api's request timeout (300 s) plus a margin after the last older revision stopped receiving traffic;
      3. confirm from the api's logs that no `rust-1` L0182 compile has completed after that point;
      4. run `--catchup --final`. It covers every document changed up to the confirmed drain time, then sets the state to `done` in the same transaction as its last write.

      `l0182r`'s own `/compile` writes nothing to `compiles/`, since only the api stores compiles, so it needs no drain.
    - **The activation gate:** before staging, zero unresolved records, or each remaining one decided by the owner (resolved, or kept blocked). The final catch-up's report is reviewed **before** the state is set to `done`. A record it newly marks unresolved stays blocked until decided; it never falls through to a draw.
    - **Mechanics.** `scripts/c4-backfill-assignments.js` is `--dry-run` by default and writes a report: counts, unresolved and unrecoverable identities with reasons, authority misses, and evidence that may predate 2026-09-22. Its writes carry the script's attribution. It reads the console's item store and versions read-only. It is a live production write, run only with the owner's approval.
11. **Rollback restores today's semantics, defect included.** *(Owner to accept.)*
    - With `INTERPRETER_L0182` off, `/compile` draws per process again and ignores the store. Records are kept.
    - Turning the flag back on needs a new catch-up over the legacy window since rollback, with the same reconciling step, because answers given under `rust-2` aren't in the store.
12. **An isolated canary namespace.** *(Proposed.)*
    - **Why:** while production is fenced in `reconciling`, the staged revision can't create or submit there. Yet creation, owner submission and non-owner refusal must be exercised on that revision **before** it is promoted.
    - **How:** the api routes a fixed set of identities to separate collections (`l0182-canary-assignments`, `-draw-cycles`, `-survey-models`, `-cutover`), with their own cutover state, set to `done` from the start. The set is the sessions named in `L0182_CANARY_SESSIONS`, api configuration in `deploy.json`: test items owned by the canary account, one private and one public. A program's text can't choose a namespace. A stranger naming a canary session only reaches the isolated canary records, where the owner-only freeze still applies.
    - **Non-owner checks** use the verify account (a second signed-in account with no connections).
    - The canary sessions stay in the canary namespace after promotion, so the scheduled canary never writes production records.

## 3. The kernel (`languages/l0000/crates`)

- **`/interpret` accepts an optional `assignments` table** (identity → assigned `{ instance, digest, content? }`), which reaches `Dialect::interpret` as a new argument.
- **A dialect may answer `needsAssignment`** instead of a result: a `Compilation` variant carrying the requests, written by the server as `{ status: 200, needsAssignment: [...] }`. A dialect that never uses it produces byte-identical envelopes.
- **A `pending` value, and suspension** (decision 1). The evaluator gains `Value::Pending`, produced only by a dialect. Structural operations (building a list or record, binding a name) carry it unchanged. Every other operation that receives it, including `if`, `case`, `map`, `filter`, `reduce`, comparisons, arithmetic, string and record lookups, and a dialect's own words, returns `pending` without running its body or branches. A result containing `pending` is never written as data: the server answers `needsAssignment`, or, if the dialect raised no request, an internal error, which a test forbids.
- **`/compile` is untouched.**
- **Tests:**
  - dialects that don't use either are byte-identical (L0000 corpus);
  - a fake dialect's two-call exchange round-trips;
  - evaluation order is deterministic: the same program gives the same ordinals in repeated runs and inside `map` and `filter`;
  - **suspension:** a conditional, `case`, `filter` and `map` on a `pending` value run neither branch nor body; a value computed from `pending` is `pending`; `pending` inside a list survives to the end and yields `needsAssignment`;
  - **a suspended conditional that would set a variable used later:** `if <pending> then set-var "s" "a" else set-var "s" "b"`, then a survey whose `session-id` is `get-var "s"`. The later survey is suspended, not requested with a stale or undefined session. The same with a computed `set-var` name, and with a user function that sets a variable;
  - **a discarded `pending`:** a sequence whose first expression is `pending` and whose last is a plain value yields `needsAssignment`, never success;
  - in every one of these, the requests raised are only for reached, unsuspended occurrences, so no speculative assignment can be created from them.
- **Release:** only `l0182r` needs the new kernel.

## 4. L0182 (`languages/l0182/crates`)

- **A new `SurveySource`, `Assigned`,** used only by `interpret`. It looks each occurrence's identity up in the table. A hit serves that content: from the candidates by digest, or the retained content the api passed. A miss records a request with every current candidate (possibly none) and evaluates to `pending`. A named version is a request with its one candidate, or none if its file is gone. A sessionless occurrence uses the stateless pick (decision 4) and is reported only so it can be submitted. An `id` or `session-id` that is itself `pending` suspends the occurrence (no request yet).
- **`/compile` is unchanged**, process-local draw included: the legacy and rollback path.
- **The backfill's extractor:** a library function that takes a stored program and its saved output, lists the program's literal survey occurrences, matches output survey records to them uniquely (decision 10), and reports per identity: demonstrated version, response present and error-free, or unrecoverable with the reason. It never draws and never evaluates a survey. The backfill script calls it through a small CLI.
- **`crates/core/tests/interpret.rs`, the correctness gate,** over every conformance case:
  - the exchange ends, with progress on every call, for every case, and the deepest chain is reported;
  - **branching:** a survey under a condition on another survey's content is requested only once that content is assigned, and only on the branch taken; a `filter` over surveys and a `session-id` computed from a survey suspend as specified; a survey in an untaken branch is never requested;
  - **zero candidates:** a removed named version and a removed bare id each produce a request with no candidates; with retained content they render and validate, and without it they give today's "no survey" message;
  - interpreting with the table that `Files::installed(|_| 0)` would have produced equals the compile, in both modes, except the listed deliberate differences (decision 2), each with its own test;
  - with the version removed from the candidates, a retained copy validates a response exactly as the original did, for a bare id and a named version;
  - an input-dependent `session-id` produces a request with the runtime identity.
- **Fix `languages/l0182/CLAUDE.md`:** it still says production runs the TypeScript, and lists the durable memory as not built.

## 5. The api

- **The manifest (v11):** declare `0182` (decision 8). It stays inert until the flag is on.
- **`packages/api/src/assignments.js`** (new), used by `interpret.js` for any declaration with `getOrCreate`, never by language number:
  - **`resolve(requests, { authority, taskId })`:** one transaction over the namespace's cutover state, the task's quarantine, the identities' records and the draw cycles they touch. A quarantined task fails `assignment-under-review` before anything else is read or written. A frozen record is returned with retained content when needed. A valid unfrozen one is returned, or updated if the state is `done` (decision 6). An unresolved one fails `assignment-under-review`. A missing one is created only if the state is `done`; otherwise `assignment-reconciling`. An identity with zero candidates follows decision 2.
  - **`submit(identities, { taskId, submitter, used })`:** the freeze of decision 7, one transaction, all or nothing, which also reads the cutover state and refuses unless it is `done`.
  - **The namespace** (production or canary, decision 12) is chosen from the identity's session and the api's configuration, before any read.
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
  - **task quarantine:** a task whose program computes its `session-id`, and whose survey is absent from the saved output, is quarantined by the backfill. At run time it answers `assignment-under-review` and creates no record and no draw-cycle entry, though the computed key has no record. Lifting it (resolve or migrate) lets it run; another task for the same item isn't affected;
  - **the write barrier:** while `reconciling`, creation, reassignment and every submission are refused, and reads of existing records are served; a state change racing a write transaction makes the write retry and then refuse; the scripts can't write once the state is `done`;
  - **the canary namespace:** canary sessions read and write only the canary collections, under their own state; no other session reaches them; a program can't choose the namespace;
  - no stage-cache entry is written for L0182;
  - with the flag off, nothing reads or writes the store.

## 6. Release order, activation and rollback

Every step is a separate approval. Nothing below is approved by this plan.

0. **Inventory** (read-only, production):
   - L0182 tasks, identities, multi-survey and sessionless programs, named versions, answered identities and conflicting draws;
   - how many identities the saved outputs can't demonstrate (unrecoverable), and the deepest survey-dependency chain in any production program;
   - how far the console's version history covers answered tasks;
   - which answering paths carry the owner's uid (decision 3).
1. **The kernel and `l0182r`** (slices 1 and 2) released together. `/compile` is unchanged, so this needs no api floor. Canary: legacy L0182 output identical.
2. **The api with the flag off** (slice 3): inert.
3. **The floor.** Add an api milestone `c4-assignments` to `deploy.json`'s baselines, and `requires` on `l0182r`. While `INTERPRETER_L0182` is on, neither can roll back below the exchange support.
4. **Backfill** (state `backfill`): `--dry-run`, owner review; `--apply`; catch-up passes until the delta is small. Unresolved and unrecoverable identities go to the owner. Reports go to `docs/evidence/interpreter-c4-l0182/`.
5. **The activation gate:** unresolved records decided (decision 10), and the interpreted gate: `cargo test` on `interpret.rs`, and live `lang-parity.js --lang 0182 --interpreted --rust <l0182r>` with no difference beyond the listed deliberate ones.
6. **Stage.** Set the production state to `reconciling` (production is now fenced), then stage an api with `INTERPRETER_L0182=on` and `COMPILE_GENERATION_L0182=interp-1`. Canary through the tag.
   - **In the canary namespace** (state `done`, decision 12), the paths that write:
     - two concurrent first reads of a new identity get one version, and a re-read returns it;
     - a program with two surveys and two sessions gets one record per identity;
     - the owner's response (a new task, same item) freezes before the answer returns, and the record shows it;
     - a non-owner's response, on the private and on the public test item, is served and freezes nothing;
     - a named-version submission creates a frozen record with its retained model;
     - a conditional on a survey's content requests only the branch taken.
   - **In production** (fenced):
     - a backfilled frozen item still compiles without errors, with its version;
     - an identity with no record, and an owner's submission, each get `assignment-reconciling`, and nothing is written.
   - **Everywhere:** nothing is served from `rust-1` entries, no stage-cache entry is written, and `/data` is `no-store`.
7. **Promote,** then drain and retire the older api revisions (decision 10), run the final catch-up (`--final`), and review its report. The owner decides any newly unresolved record. Only then does the final catch-up set the state to `done`. Canary again in production: a new identity is created, and the canary namespace's checks still pass.

**Rollback:**
- **Activation:** set `INTERPRETER_L0182="off"` (by value) with a new generation (`rust-2`), as a forward release, or roll the api back to before activation, at or above the floor. Records are kept, and re-activation repeats the catch-up and reconciling steps for the legacy window (decision 11).
- **`l0182r`:** free while the flag is off, and refused by `requires` while it's on.
- **Backfill before activation:** records carry the script's attribution, so they can be listed and deleted. After activation, deleting records would reassign live items, so that needs its own decision.

## 7. Slices

1. **Kernel:** the assignment table, `needsAssignment`, `pending` and suspension, and the evaluation-order and suspension tests (§3).
2. **L0182:** `Assigned`, the stateless pick, the backfill extractor, `interpret.rs` (with branching and zero-candidate cases), the list of deliberate differences, the CLAUDE.md fix (§4).
3. **api:** manifest v11, `assignments.js` with the in-transaction write barrier and the canary namespace, `interpret.js`, rules, the parity tool, tests (§5).
4. **Backfill and resolve scripts,** with emulator tests for every rule in decision 10: evidence extraction and unrecoverable cases, task quarantine and its lifting, authority, chronology from version history, catch-up, unresolved, the state machine (`backfill` → `reconciling` → `done`), and `--final` refusing to run before the drain is confirmed.
5. **Evidence:** the inventory, backfill and catch-up reports, owner decisions on unresolved records, the gates and canaries, in `docs/evidence/interpreter-c4-l0182/`.

Slices 1 to 4 are code PRs. Each live step in §6 is a separate approval.

## 8. Boundary with network authorization

The network-authorization workstream (`docs/network-authorization-plan.md`, proposed in its own PR, from the proposed brief `docs/network-egress-authorization-design-brief.md`) is separate, and C4 neither waits for it nor absorbs it.

- **Embedded survey content.** The surveys are compiled into the binary (`crates/core/build.rs`). Interpreting, the exchange included, reads nothing from the network.
- **No public-fetch permission.** `l0182r` stays in the strict `compilers-default` class, whose only names are `api.graffiticode.org` and `auth.graffiticode.org` (token verification; `deploy/egress-proxy/production/network.json`). C4 adds no name, and needs no account allowlist entry and no capability.
- **Trusted platform storage and authority calls.** The api's assignment calls are platform operations, made under the api's own runtime identity:
  - Firestore reads and writes of the `l0182-*` collections, and of their canary counterparts;
  - Policy's item-authority lookup (decision 3), which reaches the console's internal route as Policy's identity.

  Their authority comes from the api's and Policy's service accounts, the Firestore rules (server-only) and the item-authority route's audience check. It is **not** account-controlled retrieval: no account's allowlist governs them, and no account setting can widen or narrow them. They belong in the network plan's inventory of platform endpoints, so that its enforcement keeps them reachable and never routes them through public retrieval.
- **No compiler decides them.** `l0182r` never chooses an account, never calls Firestore or Policy, and claims no capability. It only reports what it needs (`needsAssignment`), and the api decides.
- **If the network work changes the api's egress or Policy's route to the console,** the C4 tests in §5 (item authority unavailable is a temporary error, never a freeze) are the regression checks for that change.

## 9. Out of scope

- Aggregating responses, an interactive flow, survey authoring, or enforcing one response per person (all L0182 "Not built yet", unchanged).
- Reading surveys from anywhere but the embedded files. `SurveySource` stays the seam.
- Commands: an assignment and its freeze are a declared `get` with no external effect or business transaction (design §12), so no Policy admission, Broker or command record is involved.
- A private stage cache (decision 8).
- The MCP server's deleted-proxy tools (`open_survey`, `answer_survey`).

## 10. Risks

- **An answering path without the owner's uid** can't submit until it's fixed (decision 3). Slice 0 finds such paths before activation.
- **Gaps in the console's version history** turn real historical answers into draws, which are not frozen. Slice 0 measures them. A gap the owner can't accept needs another source of authority before backfill.
- **Unresolved records** block their items with `assignment-under-review` until the owner decides them.
- **The reconciling window** refuses every L0182 write, new sessions and submissions alike, with a retryable error from staging until the final catch-up after the drain: at least the 300 s drain plus the catch-up and its review. Staging and promotion should be close together, and announced if the window will be long.
- **Unrecoverable history.** Programs whose surveys don't appear in their saved output, or whose occurrences can't be matched uniquely, become unresolved, or quarantine their task when no identity can be named. Either way they block until the owner decides. Slice 0 measures how many.
- **Dependency depth.** A program deeper than the call ceiling would be newly refused. Slice 0 and slice 2 measure it before activation.
- **The hot draw-cycle document,** if traffic grows (decision 5).
- **Firestore or item authority outages** now fail L0182 reads or submissions that today succeed with a local draw. That is the price of durability, and each error is temporary and names it.
- **Rollback re-exposes today's defect** for items answered while the flag is off, and re-activation needs another catch-up (decision 11).
