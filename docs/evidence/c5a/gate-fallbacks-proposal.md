# C5a gate: proposed fallback explanations and evidence (for review)

This is a proposal only. Nothing here is applied, and `hermetic-fallbacks.DRAFT.json` is unchanged.

**Scope.** It covers three rows of `scripts/lib/c5a-gate-checks.js`:
- `private-non-owner`'s "after narrowing" part (`narrowed`);
- `conditional-retry` (`conditional`);
- `reserve-stage-bind` (`reserveStageBind`).

**The rules applied** (`liveOrFallback`, `hermeticProblem`):
- A live observation always decides.
- A fallback counts only with no live observation, at the deployed commit (Policy `f6132821`, Broker `58adb430`), with `uninducible` explaining why.
- Every judged result field needs its own evidence.

**Sources and test runs**
- **Checkout:** c6r `7840b858` (main `e137e079` plus the round-trip verdict commit).
- **Unchanged since the deployed commits:**
  - `git diff --stat f6132821 HEAD -- packages/policy packages/common` is empty;
  - `git diff --stat 58adb430 HEAD -- packages/broker packages/common` is empty.
- **Local runs:**
  - `packages/policy`: `captures.spec.ts` and `scopes.spec.ts` PASS, 74/74;
  - `packages/broker`: `gcs.spec.ts` PASS, 46/46.

**The approved interfaces.** The gate can:
- call api-c5a-gate's `POST /command` and `/compile`, as the canary owner, the verify non-owner, or anonymously;
- use the owner's console item operations;
- read Policy and Broker records and audit with the operator's credentials.

It cannot impersonate a compiler, mint a token, or inject a fault into production Broker. It cannot crash, pause or reorder l0013r internally either.

---

## 1. `narrowed`: refused at authorize-execution after access is narrowed

**The required condition.** The owner's capture of the private item is reserved and minted as the owner's. Before Broker's `authorize-execution` for its publish, the item stops being the owner's while it still exists, and Policy answers `not-owner`.

Policy produces `not-owner` here only when item authority answers that the item exists, its `ownerUid` isn't the command's subject, and no public-capture exception applies:
- `packages/policy/src/item-authority.ts:109-112`;
- the live check, `packages/policy/src/policy.ts:1460-1468`.

**Why it can't be induced through the approved interfaces**
1. **The owner can't change who owns an item.**
   - Item authority derives the owner from the item's path, `users/{ownerUid}/items/{id}` (graffiticode-app `packages/console/src/lib/item-authority.ts`, header).
   - The console's only item mutation is `updateItem`, whose fields are name, taskId, mark, help, isPublic, client, upstreamLangs, source and label (`packages/console/src/utils/swr/fetchers.ts:543-575`). None of them is the owner.
   - What the owner *can* do gives other answers, not `not-owner`:
     - delete the item: `item-not-found` (`item-authority.ts:105`);
     - make it public: the owner is still the owner, so it is allowed (`item-authority.ts:109`);
     - retarget its task: `render-target-changed`, at reserve recovery only (`policy.ts:991-994`).
   - Moving the item to another account would be a direct Firestore write. That isn't an approved interface.
2. **The window is inside one l0013r run, and the gate can't control it.**
   - Reserve, render, stage, bind and mint, then Broker's authorize, run back to back in `languages/l0013/crates/core/src/lib.rs:296-312`.
   - Broker authorizes immediately before the upload (`packages/broker/src/gcs.ts:264-266`).
   - The gate sees neither boundary, so it can't time an item change into that window.
3. **The live non-owner refusal at allocation is a different row** (`privateNonOwner`): it is already observed live (`c:8332eefc…`, `not-owner` at command admission).

**The field the check judges, and its evidence**

| Field | Evidence | Value |
|---|---|---|
| `reason` | Policy `src/scopes.spec.ts` › "v3 execution (decisions 5 and 6)" › "refuses an owner's capture at authorize-execution once the item has changed owner" (`:584-590`). The owner's private capture is minted, then the item is set to `{ ownerUid: OTHER, isPublic: false }`, and `authorizeExecution` is refused, as is a later mint. | `not-owner` |

**I recommend replacing the draft's test.** The draft cites `captures.spec.ts` › "the live check against the reservation" › "refuses a capture reserved as the owner's once only the exception would allow it". That test covers the *public*-exception variant: the item stays public, changes owner, and was reserved as the owner's. It is supporting evidence at most, not this row's required condition, which is a private item narrowed.

