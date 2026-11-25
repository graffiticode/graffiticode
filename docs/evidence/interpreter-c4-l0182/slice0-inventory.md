# C4 slice 0: L0182 production inventory (redacted)

**Date:** 2026-11-25. **Scope:** read-only, approved by the owner. **Plan:** `docs/c4-l0182-assignment-plan.md` §6 step 0.

**Method.**
- Firestore REST `runQuery` and `batchGet` only, in `graffiticode` (tasks, compiles) and `graffiticode-app` (items, versions).
- The api's compile-read helpers weren't used: `compileGet` moves `count` and `lastCompile`.
- No index was created. The console has no collection-group index on `items.lang`, so `items` was scanned with a field projection instead.
- Nothing was written in either project.

**Redaction.** This report contains no item, task, session or user ids, no survey content and no responses. Accounts are named by role. Raw extracts stay private, outside Git, in a durable owner-only backup.

## Limitations (read these first)

1. **Historical caller identity can't be established.** Stored compiles record no caller, so this inventory can't say who wrote or answered any program. **Eligible-submitter coverage is therefore unknown** for every historical answer. Item ownership and version history show who **holds** an item or task, not who answered.
2. **Saved-output coverage excludes L0182 below another chain's head.** Compiles were found by the L0182 task's own chain id, as the head of its chain. A compile in which L0182 sat below another task's head wasn't read.

Neither limitation can be removed by direct reads. Production instrumentation isn't authorized.

**Owner's reading (2026-11-25):**
- A copied literal session isn't reliable evidence of respondent identity or ownership.
- The identity decision is revised: a separate console proposal will give a new respondent's copy a fresh session, preserve it across revisions, and preserve the assignment and answers through explicit ownership rebinding on claim or transfer. Historical sessions are not rewritten automatically.
- A bulk reset of eval-owned identities is **not** approved. A private migration manifest will group referencing tasks and items, and fresh draws need an explicit decision on a concrete set.
- The program scan supports the 16-call ceiling for the inspected working programs.

## 1. Programs (all 2,022 L0182 tasks, created 2026-09-06 … 2026-11-25)

| | Count |
|---|---|
| Tasks with **no** survey | 2 |
| Tasks with exactly one survey | 2,020 |
| Tasks with **more than one** survey | **0** |
| Programs using deleted vocabulary (`FETCH`, `IDEAS`, `SELECTION`, …); they fail to compile today | 485 tasks (483 occurrences classified here; their 168 surveys without `id` are among them) |
| `id` not a string literal (a number, `5`); fails today as "not a survey id" | 1 |
| Current-vocabulary surveys **without** `session-id` | 1 |
| Current-vocabulary surveys with a literal `id` **and** literal session ("keyed") | **1,535** |
| Computed `id` or `session-id` (variables, conditionals, functions) | **0** |

No program uses `get-var`, `set-var`, a conditional, `map`/`filter` or a user function.

**Dependency depth:**
- **1** for every keyed program: one discovery call and one final call;
- **not established** for the 486 programs that fail to compile today (485 with deleted vocabulary, 1 non-string id). They draw nothing in either regime, so they need no assignment.

Scope limit: L0182 below the head of a chain isn't measured (compiles were found by the head task's chain id).

## 2. Stored compiles

| | Count |
|---|---|
| Compile documents found for L0182 tasks | 2,630, for 1,808 of 2,022 tasks |
| …stored before generation suffixes existed (key without `@…`) | 1,041 |
| …under `@L0182=rust-1` | 940 |
| …chains with an L0182 head (`id+…`) | 649 |
| Outputs with more than one survey record | 0 |
| Outputs with errors | 328 |

`response` is lifted to the top of the output, and the survey record (`instance`, `sessionId`) sits beneath it.

## 3. Identities (keyed: 360 distinct `(survey, session)`)

Survey kinds:
- **single-version** surveys, whose draw is fully determined;
- **multi-version** surveys: `civic-priorities` (12 versions) and `workplace-pulse` (3);
- **named** versions;
- surveys **no longer installed** (`you-can-choose`, multi-version when it was installed).

