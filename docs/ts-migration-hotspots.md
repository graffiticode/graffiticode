# TypeScript migration notes

Running record of the `packages/*` TypeScript migration: where each package
stands, how a conversion is done, and what went wrong along the way so it is
not repeated. Phases: 0 safety net, 1 `checkJs` discovery, 2a compiled build,
2b packages load from `dist/`, 3 `.ts` sources, 4 strict and typed releases.

## Status

As of 2026-10-05. "Branch" means pushed, not yet merged to `main`.

| Package | 2b: loads `dist/` | 3: `.ts` sources / specs | npm |
|---|---|---|---|
| common | ✅ main | ✅ main (sources and specs; emit unchanged) | `2.1.0` on `latest` (after the 2026-10-05 soak; `2.1.0-ts.0` on `next`) |
| auth | ✅ main | — | `2.2.0` on `latest` (after the 2026-10-05 soak; `2.2.0-ts.0` on `next`) |
| auth-client | ✅ main (no soak: nothing deploys or imports it) | ✅ main (sources and specs; emit unchanged) | `1.1.0-ts.0` prepared, not published |
| policy | ✅ main (`a1675c1`; released `policy-rmuvr83qk-14074d` 2026-10-05 21:29Z, soaking) | — | private |
| broker | — | — | private |
| api | — | — | not published |
| deploy | — | — | private |

All four services (auth, api, policy, broker) run Phase 2a images with
compiled `common` and `auth` (auth from `dd20861`; broker and api from `5e0fa93`,
the v6 release; policy from `a1675c1`, which also runs compiled policy), and every release passes its candidate `verify`
module before promotion.

Policy and broker can't start without KMS, so CI's image job can't run their
real `CMD`. Instead it imports every compiled module of the package except
`main.js` inside the image (`loads` in the matrix); the release candidate's
`verify` proves startup.

`TS-MIGRATE` suppression budgets on `main` (`scripts/ts-migrate-budget.json`,
enforced by `npm run typecheck`; they only go down):

| Package | Sources | Tests |
|---|---|---|
| common | 0 | 0 |
| auth | 20 | 8 |
| auth-client | 0 | 0 |
| policy | 7 | 0 |
| broker | 3 | 7 |
| deploy | 8 | 7 |
| api | 37 | 82 |

Phase 1 found 110 errors on 90 lines; the rest are listed below by class.
Conversions should remove the suppressions in the files they touch by typing
the code, not by moving the comment.

## Soak criteria in practice

`node scripts/soak-report.js` judges each service's latest release against the
same weekday/hours a week earlier and says **MET** after 24 h without a
regression (shortened from 72 h on 2026-10-02: traffic is too low for a
longer window to add statistical power), and api and auth need 300 judged
requests rather than 1,000, about a day of their traffic. Two other
adjustments that day:

- **policy and broker** get almost no production traffic (single digits a
  day, none in the baseline window), so they can never reach the volume bar.
  Their soak is the release's passed candidate `verify` (recorded in the
  receipt) plus no 5xx and no new error signatures for 24 h.
- **Requests the api proxies to a language server** (`/L<lang>/...`) are
  reported but not judged: their latency is the language server's, including
  its cold starts. `l0184`, which was cold-starting about hourly, now has a
  service-level minimum of one instance (`gcloud run services update l0184
  --min=1`; set outside deploy.json).
- **Latency is judged per route** (method + path, with ≥ 20 requests in both
  windows): one overall p95 moves with the traffic mix even when no route is
  slower. After the Beta languages in `PING_LANGUAGES` were pinned warm too
  (console `check-min-instances`, service-level `--min`), api's current
  release soaks from 18:03 UTC on 2026-10-02 (`WINDOW_START` in the script);
  its earlier requests measured language-server cold starts.

## How a package is converted (phase 3)

1. **Rename commit**: `git mv src/*.js src/*.ts` with contents unchanged, so
   every file is a 100% rename and `git log --follow` keeps its history. This
   commit alone may not type-check; say so in its message.
2. **Types commit**: annotations and `import type` only. Class fields that
   only exist for typing use `declare` (an ES2022 field emits runtime code).
   No enums, namespaces, decorators or parameter properties (ESLint bans them).
3. **Keep public types as loose as the JavaScript build's** where other
   packages depend on that looseness (e.g. `req` as `any` for services that
   attach `req.auth`). A conversion must not change what sibling packages see:
   `npm run typecheck` across all packages must pass with no new errors and no
   sibling suppression becoming unused. Tightening is phase 4.