```json
{ "narrowed": { "PROPOSED": true, "service": "policy", "commit": "f6132821c5a654c2bfd3fce10ca7b5a5e328bdc2",
  "test": "packages/policy/src/scopes.spec.ts > v3 execution (decisions 5 and 6) > refuses an owner's capture at authorize-execution once the item has changed owner",
  "supporting": ["packages/policy/src/captures.spec.ts > the live check against the reservation (decision 9) > refuses a capture reserved as the owner's once only the exception would allow it"],
  "output": "<jest output of scopes.spec.ts and captures.spec.ts at f6132821: PASS, 74/74, to be captured verbatim>", "passed": true,
  "uninducible": "Policy answers not-owner at authorize-execution only when the item still exists under another owner (item-authority.ts:109-112). No approved interface changes an item's owner: the console's updateItem fields exclude it (fetchers.ts:543-575), and the owner is the item's path. Deleting gives item-not-found, making it public is still the owner's, and retargeting gives render-target-changed. The reserve-to-authorize window is inside one l0013r run (l0013 core lib.rs:296-312, broker gcs.ts:264-266), so an outside caller can't time it.",
  "result": { "reason": "not-owner" } } }
```

---

## 2. `conditional`: a conditional retry

**The required condition.** Two captures of one item, with sequences s and s+1:
- the newer (s+1) reads the object's metadata first;
- the older (s) then uploads, changing the generation;
- the newer's upload, sent with `ifGenerationMatch` of the generation it read, gets a 412;
- the newer's next publish attempt is authorized under a fresh Policy decision and writes;
- the object ends on s+1.

This follows `packages/broker/src/gcs.ts:240-283`:
- the metadata read is `:246`;
- the upload is prepared with `ifGenerationMatch` at `:254-259`;
- each attempt is authorized by `attemptCall` at `:266`;
- a 412 is observed as `precondition-failed` and the loop continues (`:274-277`).

**Why it can't be induced through the approved interfaces**
- **The window is too narrow to hit from outside.** The older capture's upload must land between the newer's `getMetadata` and its `request.send`. That gap is one Policy authorize round-trip inside Broker (`gcs.ts:246` → `:266` → `:273`), tens to hundreds of milliseconds.
- **The gate can't steer either capture into it.**
  - Each capture's arrival at Broker follows a full l0013r run: reserve, a headless-Chrome render of variable length, stage, bind and mint (`l0013 core lib.rs:296-312`).
  - The gate can only start commands. It can't hold either at a step, and production Broker has no fault or hook interface (the `beforeUpload` hook exists only in the spec's fake storage).
  - Sequences are assigned at reserve (`packages/policy/src/command-records.ts:522-524`), so the older is whichever reserved first, also outside the gate's control.
- **Trying by chance is also ruled out.**
  - Each try costs public-capture quota, at most 12 per item per hour (`policy.ts:75`), and a published capture.
  - Hitting the window by chance is improbable, so it isn't a bounded way to induce the case.
- **What would count anyway:** if a gate run did observe such a pair, its live observation would decide. That would be Broker's `execute-step` audit for the newer, with two attempts and distinct `decisionId`s, plus the object's metadata.

**The fields the check judges, and their evidence**

| Field | Evidence | Value |
|---|---|---|
| `attempts` (two, with distinct `decisionId`s) | Broker `src/gcs.spec.ts` › "publishing (decision 8)" › "ends a 412 race on the newer capture: the older wins first, the newer retries under a fresh decision" (`:363-392`). The newer's attempts are `[[1,"precondition-failed"],[2,"published"]]`, two distinct `decisionId`s, and its execute-step audit records have different `decisionId`s. | 2 attempts, distinct ids |
| *(distinct ids come from real Policy decisions)* | The Broker test's decision ids come from its fake Policy. For real Policy issuing a distinct decision per attempt: Policy `src/scopes.spec.ts` › "v3 execution (decisions 5 and 6)" › "authorizes a capture's attempts as the registry allows them, each with its own decision" (`:559-578`). Attempts 1, 2 and 4 get 3 distinct ids, and an attempt after anything but the step itself is refused. | distinct per attempt |
| `newerSequence` | the same Broker test: the newer is `thumbnail(b, 6)` | 6 |
| `finalSequence` | the same Broker test: `published().metadata.captureSequence` is `"6"`, and the older's `published` was overwritten | 6 |

**A schema gap.** The supporting Policy test is a different service from the record's `service: broker`. `hermeticProblem` checks one service and commit per row. I propose a primary Broker record plus a `supporting` list. Since the checker ignores `supporting`, the reviewer should decide whether to extend the checker to verify each supporting entry's service commit.

