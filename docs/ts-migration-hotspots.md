# TypeScript migration: phase 1 hotspots

Phase 1 ran `checkJs` (no emit, not strict) over every workspace package with
TypeScript 5.9.3. It produced 110 errors on 90 lines (some lines carry two). Each is suppressed with
`// @ts-expect-error TS-MIGRATE: <reason>`; `npm run typecheck` enforces the
per-package budget in `scripts/ts-migrate-budget.json`, so the count can only
fall. Phase 3 conversions should remove the suppressions in the files they
touch by typing the code, not by moving the comment.

| Package | Suppressions |
|---|---|
| common | 0 |
| auth | 20 |
| auth-client | 8 |
| policy | 7 |
| broker | 3 |
| deploy | 8 |
| api | 37 |

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
