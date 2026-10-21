# Graffiticode

Graffiticode exposes task-specific APIs as languages. A program describes a task in a language's vocabulary; its compiler produces structured data that a client can render, pass to another compiler, or use to perform an authorized operation.

This repository contains the API gateway, authentication service, capability Policy and Broker, shared packages, language implementations, and deployment tools. Language compilers share a base syntax and extend it with their own lexicons, checkers, transformers, and browser views.

## Repository layout

- [`packages/api`](packages/api) — HTTP gateway: stores tasks, composes compiler pipelines, serves results and forms, and coordinates protected execution.
- [`packages/auth`](packages/auth) — authentication, access and refresh tokens, API keys, OAuth, and linked accounts.
- [`packages/auth-client`](packages/auth-client) — client-side authentication helpers.
- [`packages/common`](packages/common) — shared HTTP, error, canonicalization, and execution-contract utilities, including the authoritative [protected-function registry](packages/common/src/protected-registry.ts).
- [`packages/policy`](packages/policy) — connections, grants, chain admission, and capability issuance and live authorization.
- [`packages/broker`](packages/broker) — encrypted provider credentials, constrained provider operations, and durable write receipts.
- [`packages/deploy`](packages/deploy/README.md) — the workspace release and rollback CLI for Google Cloud Run.
- [`languages`](languages) — language workspaces. [L0000](languages/l0000/README.md) supplies the base TypeScript compiler and view harness; child languages add domain vocabulary. Rust implementations live under each participating language's `crates/` directory and deploy as separate `lNNNNr` services.
- [`configs`](configs), [`deploy`](deploy), [`scripts`](scripts), and [`verify`](verify) — container builds, egress infrastructure, operator tools, and candidate verification.

The root npm workspace contains the seven `packages/*` entries listed in [package.json](package.json). Language directories have their own npm workspaces and lockfiles; install, build, and test them separately. The console and MCP server are separate client applications.

## Tasks and compiler pipelines

A task contains a language identifier and a parsed program:

```js
const task = { lang: "0000", code: nodePool };
```

`code` is a JSON object, normally an AST node pool produced by `@graffiticode/parser` using the language's lexicon. The gateway rejects source strings as `task.code`; parsing belongs to the client. Language specifications and examples live in each language's `packages/core/spec/` directory.

Tasks are stored in Firestore and deduplicated by a canonical SHA-256 hash of `{ lang, code }`. The API returns an opaque identifier; clients should retain that identifier rather than construct one from the hash.

Combine task IDs with `+` to form a pipeline:

```js
const pipelineId = `${id0}+${id1}+${id2}`;
```

Execution proceeds from right to left: `id2` receives `{}`, its output becomes the input to `id1`, and `id1`'s output becomes the input to `id0`. The gateway sends each task to its language server's `POST /compile` endpoint with `{ code, data }`. Language servers also serve their browser forms and public assets.

### Store and retrieve a task

`/task` and `/tasks` are aliases. Wrap one task in `task`, or a list in `tasks`:

```http
POST /tasks
Content-Type: application/json

{
  "task": {
    "lang": "0000",
    "code": {
      "1": { "tag": "STR", "elts": ["hello, world!"] },
      "2": { "tag": "EXPRS", "elts": [1] },
      "3": { "tag": "PROG", "elts": [2] },
      "root": 3
    }
  }
}
```

The response is `{ "status": "success", "data": { "id": "<task-id>" } }`. For multiple tasks, `data.id` is an array of IDs. Retrieve tasks with `GET /tasks?id=<task-id>`; the response's `data` is a list of tasks.

### Compile and view results

Compile a stored task or pipeline, optionally supplying input data:

```http
POST /compile
Content-Type: application/json

{ "id": "<task-id>", "data": {} }
```

The gateway stores supplied input as an L0000 data task, appends it to the pipeline when nonempty, and returns `{ "status": "success", "id": "<pipeline-id>", "data": ... }`. It also accepts an inline `{ "lang": "0000", "code": <node-pool>, "data": {} }` item, or a batch of items. Compile errors can appear inside `data.errors`; an HTTP 200 alone does not establish that the program succeeded.

`GET /data?id=<task-id>` retrieves a result, compiling when needed for an ordinary task. `GET /form?id=<task-id>` opens the language's form. A task's stored program is immutable, but its compiled result can change with compiler revisions, input, permissions, or expiring provider signatures. Ordinary results may be cached; protected or volatile results bypass the shared compile cache. `POST /compile` responses use `Cache-Control: no-store`.

An authenticated `GET /data?id=<task-id>&refresh=1` forces an ordinary recompile and refreshes its cached result. A connection view (`GET /data?id=<task-id>&connection=<connection-id>`) reads the caller's stored artifact; it does not rerun the original program. A publication view uses `&publication=<publication-id>` and the publication's stored artifact. Views may freshly sign stored preview content under live authorization. Use `POST /compile` for an explicit run through a connection.

See the [gateway routes](packages/api/src/routes) and [execution path](packages/api/src/data.js) for the full request and result contracts.

## Authentication and protected operations

Send an access token as `Authorization: Bearer <access-token>` for private tasks and account-specific operations. Public tasks can be read anonymously. Tasks created anonymously are public; authenticated creation adds the caller to the task's access list, and a newly created authenticated task starts private. Reposting content that is already public does not make it private.

The auth service supports wallet authentication, Google authentication for linked accounts, API-key exchange, and OAuth flows. For programmatic access, `POST /authenticate/api-key` on the auth service accepts `{ "token": "<api-key>" }` and returns `data.accessToken` and `data.firebaseCustomToken`. API keys are exchanged for access tokens rather than sent directly to the gateway. The current routes and clients are in [`packages/auth/src/routes`](packages/auth/src/routes) and [`packages/auth/src/client`](packages/auth/src/client).