| Survey kind | Evidence in saved outputs | Who holds the item the session names | Identities |
|---|---|---|---|
| multi | answered, **conflicting versions** | eval | 6 |
| multi | answered, conflicting versions | no item | 1 |
| multi | answered, one version | eval | 12 |
| multi | answered, one version | no item | 1 |
| multi | draws only, >1 version | eval | 1 |
| multi | draws only, one version | eval 7, ambiguous 1 | 8 |
| named | answered, one version | eval 6, no item 6, ambiguous 1 | 13 |
| named | draws only | eval 8, no item 1, ambiguous 1 | 10 |
| not installed | draws only (17 with >1 version) | personal 30, other 9, no item 14, ambiguous 2, eval 2 (no shown version) | 57 |
| single | answered, one version | eval 169, ambiguous 45, no item 8, personal 1 | 223 |
| single | draws only, or nothing shown | eval 21, ambiguous 5, personal 2 | 28 |

Other counts:
- identities with at least one task whose compiles show no survey record: 106;
- identities with a task whose own compiles show more than one version: 6.

## 4. Findings

1. **Production L0182 use is overwhelmingly the eval account.** It owns 799 of the 841 keyed tasks whose session names exactly one item, with 536 of them answered. Your personal account owns 33, and one other account owns 9. No respondent outside these accounts was found.
2. **The session is not reliably the id of the item that holds the program.**
   - Only 135 of the 667 version records that name an L0182 task have that task's `session-id` equal to the record's item. The other 532 hold programs whose session names a **different** item: another item of the same owner (64), or an item id held by several users (188). The rest (280) are programs that fail today.
   - Program text, `session-id` included, is copied between items and accounts.
   - 281 of 307 distinct sessions are used by more than one task; the largest by 596.
3. **Sessions naming no item:** 495 keyed tasks (459 answered) carry 14 distinct sessions that match no console item in either location (`users/*/items` or the top-level `items`).
4. **Ambiguous items:** 199 keyed tasks have a session whose item id exists under more than one user.
5. **The console's version history doesn't establish authority for historical answers.** Of 537 answered keyed tasks whose session names exactly one owned item, **1** is in that owner's version history. The owners' 671 L0182 version records (2026-09-06 … 2026-11-16) mostly pair items with programs carrying another item's session (finding 2).
6. **Today's process-local loss is visible:** 7 multi-version identities have answered, error-free outputs showing different versions (6 eval, 1 no item), and 6 identities have a task whose own compiles drew different versions.
7. **Chronology:** no ordering is usable beyond the 1 version-history match. `lastCompile` moves on reads, and `firstCompile` survives refreshes. Every multi-version identity whose evidence disagrees is therefore unresolved under the plan's rules.
8. **Answering paths** (code inspection, not data):
   - `session-id` is folded in by the console at parse time (`graffiticode-app` `packages/console/src/pages/api/index.ts:532`, `packages/core/src/lib/code-generation/generate-for-request.ts:523`);
   - copying an item's code (duplication, claim, eval sweeps reusing prompts and programs) carries the source item's session unchanged (finding 2).

   Whether each path's caller uid equals the item owner can't be read from stored compiles, which record no caller. It needs the instrumentation the plan's submission check implies.

## 5. What this means for the open decisions

- **Decision 3 (who submits).** "The owner of the item the session names" is often not the person answering. A copied program names someone else's item, an ambiguous one, or none. Under the rule as written, most historical answers have no eligible submitter, and copies of a program share one assignment.
  - The owner should decide whether identity stays `(survey, literal session)` with copies sharing, or whether the console should re-fold `session-id` to the new item on copy. The latter is a console change and outside C4's code.
- **Decision 10 (backfill).** By the plan's rules, almost nothing would be frozen (authority evidence exists for 1 task), and the 7 conflicts plus about 14 other disagreeing identities would be unresolved or quarantined. Since the population is eval and personal testing, an alternative for the owner is to **migrate** all eval-owned identities (accept fresh draws), and backfill only personal and other-account identities. That is a scope decision, not a technical one.
- **Decisions 5 and 6:** only 2 installed surveys have more than one version, so balancing affects about 29 identities.
- **`you-can-choose`** (57 identities, none answered): it is no longer installed, so these fail today and would fail interpreted. Nothing needs retaining.
- **Dependency ceiling:** no production program exceeds depth 1, so the 16-call ceiling refuses nothing that works today.
- **Sessionless programs (decision 4):** 1 current-vocabulary occurrence.
