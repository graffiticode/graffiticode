# C4: L0182 on the interpreter, with a durable survey assignment

**Status:** draft, aligned with respondent sessions (2026-11-25). Slice 0's evidence (#483) and the generic kernel exchange (#484) are merged. L0182 assignment, frontend attestation, API submission and migration work remain unimplemented and unapproved; this PR changes documents only. The owner accepted the api as where assignment runs and `(survey, session)` as the base identity shape. The other decisions in §2 are proposals, and each one marked **open** needs the owner's choice before its slice starts. No race option or migration classification is selected by this alignment. Plan item: `docs/graffiticode-interpreter-plan.md` Track C, item 4 ("the durable get-or-create assignment (atomic, stable across revisions, frozen on submission), plus keeping the survey model that answers were given against"). Design: `docs/graffiticode-interpreter-design.md` §12 Phase 3 (the "L0182 version draws" bullets), §12 test 7, and open question 7 in §13.

**What the review changed:**
1. Submission is acknowledged only after its freeze commits, and an unavailable authority check or a lost freeze is a temporary error (decision 7).
2. A public item no longer authorizes submission, and the backfill establishes authority before treating a historical response as a submission (decisions 3 and 10).
3. The backfill has a cutover boundary: catch-up passes, a reconciling window at promotion, and an activation gate for unresolved records (decision 10).
4. Assignment is resolved per occurrence at run time, so several surveys and sessions in one program work, and an input-dependent session keeps a durable record (decisions 1 and 2).
5. Named versions get a submission record and retained content (decision 2).
6. L0182 results stay uncached: no stage-cache hit is expected (decision 8).

**What the second review changed:**
1. Reconciling is a write barrier. Every live write transaction reads the cutover state and refuses unless it is `done`, so no creation, reassignment or submission happens while reconciliation can still rewrite records. Old api revisions are drained and retired before the final catch-up (decision 10).
2. The backfill uses only recorded evidence: saved-output survey records and version history for recorded save order and provenance, not proof of who called. Historical authority gaps need the decision described below. It never re-runs a draw, and `lastCompile` is used only to find changed documents, never as a time (decision 10).
3. During discovery an unassigned survey is an explicit **pending** value, not `{}`. Anything that depends on it is suspended, so no request is made for a survey the resolved program never reaches. Exchanges are bounded by progress, not by a fixed four calls (decision 1, §3).
4. An identity is reported even with zero current candidates, so a removed named version still finds its frozen content (decision 2).
5. An isolated canary namespace exercises creation, owner submission and non-owner refusal on the staged revision while production stays fenced (decision 12).

**What the third review changed:**
1. Evidence whose identity can't be recovered quarantines its **task**. The api checks the quarantine before assignment resolution, answers `assignment-under-review`, and creates nothing until the task is resolved or migrated (decision 10).
2. Suspension also covers variables a suspended subtree could have set, and success requires that nothing was left unresolved anywhere in the run, even in a value a sequence discards (decision 1, §3).

**What the fourth review changed:** quarantined tasks and unresolved records can be resolved after activation through an audited resolution transaction that is valid in `done`, with no global window (decision 10).