To run a task through a user's connection, include `connectionId` and a stable retry key:

```http
POST /compile
Authorization: Bearer <access-token>
Idempotency-Key: <stable-key-for-this-run>
Content-Type: application/json

{ "id": "<task-id>", "connectionId": "<connection-id>" }
```

Policy checks the connection owner's permissions or the recipient's scoped grant. The gateway preflights every stage of a connection-backed chain and obtains admission before any stage executes, pinning compiler revisions and program digests. Each protected operation then requires an argument-bound, single-use execution capability lasting at most 60 seconds.

Broker holds provider credentials and asks Policy for a fresh decision before each provider step, signature, or receipt replay. Writes claim durable receipts before dispatch. Retry the same run with the same idempotency key to retain its invocation and replay recorded writes; a new key starts a new run and may repeat effects. Partial and uncertain outcomes remain visible. This provides safe Broker retries, without provider transactionality or rollback of dispatched operations.

L0176 previews without a selected connection use limited system preview sessions. Those sessions allow preview signing only; item-bank writes require an authorized user connection.

Compiler internet traffic passes through the ISOLATE-01 egress proxy. Strict classes allow listed hosts. D2 open classes—L0185, L0185r, and legacy L0137 and L0170—permit public hosts subject to denied names and private-address controls. Direct Learnosity access is blocked, while compilers reach their metadata server directly for identity tokens.

Start with the [70-second capability animation](docs/capability-animation/index.html). The [security specification](docs/graffiticode_capability_policy_spec.md), [conformance record](docs/capability-policy-as-built.md), [protected-execution runbook](docs/protected-execution.md), and [egress-proxy runbook](deploy/egress-proxy/README.md) document the requirements, deployment evidence, and operational procedures.

## Local development

Use the Node version pinned in [`.nvmrc`](.nvmrc) and Java 21 for the Firebase emulators, matching CI.

```sh
git clone git@github.com:graffiticode/graffiticode.git
cd graffiticode
nvm use
npm ci
npm run build
```

Build before starting services or tests: shared packages, auth, Policy, and Broker load compiled modules from `dist/`. For incremental builds while editing, run `npm run dev:build` in another terminal.

Start the emulators, auth service, and gateway in separate terminals from the repository root:

```sh
# Terminal 1: Firestore :8080 and Firebase Auth :9099
npm run emulator

# Terminal 2: auth :4100
npm run auth

# Terminal 3: gateway :3100
npm run api
```

The service dev scripts set their emulator addresses; the gateway uses local auth at `http://127.0.0.1:4100`. Compiler dispatch uses configured or public language hosts by default. To run L0000 locally, install and build its separate workspace, then start its language server:

```sh
cd languages/l0000
npm ci
npm run build
npm run dev
```

L0000 listens on port `50000`. Restart the gateway with an explicit language URL from the repository root:

```sh
BASE_URL_L0000=http://127.0.0.1:50000 npm run api
```

Use `BASE_URL_LNNNN` to redirect another language, or `LOCAL_COMPILES=true npm run api` to route all languages to `localhost:5NNNN`. These development overrides apply to ordinary compiles; protected admitted plans use approved compiler revisions.

The basic local setup covers tasks and ordinary compilation. Connection-backed execution also needs configured Policy and Broker services, service caller identities, signing keys, stores, and provisioned connections. Follow the [protected-execution runbook](docs/protected-execution.md) for that environment.

## Validation

Run these commands from the repository root after `npm ci`:

```sh
npm run build
npm run typecheck
npm run lint
npm run lint --workspaces --if-present
npm run test:unit
npm run test:compiled
npm run test:deploy
npm run test:egress-proxy
node scripts/check-egress-clients.js
npm run test:verify
npm run test:scripts
```

The emulator suites run in one session per command. Stop manually started emulators before running them:

```sh
npm run test:ci:emulated
npm run test:ci:compiled-emulated
```

[`scripts/test-targets.json`](scripts/test-targets.json) defines source and compiled-output Jest targets and allowed skips. `npm test` alone runs the root suite; the grouped commands above cover the workspace packages. `npm run test:at12-rollback` additionally checks mixed-version capability cutover and rollback against the historical W3 builds and requires full Git history.

Language tests run from their own directories, for example `cd languages/l0000 && npm test`. Participating Rust workspaces also provide `cargo test`. The [CI workflow](.github/workflows/ci.yml) is the reference for the full validation matrix, including production container checks.

## Deployment

Service settings, runtime identities, security baselines, and network controls live in [`deploy.json`](deploy.json). Preview a release locally:

```sh
npm run deploy -- api --plan
```

The shared CLI freezes the workspace source, runs builds and tests in Cloud Build, deploys an exact image digest to a candidate revision, verifies it, and promotes traffic. Release receipts live under `.gc-deploy/releases/`.

```sh
npm run deploy -- api
npm run deploy -- l0176 --stage
npm run deploy -- promote l0176 --release <release-id> --evidence <file>
npm run rollback -- api --release <release-id>
```

Normal releases require a clean workspace. Compiler staging and promotion include reviewed egress evidence; rollback enforces the configured security and network constraints. Existing `gcp:<service>:build` and `gcp:<service>:deploy` scripts are compatibility aliases for a complete release. Either command performs the release, so use one per release.

Read the [deployment CLI documentation](packages/deploy/README.md) for infrastructure prerequisites, candidate checks, staging, promotion, and recovery.
