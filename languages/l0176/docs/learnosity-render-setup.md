# Learnosity rendering & item-bank credentials

What makes L0176 forms render: a compile-time signing step, done by the
credential broker — through the caller's connection, or without one through a
system preview session. (First diagnosed after forms rendered blank and
`save-to-itembank true` hung the console on "Loading…".)

## Signing is folded into the compile

Unlike L0158 — whose own view did a second `init data {}` compile pass to sign —
L0176 renders through the shared `@graffiticode/l0000-view`, which issues **one**
`POST /compile` and hands the result to the Form verbatim. So the compile output
must already carry a signed `request`.

`signForRender()` in `packages/core/src/compiler.ts` (`PROG`) has the broker
sign the `{ type, data }` activity (see "Who signs" below) and attaches
`request`. Without it, `state.data.request` is `undefined` and the Form
renders blank.

Each signing stamps a fresh `user_id` / `signature` / `timestamp`, so `request`
changes on every (re)compile even when the assessment is unchanged. That churn
is why the Form keys its one-time `LearnosityApp.init` on stable question content
rather than object identity — see
`packages/view/src/components/form/contentKey.ts`. Re-initializing on
already-mounted DOM throws Learnosity's `triggerBufferedEvents` error.

## Which is why L0176 compiles are never cached

A signature that is stamped at compile time expires on a timer, so a *cached*
compile eventually hands the browser a dead token and the form renders blank —
and the initial render reads `GET api/data?id=…` (the shared `l0000-view`'s
mount fetcher), which was held by three caches: the Firestore `compiles/{id}`
record, the browser (`Cache-Control: …immutable`), and the Cloudflare cache rule
on `api.graffiticode.org/data`.

L0176 defuses all three by answering **`cache: false`** in its compile envelope
(`packages/api/src/compile.ts`) — a language declaring that its own output goes
stale. The api (`packages/api/src/data.js`) strips the directive, skips the
Firestore write, and sends `Cache-Control: no-store` instead of the immutable
headers. Every render therefore recompiles and re-signs.

Two consequences:

- L0176 wants `min-instances=1` on Cloud Run — a cold start is now on the render
  path for every view, not just the first.
- The Form must keep keying `LearnosityApp.init` on stable question content
  (`packages/view/src/components/form/contentKey.ts`), since `request` churns on
  every one of these recompiles.

Any other dialect that signs or timestamps its output opts in the same way; the
api has no language list.

## Who signs: the broker, never the compiler

L0176 holds no Learnosity secret. Every signature is made by the credential
broker (graffiticode `packages/broker`) under a short execution token minted
by the policy authority (`packages/policy`):

- **A compile that selects a connection** signs (and writes, and opens Author)
  with that connection's credential — the `snapshot`/`mint` path.
- **A compile with no connection** asks policy for a **system preview session**
  (`POST /v1/preview-session { lang }`, compiler identity only, no user token).
  Policy binds it to the Graffiticode-owned system connection configured for
  the backend (`POLICY_SYSTEM_CONNECTIONS`, e.g. `{"learnosity":"conn-…"}`)
  and confines it to the language's system-preview functions — for L0176,
  `preview-itembank` only. It can sign an Items or Questions preview and
  nothing else: never `save-to-itembank`, never an Author session. The compiler
  then signs with the same `brokeredSign` the connection path uses
  (`packages/core/src/protection.ts`, `systemPreviewSign`).
- **No session** (policy not configured on this server, no system connection
  configured, the connection disabled, policy unreachable) or a failed
  signing: the activity comes back **unsigned**, with
  `signing: { unsigned, message }` beside it. It is not a compile error; the
  item still compiles, but the Form cannot render an unsigned request.

The service needs `POLICY_URL` and `BROKER_URL` (see root `deploy.json`), and
policy must list the `l0176-run` service account as a `compiler` for `0176`.
The signing `domain` (`l0176.graffiticode.org`) is the broker's, and must be
whitelisted for the consumer key of every connection, the system one included.

`LEARNOSITY_KEY` and `LEARNOSITY_SECRET` are no longer read. The deploy CLI
keeps settings a `deploy.json` entry does not mention, so remove them from the
running service explicitly once this ships.

## Program-supplied credentials are ignored

`set-var "learnosity-key"` / `set-var "learnosity-secret"` (literal,
`get-val-public` or `get-val-private`) still compile — L0000's `SET_VAR` writes
them into `options` — but nothing reads them: they sign nothing, and supplying
only one is no longer an error. So is a `config.learnosity` in the compile
request. Old programs keep compiling and are signed like any other.

`get-val-private` itself is unchanged: it is L0000's generic `decrypt()`, keyed
by `GRAFFITICODE_SECRET_KEY` (and `GRAFFITICODE_SECRET_KEYS` for later key
versions). L0176 no longer needs it for signing. It is still mounted because
removing it would change what `get-val-private` returns for any other name —
without the key, `decrypt()` leniently returns the ciphertext unchanged rather
than failing. Drop it once no L0176 program depends on a private value. If it
is kept, propagate it with the console script — never set it by hand (it must
match the console's key in project `graffiticode-app` and must never change):

```
console/scripts/set-compiler-secret.sh 0176
```

## Robustness

`ITEMS` / `QUESTIONS` wrap `createItems` / `createQuestions` in try/catch and
`resume` with a compile error on failure. A throwing item-bank write would
otherwise escape the CPS callback as an unhandled rejection — `resume` never
gets called, the compile never resolves, and the embedding view hangs on
"Loading…" forever.

## Deploy

```
npm run gcp:build
```