4. **Prove the emit is unchanged**: save a clean build of the package before
   converting, then `node scripts/compare-emit.js <before> <after>` (or
   `--base <ref>`) must report 0 differences. Only `.d.ts` files may change.
5. **Specs** follow in their own rename + types commits. Deliberate type
   violations in tests become explicit, commented casts, not suppressions.
6. Lint covers `.ts` (`eslint --ext .js,.ts`); lower the package's budgets.

## Lessons from phases 0–3

- **A deploy snapshots whatever is checked out.** A broker release went out
  from an unmerged branch because the working copy was left on it. Always
  return the checkout to `main` after branch work.
- **`tsc` writes files without the execute bit**, and the runtime image ran
  `npm ci` before `dist/` existed, so a `dist/` bin could not run.
  `npm run build` now marks bin targets executable
  (`scripts/fix-bin-modes.js`) and Dockerfiles copy `dist/` before the
  production install.
- **New candidate tag URLs propagate gradually**: a request can get Google's
  HTML "Error: Page not found" 404 without reaching the container. The verify
  helper retries only that response (`verify/lib.js`).
- **Build info outside `dist/` hides missing output**: deleting `dist/` did not
  force a rebuild. Build info now lives in `dist/`; `npm run build:clean`
  removes every project's outputs first.
- **A CLI `--testPathIgnorePatterns` replaces a jest config's own list**: it
  made the root run sweep every spec in the repo. Root jest relies on its
  config (which ignores `packages/`, `languages/`, `verify/`, `.claude/`).
- **`node --test` files named `*.test.js` are picked up by jest** unless their
  directory is ignored (the `verify/` incident).
- **Prereleases stay out of ranges**: `auth-react`'s peer `^2.1.2` rejects
  `2.2.0-ts.0`, so consumers testing a prerelease need `--legacy-peer-deps`;
  the stable release will satisfy the range.
- **npm one-time passwords expire in about 30 s**; relaying them through a
  chat is unreliable. Publish from your own terminal (npm prompts for the
  code) or paste a fresh code straight into `--otp=`.

## Real bugs found

Both were in code nothing exercised, and are now resolved:

- **`api/src/util.js` `statusCodeFromErrors` / `messageFromErrors`** iterated
  with `for (const err in errs)` (array indices), so they always returned
  `500` / `"Internal error"`. Nothing imported them: deleted.
- **`api/src/cache.js` `buildLocalCacheDel`** called `delegate.set(id, type)`
  instead of `delegate.del(id, type)`. Dormant (nothing imports `cache.js`);
  fixed, with `cache.spec.js`. (Found by reading, not by the checker.)

Also recorded by the phase 0.3 characterization tests: `api/src/code.js`
`objectToCode` is unused and returns `{ root: 0 }` for any non-empty input.

## False-positive classes (where phase 3 typing removes the suppressions)

| Class | Lines | Fix during conversion |
|---|---|---|
| Destructured parameter with `= {}` default: optional fields read as missing | 36 | Declare the parameter's type with optional fields |
| `new Router()`: Express's `Router` is callable and its types reject `new` | 27 | Call `Router()` (identical at runtime) in a reviewed non-mechanical PR, or keep a typed wrapper |
| `await res.json()` is `unknown` (api invocations/routes/utils, broker learnosity) | 8 | Type the response shape at the boundary |
| Custom `code` / `statusCode` on `Error` (auth/client, auth-client, api routes/lang) | 3 | Error subclasses with declared fields |
| Callee ignores an argument (`auth/src/app.js`, `auth-client/src/v1/index.js`, `deploy/src/release.js`) | 3 | Drop the argument or declare the parameter |
| One item or an array (`api/src/routes/compile.js`) | 2 | Type the union and narrow it |
| Literal-typed registry backends (`policy/src/config.js`) | 1 | Widen the `Set` element type |
| ajv default export under NodeNext (`api/src/lang/validate-output.js`) | 1 | Import the named class |
| `num2dot` reuses a number variable for a string (`api/src/util.js`) | 1 | Separate variable |
| Dynamically built headers (`deploy/src/release.js`) | 1 | Type as `Record<string, string>` |
| Assigned in the `listen` callback before use (`auth/src/testing/app.js`) | 1 | Non-null assertion or restructure |

Run `npm run typecheck` to see each package's result and budget.
