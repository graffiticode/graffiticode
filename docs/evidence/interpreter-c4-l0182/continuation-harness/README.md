# C4 continuation harness (emulator only)

Executable evidence for **option (c)** of [`docs/c4-continuation-race-review.md`](../../../c4-continuation-race-review.md), which the owner approved on 2026-11-25:
- bindings and operations live in the api's store;
- authority is published at **ready** (C4);
- C4 reads active bindings directly from the api's store.

It exists to test the protocol before the API slice. **It is not production code.** No route, deployment configuration, Firestore rule or index, `packages/api` module (`interpret.js`, `assignments.js`) or L0182 behavior uses or is changed by it.

## What it models

**The two stores.**
- `src/stores.mjs` connects to two **distinct Firestore emulator projects**, `demo-c4-harness-api` (the api's store) and `demo-c4-harness-console` (the console's), so that, as in production, no transaction spans both.
- It refuses to load unless `FIRESTORE_EMULATOR_HOST` names a loopback emulator.
- Each test writes under a fresh random namespace, and **nothing is ever deleted**.

**The state machine.** `src/protocol.mjs` implements every step of the review's option (c) table, each as **one transaction in one store**:

| Step | Store | Function |
|---|---|---|
| C0 register (reads the creation barrier) | api | `register` |
| C1 allocate (reads the console tombstone) | console | `allocate` |
| C2 bind-prepare | api | `bindPrepare` |
| C3 finalize | console | `finalize` |
| C3a finalized acknowledgement | api | `ackFinalized` |
| C4 activate (authority, history and result in one write; the point of no return) | api | `activate` |
| C5 unlock | console | `unlock` |
| C-cancel (api, then the console tombstone) | api, then console | `cancelApi`, `cancelConsole` |
| the creation barrier | api | `openBarrier`, `closeBarrier` |
| submission S2/S4 (all sessions, all or nothing) | console read, then api | `deriveAuthority`, `submit` |
| console write paths (answer, edit, delete) | console | `consoleWrite` |
| the verified drain and the floors (R-api, K-console, W) | both | `drainCounts`, `floors` |

**The selected runtime and lifecycle policies** (`src/lifecycle.mjs`; [`docs/c4-runtime-lifecycle.md`](../../../c4-runtime-lifecycle.md) §10, selected 2026-11-27):

| Policy | Function |
|---|---|
| §9 routed C0: the operation index, then the session pin, then the list; both created once, un-namespaced | `registerRouted`, `namespaceOf`, `submitRouted` |
| §9 the release-time configuration check (reports; the pin still wins) | `configCheck` |
| §9 namespaced views (`canary-` prefix), separate barriers, canary-owned fixtures | `scoped`, `scopedStores` |
| §7 settlement records and the console's settled acknowledgement | `ackSettled`, `runRoutedChild` |
| §7 the recovery runner's ordered, api-phase-guarded rows | `recoveryPass`, `recoverOne` |
| §6 archive (`mark: 5`) and the listing reader's archive and expiry filter | `archiveItem` (in `protocol.mjs`), `visibleItems` |

The canary prefix is uniform in the harness (`canary-<name>`). The plan's production names (`l0182-canary-assignments` and so on) are the API slice's choice.

`src/driver.mjs` runs a child continuation through C0–C5, resuming from whatever has committed. It also runs multi-item claims, whose source set and child ids are fixed once, and can "crash" after any step.

**Not modelled:**
- W0–W3 withdrawal, which was not selected;
- hard deletion, TTL or cascading deletion, which need their own contract;
- the backfill and migration;
- sessionless programs and balancing, which live in the language and the API slice;
- installation-specific namespaces;
- the transport of acknowledgements, which the harness passes as arguments.

## Tests

`continuation.harness.mjs` covers each option-(c) and shared case of the review's §9:
- the happy path;
- atomic authority, history and result;
- a crash after every step, with roll-forward;
- cancellation from every point before C4;
- cancel against finalize and activate;
- tombstones, including **C0 → cancel → drain → delayed C1**;
- readiness acknowledgements, including **C2 → C4 without C3**;
- late cleanup of an old `opId`;
- item locks, and ready versus unlocked;
- submissions while prepared, and multi-session submissions;
- freeze attribution before and after a rebind;
- free-plan workspaces;
- the first-binding race;
- concurrent continuations;
- multi-item recovery;
- **claim A → transfer B → replay A**;
- authority proof at C0 and C1;
- the barrier, drains and floors.

`lifecycle.harness.mjs` covers the selected policies:
- **Settlement:**
  - the record is created at C0;
  - the ack is refused before the operation is terminal, or with mismatched console evidence;
  - the terminal operation record keeps the same data and update time after settlement.
- **Namespaces:**
  - the first C0 pins and indexes;
  - every later step stays in the recorded namespace;
  - **a C0 retry after a lost response, with the list changed in between**, replays in the original namespace;
  - a changed request under the same `opId` is a mismatch;
  - a pin survives a list change, and the configuration check reports it;
  - canary-only fixtures;
  - separate barriers;
  - mixed-namespace submissions are refused;
  - a canary submission by a non-canary principal is refused, and leaves no pin and no freeze.
- **Recovery:**
  - the selected targets;
  - nothing younger than the threshold is touched;
  - one pass settles after a crash at every step;
  - a finalized continuation rolls forward;
  - api-cancelled cleanup takes precedence over a console still `finalized`;
  - a settle-only repair;
  - the runner racing a client resume;
  - a racing submission is refused temporarily, not queued;
  - **a C2 or C3a committing between the runner's snapshot and its cancellation refuses the cancel** (`phase-advanced`, the runner's in-transaction precondition), and recovery restarts from row 1.
- **The retained descriptor:**
  - archiving T keeps the pointer and descriptor, and the respondent can still submit;
  - a transfer moves the pointer while descriptor 1 and its freeze are unchanged;
  - an expired and archived unbound free-plan item keeps its derived authority;
  - a claimed source's expiry changes nothing;
  - a completed continuation's read-only source can be archived, and still refuses answers and edits;
  - archive is refused while an item is locked, including a source whose continuation is past C4 but not yet unlocked.

## Running

CI runs it as the emulated target `c4-continuation-harness` (`scripts/test-targets.json`). It has no `allowSkips`, so any skipped test fails the build.

Locally, with Java installed for the emulator:

```bash
npx firebase emulators:exec --only firestore \
  "cd docs/evidence/interpreter-c4-l0182/continuation-harness && NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.mjs"
```

Only `*.harness.mjs` files match its configuration, so no other target discovers them. `deploy.json`'s default `exclude` lists `docs`, so the harness is in no service's deploy snapshot.
