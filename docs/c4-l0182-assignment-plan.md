# C4: L0182 on the interpreter, with a durable survey assignment

**Status:** draft for the owner's review (2026-11-25). Nothing in it is implemented or live. The decisions in §2 are proposals, and each one marked **open** needs the owner's choice before its slice starts. Plan item: `docs/graffiticode-interpreter-plan.md` Track C, item 4 ("the durable get-or-create assignment (atomic, stable across revisions, frozen on submission), plus keeping the survey model that answers were given against"). Design: `docs/graffiticode-interpreter-design.md` §12 Phase 3 (the "L0182 version draws" bullets), §12 test 7, and open question 7 in §13.

## 1. Where we start

**L0182 today** (Rust, `l0182r`, routed since Track A; `COMPILE_GENERATION_L0182=rust-1`; not interpreted and not in the interpreter manifest):
- **A program names a survey and nothing in it.** `survey [id "civic-priorities" session-id get-val-public "itemId" response [...]]`. The options, items, scales and wording are read from `packages/core/data/<id>-<n>.json`, which `crates/core/build.rs` embeds in the binary. The files are never served.
- **An id names a set of versions.** `civic-priorities` has 12 (`-1` … `-12`), `workplace-pulse` 3, and the other seven surveys 1 each (17.5 KB in all; the largest set, `civic-priorities`, is 9.2 KB). A bare id **draws** a version without replacement, and the marks clear once every version has been taken. A named version (`civic-priorities-7`) loads outright, with no draw and no mark (`crates/core/src/source.rs`, `Files::load`).
- **The session is the console item id.** The console folds `get-val-public "itemId"` into a literal when it parses (`graffiticode-app` `packages/console/src/pages/api/index.ts:532`, `packages/core/src/lib/code-generation/generate-for-request.ts:523`). From the second turn the program carries that literal, and a session that drew before gets the same version back, so a response is checked against the options its taker saw. An empty session is no session.
- **The draw is process-local.** `Files` keeps `taken` and `drawn` in a `Mutex` per process, keyed by session alone (one slot per session; a session taking a second survey replaces the first). `l0182r` runs up to 20 instances, scales to zero when idle (no minimum, checked 2026-11-25), and restarts on every release, so a session that answers later can land on an instance that never drew for it and get a different version. `languages/l0182/CLAUDE.md` records this as a known limit ("A durable session→version memory" under "Not built yet").
- **The draw happens during compile.** So the same task compiled twice can give different output, and the design's determinism test ("compiling the same task twice yields byte-identical models … L0182") can't hold until the draw leaves compile.
- **The compiler is the only enforcement.** `ranked.rs` and `rating.rs` check every answer against the drawn version: option and item names, bounds, scale points, required items, `comment`. So an answer validated against one version can fail against another.
- **The output names what was drawn.** `build_survey` writes `sessionId` (when there is one) and `instance` (the version taken) into the compiled record, and lifts `response` to the top level.
- **What is stored today.** The api keeps each compile in `compiles/<id>` and the task in `tasks/<id>` (with its `lang`). Nothing records a draw durably. The survey data hasn't changed since 2026-09-22 (`4f12559a`, before the move into this repository), so every version's content is still what it was when those compiles ran, except compiles older than that date.
- **The manifest is ready for it.** `packages/common/src/interpreter-manifest.ts` already validates a `getOrCreate` declaration ("the one declared exception to a read-only get"), and its spec uses `0182 { caps private/private, getOrCreate: true }` as a fixture. No language declares it, and the api doesn't act on it yet.
- **The api calls `/interpret` with `{ model, input, mode, auth, options }`** (`packages/api/src/comp.js:38`). The kernel's `Model` is `{ lang, kind: Plan(code) | Value(json), intents }` (`languages/l0000/crates/core/src/compiler.rs`), and `Dialect::interpret(model, input, mode)` has no way to receive anything else.
- **`l0182r` has no store and no credentials,** and its account `l0182r-run` holds no roles. Policy's item authority (`packages/policy/src/item-authority.ts`, C5a decision 3) can already say who owns a console item, and whether it is public, through the console's internal route.

