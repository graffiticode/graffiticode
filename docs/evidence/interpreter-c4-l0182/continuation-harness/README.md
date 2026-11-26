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

`src/driver.mjs` runs a child continuation through C0–C5, resuming from whatever has committed. It also runs multi-item claims, whose source set and child ids are fixed once, and can "crash" after any step.

**Not modelled** (separate decisions):
- deletion and expiry after unlock;
- the backfill and migration;
- sessionless programs;
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

## Running

CI runs it as the emulated target `c4-continuation-harness` (`scripts/test-targets.json`). It has no `allowSkips`, so any skipped test fails the build.

Locally, with Java installed for the emulator:

```bash
npx firebase emulators:exec --only firestore \
  "cd docs/evidence/interpreter-c4-l0182/continuation-harness && NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.mjs"
```

Only `*.harness.mjs` files match its configuration, so no other target discovers them. `deploy.json`'s default `exclude` lists `docs`, so the harness is in no service's deploy snapshot.