**Aligned with [respondent sessions](https://github.com/graffiticode/graffiticode-app/blob/2a58aaf9d84c02f3deb9947b777e9e169849a7a3/docs/respondent-sessions-proposal.md)** (merged as a draft at 2a58aaf9). The [slice 0 inventory](evidence/interpreter-c4-l0182/slice0-inventory.md) showed that a copied literal session isn't evidence of the respondent.
- **Submission compares full principals** (decision 3): the respondent principal comes from the console's `respondent-authority` lookup, which C4 alone consumes; the caller principal is built from the verified user token plus installation and workspace fields attested by a trusted frontend. Item authority is no longer the submission check, and stays as it is for C5.
- **Attestation** reaches the submission check through trusted frontend calls, including before I-2 is available (decision 3).
- **A claim or transfer racing a submission:** the authority revision that applies, and the semantics that remain unresolved, are stated (decision 7).
- **Historical answers:** current respondent authority doesn't prove who submitted them. The backfill keeps its recorded-evidence requirements, and the gaps are left to the migration decision (decision 10).
- **Sessionless handling and historical-copy resolution** stay proposed. Their classification is unchanged here.

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
- **The api calls `/interpret` with `{ model, input, mode, auth, options }`** (`packages/api/src/comp.js:38`), without an assignment table today. Generic kernel slice 1 now provides `interpret_assigned` and `needsAssignment`; the API exchange and L0182 integration remain unimplemented.
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
   - **Submit (freeze):** only a caller whose **full principal equals the session's respondent principal**.
     - **The respondent principal** comes from the console's `respondent-authority` lookup (`POST /api/internal/respondent-authority { session }`; respondent-sessions proposal §4.3). It answers a binding's principal, or, with no binding, the principal of the item whose id is the session. It can also answer `unknown` or `ambiguous`. C4's submission check is its only consumer.
     - **Item authority** (`/api/internal/item-authority`, used by Policy for C5 captures) is **not** the submission check, and stays unchanged.
     - **A public item does not authorize anyone else.** C5's public-capture exception covers thumbnail capture, not survey submission.
     - **`unknown` or `ambiguous`** means nobody may submit: the response is a read.
   - **Principals.** A principal is `{ kind: "user", uid, installation }` or `{ kind: "freePlan", uid, workspace, installation }`.
     - **Equality is over every field.** All free-plan workspaces share one backend uid, so a uid alone never matches a free-plan principal.
     - A free-plan record with a missing or invalid workspace answers `unknown`. It is never downgraded to a user principal.
   - **Where the caller's principal comes from: trusted frontend calls only.**
     - **`uid`** comes from the verified user token, as today.
     - **`installation` and `workspace`** come only as **attested fields** on the frontend's own service-authenticated call to the api. The frontend (console server, MCP server) proves its identity with `X-Caller-Identity`, a Google ID token for its service account, verified by the api. A free-plan workspace is attested only after the frontend has verified the caller's signed workspace token (`graffiticode-app` `packages/core/src/lib/free-plan-session-token.ts`).
     - The api accepts these fields only from a registered frontend identity, and never from a request body, a user token, the shared uid or the program.
     - On both `/compile` and `/data`, ingress constructs an immutable caller context. The route passes it through `getData` and pipeline/stage interpretation to `assignments.submit`; it is not reconstructed from the language's request or result. The frontend strips client-supplied attestation metadata before constructing its outbound call. The transport field names/schema remain part of the API/frontend protocol review; no existing public body field is promoted to trusted metadata.
     - The user token and frontend service identity are verified independently, with the service token's API audience checked as well as the frontend allowlist. The shared trial uid must match the configured free-plan account. A normal direct user-token-only request can identify its user within the existing Graffiticode boundary, but cannot attest a workspace. A supplied invalid service identity is refused rather than treated as absent.
   - **Before I-2 is available:**
     - the installation is `graffiticode` (I-3: absent means Graffiticode);
     - "registered frontend" means a fixed allowlist of the console's and the MCP server's service accounts in the api's configuration (`L0182_ATTESTING_FRONTENDS`);
     - the workspace attestation is still required: a free-plan caller with no attested workspace can't submit (temporary `respondent-unattested`), and is never matched by uid;
     - once I-2 ships, the allowlist is replaced by the installation registry, and the installation comes from it.
     - C4 is Graffiticode-only until installation-specific respondent endpoints and assignment namespaces are reviewed. The identity pair `(survey, session)` does not authorize sharing records between installations. This attestation work does not require or activate Track N's public-fetch enforcement.
   - **A response from anyone else is a read, not a submission.** It is interpreted against the current assignment and served, and nothing is frozen.
   - **Answering paths:** slice 0 audited them in code, and the respondent-sessions proposal sets their session rules. Whether each path's frontend attests the workspace and installation is checked in the api slice's tests (§5), not assumed.
   - **Sessionless identities and historical copies:** their handling stays **proposed**, and isn't reclassified here.
     - Decision 4 still governs sessionless programs. The respondent-sessions proposal blocks revisions of existing sessionless programs until that decision, or an explicit new response.
     - Historical copies (a session that isn't the holding item's id, with no binding) answer `unknown` or name another item's owner. Their resolution follows the proposal's explicit choices: continue through a proven rebinding, or start a new response.
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
     - **Respondent authority unavailable,** required attestation unavailable, or Firestore unavailable: the temporary `respondent-authority-unavailable`, `respondent-unattested` or `assignment-unavailable`. The result is not served, and the caller retries. Invalid credentials or forged attestations are refused at ingress; verification-service outages remain temporary. There is never an unfrozen success for an authorized principal's submission.
     - **The caller may not submit:** served as a read (decision 3), with nothing frozen.
   - **A claim or transfer racing a submission.** An attempt captures the full principal, installation, session, source item and the binding's `revision` n. The freeze retains this authority evidence and the original submitter; a later claim does not rewrite that attribution or the retained model. An unbound lookup needs the unique source item's version and an observed absence of a binding. Calling that absence revision 0 is not a version of the derived item authority; its first-binding/source-change fence is an unresolved part of the route contract.
     - **What applies is unresolved:** the selected option below must define when revision n authorizes the attempt. A pre-freeze lookup alone cannot promise that n is still current at commit. Bindings live in the console's Firestore (`graffiticode-app`), and assignments in the api's (`graffiticode`), so no single transaction covers both today. Two HTTP checks around the freeze do not create one.
     - **The window:** a rebinding that commits after the read and before the freeze could let the **previous** principal freeze. Because a continuation carries the same response, and the frozen record keeps the same assignment and survey model, the answers aren't lost. But authority over the freeze would be decided by a superseded revision.
     - **Unresolved; the owner decides before the api slice:**
       - **(a) Authority as of the check.** Explicitly admit an attempt under n for a bounded lifetime, even if a later rebind precedes its freeze. Bind that admission to its principal, installation, session and task/input. A post-commit re-read can flag a changed revision; that observation alone does not establish which commit came first and does not undo a freeze. The audit's ordering evidence, deadline and retry semantics still need design. This option permits an old principal's admitted work after a transfer; the owner must accept that behavior explicitly.
       - **(b) A fence held by the api.** A rebinding first takes a fence on S in the api's store, commits the binding, then releases it; the freeze reads the fence. The coordinated protocol must cover first binding, crashes, abandoned fences and late writers. Expiry cannot reopen submissions while a delayed rebinding can still commit. A short lease alone is not that proof.
       - **(c) Bindings stored where the freeze happens.** An authenticated continuation route writes the binding in the api's Firestore, so a freeze reading that record can be atomic with a binding change. This addresses binding/freeze ordering, but does not make the entire claim atomic: the source's read-only state, destination item, immutable operation result and history are currently console-project writes. Specify their coordinated commit/recovery and replay behavior, which store is authoritative, how the console's respondent-authority route reads it without a stale mirror, and how unbound item-derived authority is versioned or registered. The merged console proposal must be aligned before implementation; moving only the binding is not a complete continuation protocol.

       Proposed: (c), retaining an audit, subject to that protocol review and the owner's choice. None is selected. Tests must cover freeze before rebind, rebind before freeze, first binding, multi-session authority changes, retries and crash recovery. Only the chosen semantics determine whether an overlapping old-principal attempt may complete. The api slice waits for the choice and the reviewed protocol.
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
    - **Authority before submission: recorded evidence only.** Current respondent authority (a binding, or the item owner) says who may submit **now**. It does **not** prove who submitted a historical answer: stored compiles record no caller (slice 0, limitation 1). Preserve these evidence checks and report their results separately:
      - whether the session's item has a single, unambiguous holder;
      - whether the console recorded that task in that holder's history: `users/<uid>/versions/<session>__<taskId>`;
      - current respondent authority and any recorded continuation chain. A later claim can change the current principal without changing a previously demonstrated submitter; it does not make the earlier answer the claimant's submission.

      These are provenance checks, **not sufficient proof of a historical caller or submission**, even when all three agree. A historical submission needs contemporaneous server evidence tying the error-free response's task/session to a verified principal and its then-valid authority, or an explicit audited migration decision that retains the operator's attribution separately. A workspace is required for a free-plan principal. No current binding or shared uid fills that gap.

      Report authority gaps, including:
      - free-plan answers, since no workspace was ever recorded with an answer;
      - historical copies;
      - sessionless responses;
      - answers whose task isn't in any history.

      These **gaps are left to the migration decision**. Do not automatically label missing caller evidence as an unauthorized draw, freeze it, reset its assignment, synthesize a session/binding, or quarantine an otherwise recoverable identity. Preserve saved-output/version evidence and the existing extraction classification for review. Technical unrecoverability still follows the proposed rules below. Slice 0 found an owner-version-history **match** for 1 of 537 answered keyed tasks; that is not a demonstrated historical submitter. Its exclusion of L0182 below another chain's head also remains a coverage limit.
    - **Rule per identity, conditional on the owner's evidence/migration choice:** an unproven historical caller cannot silently enter the "no authorized submission" branch. The rules below apply only after that gap has been decided explicitly:
      - **every authorized submission shows one version:** that version, **frozen**, with content retained from the current data (unchanged since 2026-09-22; evidence that may predate it is listed for review instead);
      - **no authorized submission, and every demonstrated draw shows one version:** that version, **not frozen**, so what the respondent saw doesn't change at cutover;
      - **no authorized submission, and draws that disagree:** the version of the latest **owner-saved** task by version history, not frozen; if the history can't order them, unresolved;
      - **authorized submissions that show different versions** (today's process-local loss): **unresolved**;
      - **any unrecoverable occurrence** for the identity: **unresolved**.
    - **When the identity itself can't be recovered, the task is quarantined.** For a computed `session-id`, or an `id` whose survey is absent from the saved output, the extractor can't name a `(survey, session)` key at all. An assignment-level record can't block that: at run time the api would find no record under the key the program computes, and draw afresh. So the backfill writes `l0182-task-quarantine/<taskId>`, with the reasons and the evidence it did find.
      - **Checked first.** `resolve` reads the quarantine for the stage's task in the same transaction, **before** any record lookup or creation. A quarantined task answers `assignment-under-review`, writes nothing, and makes no request to the language beyond the first discovery call. Submission checks it too.
      - **Until it is lifted:** by `scripts/c4-resolve-assignment.js --task <id>`, which records the owner's decision. Either supply the identities and versions it should have (written as resolved records, frozen or not), or mark it migrated: the owner accepts that it will draw fresh.
    - **Resolving after activation: an audited resolution transaction.** Quarantined tasks and unresolved records can outlive activation, so their resolution can't depend on reopening a reconciling window, which would fence every L0182 write in production. Instead, `c4-resolve-assignment.js` resolves **one** task or identity in a single transaction that is safe alongside live traffic in `done` (and equally before it):
      - **Its preconditions,** all read inside the transaction:
        - the quarantine document, or the unresolved record, still exists with exactly the content the owner reviewed (its hash is part of the decision);
        - for every identity the decision writes, the key has **no live record**, or the record is the unresolved one being resolved. A live record means the api already created or froze one, for example for another task computing the same key. The transaction then refuses, reports it, and the owner decides again, either adopting the live record or quarantining further. It never overwrites a live record;
        - for a frozen decision, the content of the chosen version is retained under its digest, byte-identical if it already exists.
      - **Its writes, all or nothing:**
        - the resolved records, marked `resolvedBy: owner`;
        - the quarantine document deleted, or the unresolved record replaced;
        - an audit entry in `l0182-resolutions/<id>`: the operator, the decision, the reviewed hash, the before and after state of every document touched, and the time.
      - **Why it is safe in `done`:** the api's `resolve` and `submit` read the quarantine and records inside their own transactions, so they see either the state before the resolution or the state after it, never a mix. A request that overlaps the resolution is retried by Firestore and then sees the new state. Until the resolution commits, the task keeps answering `assignment-under-review` and nothing is created.
      - **Migrate** is the same transaction with no records written: the quarantine is deleted and audited, and the task's next run draws as any new identity would.
      - The backfill and catch-up stay forbidden in `done`. The audited resolution is the only post-activation path, and each run handles one owner-reviewed decision.
      - The quarantine is task-level because nothing finer is knowable. A new task for the same item (a later revision) isn't quarantined: its identities come from its own program at run time. If its identities can be recovered from its own saved output, they are backfilled normally.
    - **Unresolved records never fall through to a draw.** An interpret that reaches one fails with the permanent `assignment-under-review`. The owner resolves each one with `scripts/c4-resolve-assignment.js`, choosing its version and frozen state, or leaves it blocked.
    - **Two writers, never at once.** The control document `l0182-cutover/state` is `backfill` (the initial state), `reconciling` or `done`.
      - **Every write transaction reads it inside the transaction.** The backfill and catch-up write only while it is `backfill` or `reconciling`, never in `done`. The api writes (creation, reassignment, a draw-cycle update, a freeze) only while it is `done`. The one other writer is the owner's **audited resolution** (below), which is valid in any state. A state change commits through a transaction too, so a writer whose transaction overlaps the change is retried by Firestore and then sees the new state. No cached copy of the state ever authorizes a write.
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
    - **How:** the api routes a fixed set of identities to separate collections (`l0182-canary-assignments`, `-draw-cycles`, `-survey-models`, `-cutover`), with their own cutover state, set to `done` from the start. The set is the sessions named in `L0182_CANARY_SESSIONS`, api configuration in `deploy.json`: canary-owned private/public items and fixed test sessions for two isolated free-plan workspaces. A program's text can't choose a namespace. A stranger naming a canary session only reaches isolated records, where full-principal checks still apply.
    - **Other-principal checks** use the verify account (a second signed-in account with no connections) and workspaces A/B with the same trial uid. Staged calls exercise real verified frontend attestations; mocks are emulator fixtures only.
    - API canary collections do not automatically isolate the console's binding and operation records. Staged claim/transfer tests may touch only the configured canary-owned items/bindings, with a separately approved staged continuation path. No production user's response is claimed or transferred by a canary.
    - The canary sessions stay in the canary namespace after promotion, so the scheduled canary never writes production records.

## 3. The kernel (`languages/l0000/crates`)

- **Merged in generic kernel slice 1:** `/interpret` accepts an optional `assignments` table (identity → assigned `{ instance, digest, content? }`), which reaches `Dialect::interpret_assigned` and the evaluator. The API/L0182 integration remains proposed.
- **A dialect may answer `needsAssignment`** instead of a result: `Compilation.needs_assignment` carries the requests, written by the server as `{ status: 200, needsAssignment: [...] }`. A dialect that never uses it produces byte-identical envelopes.
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
  - **`submit(identities, { taskId, caller, used })`:** the freeze of decision 7, one transaction, all or nothing, which also reads the cutover state and refuses unless it is `done`. `caller` is the full principal (decision 3); each identity's authority basis and revision are captured and recorded under the selected decision 7 protocol. In option (c), the binding/revision must also be read and checked inside the freeze transaction; an earlier HTTP lookup alone is insufficient. No option is implemented or selected here.
  - **`respondentAuthority(session)`:** the client for the console's `respondent-authority` route, called as the api's own identity (the route's caller allowlist names it), with a timeout; unavailable → temporary.
  - **The namespace** (production or canary, decision 12) is chosen from the identity's session and the api's configuration, before any read.
  - **`retained(digest)`.**
- **Caller principal:** the api builds it per request: the uid from the verified user token, plus `installation` and `workspace` only from attested fields on a call whose `X-Caller-Identity` verifies as a registered frontend (`L0182_ATTESTING_FRONTENDS` before I-2, the installation registry after).
- **`interpret.js`:** for an L0182 stage, run the exchange (decision 1); after an error-free result carrying responses, submit with the caller principal before returning, with the retry and temporary errors of decision 7. A caller whose principal doesn't equal the respondent principal gets the result as a read. No stage-cache read or write (decision 8).
- **`firestore.rules`:** `l0182-assignments`, `l0182-draw-cycles`, `l0182-survey-models` and `l0182-cutover` are server-only. Every access is a get by id, so no composite index is needed. Releases don't deploy `firestore.indexes.json`, so slice 3 confirms that with a read-only check.
- **Scripts:** `scripts/c4-backfill-assignments.js` and `scripts/c4-resolve-assignment.js` (decision 10). `scripts/lang-parity.js --interpreted` learns the exchange, and sends the deterministic table for L0182 cases.
- **Tests (emulator, `--runInBand`):**
  - concurrent first reads of one identity produce one record; a "restart" (fresh module state) returns it; a revision keeps it;
  - several surveys and sessions in one program get one record per identity, shared where identities match;
  - an owner's error-free response freezes every identity in one transaction before the result returns;
  - a non-owner's response, on a private **or public** item, is served and freezes nothing;
  - respondent authority unavailable → `respondent-authority-unavailable`, not served, nothing frozen;
  - **principals:**
    - free-plan workspace A can't submit for workspace B's session, though both share one uid;
    - a free-plan caller with no attested workspace gets `respondent-unattested`;
    - an installation or workspace in a request body, a user token or a program is ignored;
    - an attestation from a service account not in the allowlist is refused;
    - `unknown` and `ambiguous` respondent authority make the response a read;
    - item authority and C5 capture decisions are unchanged;
  - **claim continuation:** after a rebinding of S to principal P, P can submit for S and the previous principal cannot begin a new authorized attempt. An already admitted overlapping attempt follows the still-open decision 7 semantics;
  - a freeze made before a claim retains its original submitter, authority evidence and model after the claim; the new principal's eligibility does not rewrite history;
  - **a claim or transfer racing a submission:** under the chosen semantics (decision 7), the freeze records the revision it applied, and a rebinding committed between check and freeze is either excluded (c), fenced (b), or flagged in the audit (a);
  - first binding after an unbound lookup, a source-item authority change, and a change between two sessions' checks obey the selected ordering; test its crashes, retries and expiry/recovery rather than assuming revision 0 or a short lease is sufficient;
  - a holder/history match plus current authority, with no recorded historical caller, produces an authority-gap report, not an inferred submission or automatic draw classification; a later binding never fills it;
  - historical copies and sessionless outputs retain their extraction evidence for the migration decision; this alignment adds no session, binding, fresh draw or automatic classification;
  - a record changed between interpret and freeze → retried, then `assignment-contended`; never a served, unfrozen submission;
  - a retained model that exists with different bytes fails the freeze;
  - a removed version reassigns when unfrozen and serves retained content when frozen, for a bare id and a named version;
  - changed content under the same name follows decision 6;
  - an unresolved record fails `assignment-under-review` and never draws;
  - **task quarantine:** a task whose program computes its `session-id`, and whose survey is absent from the saved output, is quarantined by the backfill. At run time it answers `assignment-under-review` and creates no record and no draw-cycle entry, though the computed key has no record. Lifting it (resolve or migrate) lets it run; another task for the same item isn't affected;
  - **resolution after activation (state `done`):**
    - a quarantined task blocked after activation is resolved by the audited transaction, after which it runs with the supplied versions, and the audit entry records the before and after state;
    - a `resolve` racing the resolution sees the before state (under review, nothing created) or the after state, never a mix;
    - the resolution refuses, and writes nothing, when a target key already has a live record, or when the quarantine changed since the owner's review;
    - migrate deletes the quarantine, and the next run draws fresh;
    - the same for an unresolved record;
    - the backfill and catch-up are refused in `done`;
  - **the write barrier:** while `reconciling`, creation, reassignment and every submission are refused, and reads of existing records are served; a state change racing a write transaction makes the write retry and then refuse; the backfill and catch-up can't write once the state is `done` (the audited resolution is the one script write allowed then, tested below);
  - **the canary namespace:** canary sessions read and write only the canary collections, under their own state; no other session reaches them; a program can't choose the namespace;
  - no stage-cache entry is written for L0182;
  - with the flag off, nothing reads or writes the store.

## 6. Release order, activation and rollback

Every step is a separate approval. Nothing below is approved by this plan.

0. **Inventory** (read-only, production):
   - L0182 tasks, identities, multi-survey and sessionless programs, named versions, answered identities and conflicting draws;
   - how many identities the saved outputs can't demonstrate (unrecoverable), and the deepest survey-dependency chain in any production program;
   - how far the console's version history covers answered tasks;
   - which answering paths carry the owner's uid (decision 3). Done in slice 0 by code audit (`docs/evidence/interpreter-c4-l0182/slice0-inventory.md` §6); attestation per path is verified by the api slice's tests.
1. **The kernel and `l0182r`** (slices 1 and 2) released together. `/compile` is unchanged, so this needs no api floor. Canary: legacy L0182 output identical.
2. **The api with the flag off** (slice 3): inert.
3. **The floor.** Add an api milestone `c4-assignments` to `deploy.json`'s baselines, and `requires` on `l0182r`. While `INTERPRETER_L0182` is on, neither can roll back below the exchange support.
4. **Backfill** (state `backfill`): `--dry-run`, owner review; `--apply`; catch-up passes until the delta is small. Unresolved and unrecoverable identities go to the owner. Reports go to `docs/evidence/interpreter-c4-l0182/`.
5. **The activation gate:** unresolved records decided (decision 10), and the interpreted gate: `cargo test` on `interpret.rs`, and live `lang-parity.js --lang 0182 --interpreted --rust <l0182r>` with no difference beyond the listed deliberate ones.
6. **Stage.** Set the production state to `reconciling` (production is now fenced), then stage an api with `INTERPRETER_L0182=on` and `COMPILE_GENERATION_L0182=interp-1`. Canary through the tag.
   - **In the canary namespace** (state `done`, decision 12), the paths that write:
     - two concurrent first reads of a new identity get one version, and a re-read returns it;
     - a program with two surveys and two sessions gets one record per identity;
     - the current respondent principal's response (a new task, same session) freezes before the answer returns, with its full principal, installation and selected authority evidence recorded;
     - a different principal's response, on the private and on the public test item, is served and freezes nothing;
     - attested workspace A can submit for A but not B, despite their common uid; missing attestation cannot submit, and forged metadata or an unlisted frontend is refused;
     - a canary claim keeps S in destination item T; the new principal can submit, the previous one cannot begin another authorized attempt, and a prior freeze's attribution is unchanged;
     - the separately approved staged continuation path exercises the chosen rebind/freeze ordering, including first binding. Until the choice and protocol are reviewed, this case and API activation remain unapproved;
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
4. **Backfill and resolve scripts,** with emulator tests for every rule in decision 10: evidence extraction and unrecoverable cases, task quarantine and its lifting before and after activation, authority, chronology from version history, catch-up, unresolved, the state machine (`backfill` → `reconciling` → `done`), and `--final` refusing to run before the drain is confirmed.
5. **Evidence:** the inventory, backfill and catch-up reports, owner decisions on unresolved records, the gates and canaries, in `docs/evidence/interpreter-c4-l0182/`.

Slices 1 to 4 are code PRs. Each live step in §6 is a separate approval.

## 8. Boundary with network authorization

The network-authorization workstream (`docs/network-authorization-plan.md`, proposed in its own PR, from the proposed brief `docs/network-egress-authorization-design-brief.md`) is separate, and C4 neither waits for it nor absorbs it.

- **Embedded survey content.** The surveys are compiled into the binary (`crates/core/build.rs`). Interpreting, the exchange included, reads nothing from the network.
- **No public-fetch permission.** `l0182r` stays in the strict `compilers-default` class, whose only names are `api.graffiticode.org` and `auth.graffiticode.org` (token verification; `deploy/egress-proxy/production/network.json`). C4 adds no name, and needs no account allowlist entry and no capability.
- **Trusted platform storage and authority calls.** The api's assignment calls are platform operations, made under the api's own runtime identity:
  - Firestore reads and writes of the `l0182-*` collections, and of their canary counterparts;
  - the console's `respondent-authority` lookup (decision 3), called as the api's own identity, which the route's caller allowlist names. Item authority, called by Policy for C5, is no longer part of C4;
  - verifying frontends' `X-Caller-Identity` and the attested installation and workspace fields they carry (decision 3).

  Their authority comes from the api's service account, the Firestore rules (server-only), the respondent-authority route's audience and caller allowlist, and the registered frontends. It is **not** account-controlled retrieval: no account's allowlist governs them, and no account setting can widen or narrow them. They belong in the network plan's inventory of platform endpoints, so that its enforcement keeps them reachable and never routes them through public retrieval.
- **No compiler decides them.** `l0182r` never chooses an account, never calls Firestore or Policy, and claims no capability. It only reports what it needs (`needsAssignment`), and the api decides.
- **If the network work changes the api's egress or its route to the console,** the C4 tests in §5 (respondent authority unavailable is a temporary error, never a freeze; unattested free-plan callers can't submit) are the regression checks for that change.

## 9. Out of scope

- Aggregating responses, an interactive flow, survey authoring, or enforcing one response per person (all L0182 "Not built yet", unchanged).
- Reading surveys from anywhere but the embedded files. `SurveySource` stays the seam.
- Commands: an assignment and its freeze are a declared `get` with no external effect or business transaction (design §12), so no Policy admission, Broker or command record is involved.
- A private stage cache (decision 8).
- The MCP server's deleted-proxy tools (`open_survey`, `answer_survey`).

## 10. Risks

- **An answering path whose frontend doesn't attest** the workspace or installation can't submit for free-plan or non-Graffiticode respondents until it does (decision 3).
- **The race between a rebinding and a submission** stays open until the owner chooses (decision 7). The api slice waits for that choice.
- **Historical authority gaps** remain for the migration decision (decision 10). Holder/history matches are save provenance, not caller proof, and missing evidence does not automatically turn an answer into a draw or select a new classification.
- **Gaps in the console's version history** need recorded evidence or an explicit audited decision before backfill can classify them. Current authority and later claims cannot repair missing historical caller identity.
- **Unresolved records** block their items with `assignment-under-review` until the owner decides them.
- **The reconciling window** refuses every L0182 write, new sessions and submissions alike, with a retryable error from staging until the final catch-up after the drain: at least the 300 s drain plus the catch-up and its review. Staging and promotion should be close together, and announced if the window will be long.
- **Unrecoverable history.** Programs whose surveys don't appear in their saved output, or whose occurrences can't be matched uniquely, become unresolved, or quarantine their task when no identity can be named. Either way they block until the owner decides. Slice 0 measures how many.
- **Dependency depth.** A program deeper than the call ceiling would be newly refused. Slice 0 and slice 2 measure it before activation.
- **The hot draw-cycle document,** if traffic grows (decision 5).
- **Firestore or item authority outages** now fail L0182 reads or submissions that today succeed with a local draw. That is the price of durability, and each error is temporary and names it.
- **Rollback re-exposes today's defect** for items answered while the flag is off, and re-activation needs another catch-up (decision 11).