## 2. Decisions

Each decision says what is proposed, why, and whether it is **open** (needs the owner's choice) or follows from the design.

1. **The model lists the candidates and the api assigns.** *(Open: where the assignment runs.)*
   - **Proposed:** `l0182r` stays credential-free. Its model carries an **assignment request**: the survey id, the session, and every candidate version with its content and digest. The **api** performs the get-or-create in its own Firestore, then passes the chosen version (and, when needed, its retained content) to `/interpret`. The language interprets against exactly what it is given and draws nothing.
   - **Why:** it keeps the compiler a pure function of model, input and assignment (the determinism test holds); the api already owns Firestore, the stage cache and the audit trail; and no compiler gains a database role.
   - **Alternatives:** (a) give `l0182r-run` Firestore access and let the language write: a new credential on a public compiler, against the direction of the capability work. (b) Run it in Policy: Policy decides capabilities, and an assignment is not one; it would add a hop to every survey read.
   - **Size:** every candidate's content in the model is at most 9.2 KB today, well inside model and cache limits.
   - **Exposure:** the model makes no survey content more reachable than it is now. Anyone can already compile `survey [id "civic-priorities-7"]` and read version 7. The rule that keeps the survey out of the *program* is unchanged. Slice 3 confirms that no api route serves a model to a client.
2. **The assignment key is `(survey id, session)`.** *(Follows from the design, with one adaptation.)*
   - The design keys by "(survey item id, respondent)". In L0182 the survey is a data id (`civic-priorities`), and the respondent is the console item, whose id is the session. So the key is `(survey id, session)`, which means one assignment per item per survey.
   - It never uses the task id, so a revision of the item (a new program carrying a response is a new task) keeps the assignment.
   - **A named version** (`id "civic-priorities-7"`) needs no assignment: the program pins it. It still gets retention on submission (decision 7).
3. **Who may create, and who may freeze.** *(Open: the main authorization choice; design §13 question 7.)*
   - The session is a literal in the program, so anyone can write a program naming someone else's item id.
   - **Reading** an assignment reveals only which version an item drew, of a survey anyone can compile by name. Converging all readers on one record is what the design asks for.
   - **Proposed:**
     - **Create:** anyone whose interpret reaches it, including an anonymous viewer of a public item. That matches today: the first compile of an item draws. A stranger who creates the record first chooses nothing; the draw is still the api's.
     - **Freeze:** only a caller with authority over the item that the session names, decided by Policy's item authority: the item's owner, or anyone if the item is public. An interpret that carries a response from any other caller is answered normally but doesn't freeze. Item authority unavailable means "don't freeze now", never "freeze".
   - **Why:** freezing is the only state change with lasting effect (it blocks reassignment and binds retained content). Without the check, a stranger could freeze another item's assignment with a fabricated response.
   - **Alternatives:** (a) no authority check at all: simplest, with that griefing risk. (b) Check item authority on create too: every first read of a survey then calls the console through Policy, and an item that isn't yet in the item store (a first turn before the item is saved) couldn't be assigned.
4. **A program without a session.** *(Open.)*
   - Today each such compile draws afresh. The compile cache then holds one version per task.
   - **Proposed:** a **stateless** pick from the model: the candidate at index `sha256(model digest) mod n`. It is deterministic per program, writes nothing, and never balances. The design accepts a stateless draw "only if balancing isn't required", and with no respondent there is nothing to balance per respondent.
   - **Alternatives:** refuse a bare program (it would break any existing sessionless task; slice 0 counts them), or key by task id (a write per distinct program, for no respondent).
5. **Balancing across versions.** *(Open.)*
   - **Proposed:** keep today's semantics, made durable. Draw without replacement per survey id, with the taken set in one `l0182-draw-cycles/<survey id>` document that is updated in the same transaction as the assignment. The marks clear when every candidate version is taken.
   - **Cost:** every first assignment of a survey writes that one document, and Firestore sustains about one write per second per document. L0182's traffic is far below that. If it ever isn't, the fallback is sharding the cycle or decision 5's alternative.
   - **Alternatives:** a uniform random pick at creation (no shared document; balance is statistical), or least-assigned counts (also one hot document).
6. **Stable across revisions, of the item and of the survey data.** *(Follows from the design; one open sub-choice.)*
   - **Same item, new program:** same key, so same assignment.
   - **A release removes the assigned version** (its name isn't among the model's candidates): reassigned only if not frozen, by a fresh draw in the same transaction. If frozen, the retained content is used (decision 7).
   - **A release changes the assigned version's content under the same name** (its digest differs). *Open.* Proposed: if not frozen, keep the version and move the record to the new digest, since nobody has answered against the old one. If frozen, use the retained content. Alternative: treat any content change as removal and reassign.
7. **Freezing and retaining the survey model.** *(Follows from the design; one open sub-choice.)*
   - **What submission is.** *Open.* L0182 has no submit action: a response is code. **Proposed:** an assignment is submitted the first time an interpret of a model whose survey carries a `response` finishes with **no errors** and is allowed to freeze (decision 3). The alternative is an explicit command, which no client sends today.
   - **On freezing,** in one transaction conditional on the record still having the assignment the interpret used:
     - mark the record `frozen`, with `submittedAt`, the task id and the caller's authority;
     - write the version's content to `l0182-survey-models/<sha256>`, create-only. Its id is the content's digest, so a retained model is never overwritten.
   - **From then on,** a frozen assignment never changes. If the current model's candidates still include its digest, the language uses that content. If not, the api passes the retained content with the assignment.
   - **How long:** the answers are task code, and tasks are kept forever, so retained models are kept forever and never deleted. (Owner to confirm.)
8. **Cache and HTTP.** *(Follows from the manifest fixture; owner to confirm.)*
   - Declare `0182` with `cacheCaps { evaluate: "private", present: "private" }` and `getOrCreate: true` (manifest v11).
   - The result depends on the assignment, so the stage cache key gains the **assignment digest**: version name plus content digest, which the api knows before the interpret. A reassignment, or a frozen assignment falling back to retained content, then misses.
   - By C3's routing rule, a `private` chain is sent `no-store` over HTTP. L0182 views lose CDN and browser caching, which costs little for a small model.
9. **A new generation: `COMPILE_GENERATION_L0182=interp-1`.** Legacy `compiles/` entries hold draws made under `rust-1`, and are never served under `interp-1`. The backfill (decision 10) carries what they recorded into the store first.
10. **Backfill the draws already made.** *(Open: scope and conflict rule.)*
    - **Why it is needed:** once `interp-1` is active, an item answered under `rust-1` is interpreted afresh. With no record, its session would draw a new version, and its response could fail against it. That would break answered items at activation.
    - **Source:** for each `tasks/<id>` with `lang` 0182, its stored compile (`compiles/`) under the current generation: `sessionId`, survey id (from the program), `instance`, whether it has a `response`, and whether it compiled without errors.
    - **Proposed rule, per `(survey id, session)`:**
      - if any error-free compile carries a response: the latest such compile's version, **frozen**, with its content retained from the current data. The content is unchanged since 2026-09-22; an older compile is listed for review, not frozen automatically;
      - otherwise: the latest compile's version, **not frozen**, so what the respondent saw last doesn't change at cutover;
      - several answered compiles that drew **different** versions (today's process-local loss): listed for the owner, and not written.
    - **Mechanics:** `scripts/c4-backfill-assignments.js`, `--dry-run` by default, writing a report of counts and conflicts. `--apply` is create-only (it never overwrites an existing record), and its writes are attributed to the script. It is a live production write, run only with the owner's approval.
11. **The id and session must be known when the model is made.** *(Open edge.)*
    - The model can only list candidates for a survey id it knows. Both attributes are literals in practice (the session after the console folds it). **Proposed:** evaluate them at model time when they are input-independent, which covers every corpus case. A program whose `id` or `session-id` depends on input stays a plan without an assignment request. It is answered by a stateless pick (decision 4) and never writes. Slice 2 counts any such corpus cases.
12. **Rollback restores today's semantics, defect included.** *(Owner to accept.)* With `INTERPRETER_L0182` off, `/compile` draws per process again and ignores the store. Records made while it was on are kept, and turning it back on uses them again. Items answered while it was off fail or pass exactly as they do today.

## 3. The kernel (`languages/l0000/crates`)

- **A model may carry an assignment request.** Add an optional `assignment` to `Model`, produced by a new `Dialect::assignment_request(&ast) -> Option<Json>` (default `None`), so the model JSON and digest of every other language are unchanged.
- **`/interpret` accepts an optional `assignment`,** which reaches the dialect as a new argument of `Dialect::interpret`. Absent means none. `/compile` is untouched.
- **Tests:**
  - a dialect without the hook makes byte-identical models and envelopes (run over the L0000 corpus);
  - the request round-trips through `form: "model"`;
  - `/interpret` without `assignment` behaves exactly as today.
- **Release:** only `l0182r` needs the new kernel. Other `lNNNNr` services pick it up when they're next released, unchanged.

## 4. L0182 (`languages/l0182/crates`)

- **Model:** `assignment_request` evaluates `id` and `session-id` (decision 11). For a bare id it lists the candidates, each as `{ instance, digest, content }`, where the digest is the SHA-256 of the file's exact bytes, and it carries the session. A named version or a non-literal id gives no request.
- **Interpret:** a new `SurveySource`, `Given`, serves the assigned content: from the model's candidates by digest, or the retained content the api passed. It never draws and never marks. With no assignment and a bare id, it takes the stateless pick (decision 4).
- **`/compile` is unchanged**, process-local draw included. That is the legacy path and the rollback path.
- **`crates/core/tests/interpret.rs`, the correctness gate,** over every conformance case:
  - every model is a plan, and making it twice gives byte-identical JSON;
  - interpreting with the assignment that `Files::installed(|_| 0)` would have drawn equals the compile, in both modes;
  - an assignment whose content comes from the api's retained copy (with the version missing from the candidates) validates a response exactly as the original content did.
- **Fix `languages/l0182/CLAUDE.md`:** it still says production runs the TypeScript, and its "Not built yet" lists the durable memory.

## 5. The api

- **The manifest (v11):** declare `0182` (decision 8). It stays inert until the flag is on.
- **`packages/api/src/assignments.js`** (new), used by `interpret.js` for any declaration with `getOrCreate`, never by language number:
  - `getOrCreate(request, { authority })`: one transaction over `l0182-assignments/<sha256(survey id, session)>` and the survey's draw cycle. It returns the existing record if it is still valid (decision 6), and otherwise draws and writes one. Concurrent first calls converge on one record through the transaction's retry.
  - `freeze(record, { taskId, authority, content })`: conditional on the record being unchanged and not frozen; checks item authority (decision 3); writes the retained model create-only.
  - `retained(digest)`: the retained content.
- **`interpret.js`:** before an L0182 stage, assign; pass `assignment` (plus retained content when needed) to `/interpret`; add the assignment digest to the stage key (decision 8); after an error-free result whose survey carries a response, freeze. An assignment the store can't make (Firestore unavailable) fails the stage with a temporary error. It never falls back to a local draw.
- **`firestore.rules`:** the three collections are server-only, with no client read or write. No composite index is needed: every access is a document get by id. (Releases don't deploy `firestore.indexes.json`; confirm with a read-only check before release that nothing needs one.)
- **Scripts:** `scripts/c4-backfill-assignments.js` (decision 10); `scripts/lang-parity.js --interpreted` learns to send the deterministic assignment for L0182 cases.
- **Tests (emulator, `--runInBand`):**
  - concurrent first reads produce one assignment;
  - a "restart" (fresh module state) returns the same assignment;
  - a revision (another task, same session) keeps it;
  - an error-free response from the item's owner freezes it, and one from another caller of a private item doesn't;
  - a removed version reassigns when not frozen, and serves retained content when frozen;
  - changed content under the same name follows decision 6;
  - the draw cycle takes every version before any twice;
  - the stage key changes with the assignment;
  - with the flag off, nothing reads or writes the store.

## 6. Release order, activation and rollback

Every step is a separate approval. Nothing below is approved by this plan.

0. **Inventory** (read-only, production): count L0182 tasks, sessions, answered sessions, sessionless and named-version programs, and conflicting draws. It sizes decisions 4, 10 and 11.
1. **The kernel and `l0182r`** (slices 1 and 2) released together. `/compile` is unchanged, so this needs no api floor. Run the canary: legacy L0182 output identical.
2. **The api with the flag off** (slice 3): manifest v11, `assignments.js`, rules, scripts. Inert.
3. **The floor:** add an api milestone `c4-assignments` to `deploy.json`'s baselines. While `INTERPRETER_L0182` is on, an api rollback below the milestone is refused, because an older api would interpret L0182 without assigning. Add `requires` on `l0182r` the same way, so `l0182r` can't roll back below the interpret support while the flag is on.
4. **Backfill:** `--dry-run`, owner reviews the report and conflicts, then `--apply`. The report goes to `docs/evidence/interpreter-c4-l0182/`.
5. **The interpreted gate:** `cargo test` on `interpret.rs`; live `lang-parity.js --lang 0182 --interpreted --rust <l0182r>`, with no allowed difference.
6. **Stage** an api with `INTERPRETER_L0182=on` and `COMPILE_GENERATION_L0182=interp-1`. Canary through the tag, on a test survey item owned by the canary account:
   - two concurrent first reads of a fresh session get one version;
   - a second api instance and a re-read return the same version;
   - adding a response (a new task, same item) keeps the version, and freezes it;
   - a backfilled answered item still compiles without errors;
   - the stage cache hits for the same assignment, and `/data` is `no-store`;
   - nothing is served from `rust-1` entries.
7. **Promote** with that evidence.

**Rollback:**
- **Activation:** set `INTERPRETER_L0182="off"` (by value) with a new generation (`rust-2`), as a forward release, or roll the api back to the release before activation, at or above the floor. The store is kept (decision 12).
- **`l0182r`:** rollback is free while the flag is off. While it's on, it is refused by `requires`.
- **Backfill:** records are create-only and carry the script's attribution, so they can be listed and deleted while the flag is still off. After activation, deleting records would reassign live items, so it needs its own decision.

## 7. Slices

1. **Kernel:** the assignment request on `Model` and the `assignment` on `/interpret` (§3).
2. **L0182:** the request, the `Given` source, the stateless pick, `interpret.rs`, the CLAUDE.md fix (§4).
3. **api:** manifest v11, `assignments.js`, `interpret.js`, rules, the parity tool, tests (§5).
4. **Backfill script** and its dry-run tests against the emulator (decision 10).
5. **Evidence:** inventory, backfill report, gate and canary results, in `docs/evidence/interpreter-c4-l0182/`.

Slices 1 to 4 are code PRs. Each live step in §6 is a separate approval.

## 8. Out of scope

- Aggregating responses, an interactive flow, survey authoring, or enforcing one response per person (all L0182 "Not built yet", unchanged).
- Reading surveys from anywhere but the embedded files. `SurveySource` stays the seam.
- Commands: an assignment is a `get`, with no external effect and no business transaction (design §12), so no Policy admission, Broker or command record is involved.
- The MCP server's deleted-proxy tools (`open_survey`, `answer_survey`).

## 9. Risks

- **Griefing before freezing.** With decision 3, a stranger can create an item's assignment first but can't freeze it. If the owner chooses no authority check, a stranger can freeze another item's assignment.
- **Backfill conflicts.** Sessions whose answered compiles disagree can't be resolved automatically. They stay as they are today (re-drawn) until the owner decides each one.
- **The hot draw-cycle document,** if traffic grows (decision 5).
- **A Firestore outage** now fails L0182 reads that today succeed with a local draw. That is the price of durability. The error is temporary and names it.
- **Rollback re-exposes today's defect** for items answered while the flag is off (decision 12).