```json
{ "conditional": { "PROPOSED": true, "service": "broker", "commit": "58adb43055b4a8ed6fb2d9d9e750db291cea9bb8",
  "test": "packages/broker/src/gcs.spec.ts > publishing (decision 8) > ends a 412 race on the newer capture: the older wins first, the newer retries under a fresh decision",
  "supporting": [{ "service": "policy", "commit": "f6132821c5a654c2bfd3fce10ca7b5a5e328bdc2", "test": "packages/policy/src/scopes.spec.ts > v3 execution (decisions 5 and 6) > authorizes a capture's attempts as the registry allows them, each with its own decision" }],
  "output": "<jest output of gcs.spec.ts at 58adb430: PASS, 46/46, verbatim>", "passed": true,
  "uninducible": "The race needs the older capture's upload to land between the newer's metadata read and its upload inside Broker (gcs.ts:246-273), a window of one Policy authorize call. Through the approved interfaces the gate can only start commands. Each capture reaches Broker after a full l0013r run with a variable-length headless render (l0013 core lib.rs:296-312), production Broker has no fault or hook interface, and sequences are assigned at reserve (command-records.ts:522-524). Trying by chance is bounded by the 12-per-hour public quota (policy.ts:75) and isn't a way to induce it.",
  "result": { "attempts": [{ "decisionId": "decision (attempt 1, precondition-failed)" }, { "decisionId": "decision (attempt 2, published)" }], "newerSequence": 6, "finalSequence": 6 } } }
```

---

## 3. `reserveStageBind`: reserve, stage and bind

The check judges `order`, `repeatReserveSame`, `repeatStageSame`, `publishedSequence`, `reservedSequence`, `outOfOrderFinal` and `outOfOrderNewer`. **Several of these can be observed live through the gate's ordinary captures, and I propose they be live.** A fallback is needed only for the repeats and the out-of-order pair.

**Live, from every ordinary gate capture** (owner, composition, mixed, and the public burst). All of these are records the gate already reads with operator credentials:
- **`order`:**
  - Policy's reservation record goes `state: "reserved"` with `reservedAt` (`command-records.ts:524`), then `state: "staged"` with `stagedAt` (`:538`).
  - The occurrence's bind record carries `boundAt` (`:477`/`:483`).
  - Policy also refuses staging or binding without a reservation (`captures.spec.ts` "refuses staging without a reservation…", "refuses a bind with no reservation").
  - So `reservedAt < stagedAt < boundAt` gives `["reserve","stage","bind"]`, and Policy's `command-reserve` and `command-stage` audit events back it up (`policy.ts:961`, `:1061`).
- **`reservedSequence` and `publishedSequence`:**
  - the reservation's `captureSequence` (`command-records.ts:522-524`);
  - the gate bucket object's `captureSequence` metadata, written by Broker (`gcs.ts:256`).
  - The gate already reads both for `privateOwner` (r381d64: reserved 1, published 1 for E3).

**The fields a live run can't produce:**
- **`repeatReserveSame` and `repeatStageSame`.** A repeated reserve happens only when the same occurrence runs again: a worker retry or takeover after a crash, or recovery.
  - l0013r calls reserve once per occurrence, and calls stage only when the reservation isn't already staged (`l0013 core lib.rs:296-305`).
  - Through the api, the same key answers the recorded command without running it again (r381d64: the owner's retry returned the same command, with one reservation).
  - The gate can't crash l0013r or take a command over mid-run without acting as a worker (the due phase's fenced takeovers only retire commands that never ran).
- **`outOfOrderFinal` and `outOfOrderNewer`.** The older capture's Broker publish must arrive after the newer's. That ordering is set by render timing inside two l0013r runs, which the gate can't control (see §2). It isn't forceable, but if a run happens to observe it, that live observation decides.

**The fields the check judges, and their evidence**

| Field | Live, or hermetic at the deployed commit | Value |
|---|---|---|
| `order` | **Live:** each capture's reservation `reservedAt`/`stagedAt` and bind `boundAt`. Hermetic support: Policy `captures.spec.ts` › "reserve, stage and bind (decision 9)" › "run in order, each once: a repeat answers what is recorded", "refuses a bind with no reservation", "refuses staging without a reservation, and anything but a PNG" | `["reserve","stage","bind"]` |
| `reservedSequence` | **Live:** the reservation's `captureSequence` | per capture |
| `publishedSequence` | **Live:** the object's `captureSequence` metadata, read right after the command | equals the reserved one |
| `repeatReserveSame` | Policy `captures.spec.ts` › "reserve, stage and bind (decision 9)" › "run in order, each once: a repeat answers what is recorded": a repeated reserve equals the first, then after staging it answers the staged digest; `staging.creates` has length 1 | `true` |
| `repeatStageSame` | the same test: a second stage with other bytes answers the first staged record, and nothing more is created | `true` |
| `outOfOrderNewer`, `outOfOrderFinal` | Broker `gcs.spec.ts` › "publishing (decision 8)" › "completes an older capture arriving after a newer one with its own result, writing nothing" (`:339-352`). The newer (6) is published, then the older (5) arrives, is observed `newer-present`, and writes nothing; the object is unchanged. **The Policy repeat-reservation test can't establish this.** | newer 6, final 6 |

**What a hermetic `publishedSequence` would need, if it ever had to be one.** Publication is Broker's, and no single existing test carries a sequence from Policy's reservation to the published object. It would take a chained pair:
- Policy `captures.spec.ts` › "binds only exactly the reserved and staged arguments";
- Broker `gcs.spec.ts` › "publishes the first capture, with its sequence on the object and a stable result".

Since the field is observable live, I propose live and no hermetic substitute.

**Schema and checker changes this would need (for review):**
1. The row would be mixed: `order`, `reservedSequence` and `publishedSequence` live, and the rest hermetic.
   - Today `liveOrFallback` takes either a whole live `reserveStageBind` object or the whole fallback.
   - The checker would need to merge per field, with live fields always deciding, or the gate would need a live producer that records `order` and the sequences and fills the other fields from the fallback.
2. The hermetic fields come from two services: Policy for the repeats and Broker for the out-of-order pair. So either per-field `service`/`commit` entries, or two records (for example `reserveStageBind` from Policy and `outOfOrder` from Broker), each checked by `hermeticProblem`.

```json
{ "reserveStageBind": { "PROPOSED": true,
  "live": { "order": "from each capture's Policy reservation (reservedAt, stagedAt) and bind (boundAt)", "reservedSequence": "reservation.captureSequence", "publishedSequence": "the gate bucket object's captureSequence metadata" },
  "hermetic": [
    { "fields": ["repeatReserveSame", "repeatStageSame"], "service": "policy", "commit": "f6132821c5a654c2bfd3fce10ca7b5a5e328bdc2",
      "test": "packages/policy/src/captures.spec.ts > reserve, stage and bind (decision 9) > run in order, each once: a repeat answers what is recorded",
      "output": "<jest output at f6132821, verbatim>", "passed": true,
      "uninducible": "A repeated reserve or stage of one occurrence happens only when the same occurrence runs again after a crash or takeover. l0013r reserves once and stages only an unstaged reservation (l0013 core lib.rs:296-305), the api answers a repeated key from the recorded command, and the gate can't crash l0013r or take a running command over through the approved interfaces.",
      "result": { "repeatReserveSame": true, "repeatStageSame": true } },
    { "fields": ["outOfOrderNewer", "outOfOrderFinal"], "service": "broker", "commit": "58adb43055b4a8ed6fb2d9d9e750db291cea9bb8",
      "test": "packages/broker/src/gcs.spec.ts > publishing (decision 8) > completes an older capture arriving after a newer one with its own result, writing nothing",
      "output": "<jest output at 58adb430, verbatim>", "passed": true,
      "uninducible": "The older capture's publish must reach Broker after the newer's. That order is set by render timing inside two l0013r runs (l0013 core lib.rs:296-312), and the gate can only start commands, so it can't force it. If observed live, the live observation decides.",
      "result": { "outOfOrderNewer": 6, "outOfOrderFinal": 6 } } ] } }
```

---

## Summary of what remains unsupported

1. **No existing hermetic test supports a field that the live run can't also observe.** Every judged field now has evidence:
   - `narrowed.reason` comes from a hermetic test;
   - `conditional`'s fields are hermetic, Broker primary with Policy supporting;
   - `reserveStageBind` is live for order and sequences, Policy hermetic for the repeats, and Broker hermetic for the out-of-order pair.
2. **Checker and schema changes are needed before the last two rows can be judged as proposed.** These are design choices for review:
   - verifying supporting or per-field services and commits;
   - merging live and hermetic fields per field for `reserveStageBind`.
3. **`narrowed` should swap its draft test** for `scopes.spec.ts` "…once the item has changed owner". The draft's `captures.spec.ts` test covers the public-exception variant.
4. **The `output` fields are placeholders.** Each must be the verbatim jest output, captured at the deployed commit.
