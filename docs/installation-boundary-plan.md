# Installation boundary: the backend's half of P5

**Status:** draft, revised after the owner's first review (2026-11-19). Implementation not started.

**Owner's review of the first draft (2026-11-19).** Three findings and four decisions, each resolved below:
1. **Broker's shared item resources are isolated** (I-4, "Shared item resources"):
   - the capture counter and the published thumbnail are scoped by installation, and Graffiticode's paths are kept;
   - until that is built, Policy refuses item-scoped work for every other installation.
2. **The strict identity switch covers every protected path** (I-8), not only command routes: `/compile`, `/data` and the bridge too, wherever they allocate, execute or replay.
3. **Internal keys are authorized by route** (I-5). The legacy OAuth and migration routes accept Graffiticode's key only, the inventory included after the seal.

Decisions:
- connections are scoped to the installation that creates them;
- the registry is one pinned Secret Manager document, with coordinated rollout and withdrawal (I-1);
- a request with only a user token counts as Graffiticode only while it is the sole installation; this is enforced mechanically, and an invalid identity is always refused (I-8);
- Broker takes installation context for item resources (I-4).

**Owner's review of the second draft (2026-11-19).** Two findings, each resolved below:
1. **Strict identity is a deployment and rollback guard, not only a code floor** (I-8).
   - Leniency is an explicit environment setting, and strict is the default.
   - At I6 the setting is removed and listed in gc-deploy's `forbiddenEnv` for api, policy and auth.
   - From then on, no revision carrying it can be promoted or rolled back to, whatever its commit. That includes a configuration rollback from the same commit, refused before traffic moves.
2. **Non-Graffiticode item counters get their own collection hierarchy** (I-4). Item ids may contain `:` (`ITEM_ID_RE`), so a prefix inside `item-captures` could collide with a Graffiticode item.
**Spans:** `graffiticode` (this repo: common, api, policy, auth, deploy) and `graffiticode-app` (the frontends' servers).
**Source:** graffiticode-app `docs/installations-plan.md`, P5, "Installation context, carried end to end", and decision D-I3. This plan details it against [`execution-observation-plan.md`](execution-observation-plan.md) (D-3) and [`c5-l0013-commands-plan.md`](c5-l0013-commands-plan.md) (C5a and its order).

## Why

Several frontends ("installations") will call this backend. Graffiticode is the only one today; Artcompiler (P6, project `artcompiler-app`) is next. Each has its own users' items, jobs and connections. Registering an installation isolates nothing by itself. Every backend request must carry an **authenticated** installation context, and every check must enforce it, so that one installation can never read, replay, repair or act on another's records. P6 waits until this is deployed.

## Where we start

The survey was taken at `78621ec8`, with the claims below spot-checked.

- **Keys come from `uid` alone.**
  - Command ids: `commandIdFor(uid, key)` is `c:` plus `sha256(JSON.stringify([uid, key]))` (`policy/src/commands.ts:82-83`).
  - Key allocations: `idempotency-keys/{hashId([uid, key])}`.
  - Invocation sequences: `hashId([uid, taskId, connectionId])` (`policy/src/firestore.ts:47-48`).
  - Every anonymous caller shares `uid = "anonymous"`.
- **The admission binding is `{ connectionId, taskId, inputDigest }`** (`commands.ts:126`), plus admission's `planDigest`. No principal beyond the uid, no deadline, no scope digest (D-3 isn't built), and no installation.
- **Reads check the uid, and only when a user is present.**
  - `getCommand` returns `command-not-found` for another user's command (`policy.ts:1136-1146`). With no user, the API's own `gateway` role reads any command.
  - `commandRead` (records, evidence, ledger) checks only the role (`policy.ts:558-598`).
  - `allocateRepair` and `reconcile` compare uids (`policy.ts:394-477`, `2073-2123`).
- **The API knows users, not frontends.**
  - The API keeps only `uid` from auth's `/oauth/verify` (`api/src/auth.js:34-38`).
  - Apart from the sweep route, no request carries a calling service's identity.
  - Policy sees one caller, the API's `gateway` role, for every command.
  - The frontends reach Policy directly only as `console`, for connections and `reconcile`.
- **Connections** (`connections/{id}`: `ownerUid`, `backend`, ...) are checked by `accessFor` (`policy.ts:264-275`), keyed only by owner and grants.
- **Item resources are keyed by item id alone.**
  - Policy's capture counter is `item-captures/{item}` (`policy/src/command-records.ts:41`, `firestore.ts:208`).
  - Broker publishes `{item}.png` in one shared bucket, with the capture sequence in the object's metadata (`broker/src/gcs.ts:99`, `:110-141`).
  - Staging is `{commandId}/{stage}/{occurrenceId}.png`, which installation-distinct command ids already separate.
- **`/compile` and `/data` can allocate.**
  - `GET /data` is among the API's public reads (`api/src/routes/auth.js:8`).
  - A compile, and the data a pipeline resolves, can still enter the command bridge or allocate an invocation (`routes/compile.js`, `commands/bridge.js`): connectionless item-scoped chains run there (C5e).
- **Item authority** is one global endpoint: `ITEM_AUTHORITY_URL` and `_AUDIENCE` (`policy/src/main.ts:95-97`), pointing at the Graffiticode console.
- **Act-as.**
  - Grants are HMAC'd with one shared `ACT_AS_GRANT_SECRET` (`common/src/act-as.ts`).
  - Callers are one `ACT_AS_CALLERS` map. Its `role` is parsed but never checked (`auth/src/act-as-config.js`).
  - The issued token's `act` claim carries no installation.
- **`INTERNAL_API_KEY`** is one shared key, checked only by auth (`auth/src/middleware/internal-auth.js`). Every route behind it accepts any valid key:
  - the legacy OAuth routers (`/oauth-tokens`, `/oauth-clients`, `/oauth-pending`, `/oauth-codes`);
  - `/oauth-migration/v1`, whose inventory stays readable after the seal;
  - `/linked-emails`'s internal routes;
  - `/authenticate/internal/exists`.
- **Service identities already have one verifier:** `createCallerIdentity` (`common/src/caller.ts:54-83`). It checks a Google ID token in `X-Caller-Identity` against a map from email to role. Policy has its own map (`POLICY_CALLERS`, with roles `gateway`, `console`, `compiler` and so on), and so do Broker and act-as.
- **Rollout guards already exist and work.**
  - **Capability markers on records, enforced by `ownableBy`** (`commands.ts:150-154`). A record can require a worker capability (`recording`, `repairs`, `scopes`), and a worker without it fails closed (`worker-unsupported`). `listDue` filters the same way.
  - **Contract minimums** (`POLICY_MIN_CONTRACT_VERSION`).
  - **gc-deploy's floor baselines and cross-service `requires`.**
- **Not built:** runs, save heads (D-2, D-5), service scope (D-3), and any client or installation registry. The only installation concept in this repo so far is auth's OAuth-store migration (`LEGACY_INSTALLATION = "graffiticode"`).

## Decisions

**I-1. One registry, one source.**
- **What it is:** an installation registry, a JSON document in Secret Manager (`installation-registry`, pinned by version like every secret), mounted into api, policy and auth. It holds no secret values, only references to them. Each entry:
  - `id` (`^[a-z][a-z0-9-]{1,62}$`, as in auth's migration routes);
  - `callers`: the service-account emails of that installation's frontend servers, for each of api, policy and act-as, with the role each may hold;
  - `itemAuthority: { url, audience }`;
  - `actAsSecret` and `internalKey`: the names of that installation's own secrets.
- **Who owns what:**
  - `packages/common` owns its schema, its parser and the shared helpers (I-3).
  - Each service reads its pinned version at startup and refuses to start on an invalid one.
  - The operator owns the values.
- **Why one source:** within a document, the parser catches the same caller mapped to two installations, a reference to a missing secret, and a malformed entry. Separate maps in each service can't be checked against each other.
- **Across services, one version.** The parser can't see what other services pinned, so the version is checked where it can be seen:
  - **Revisions.** The document carries a `revision` that only increases. Each service reports the revision it loaded on its health route.
  - **One pinned version.** api, policy and auth must pin the same `installation-registry:N` in `deploy.json`. A check fails `release-check` for any of them while their pinned versions, or the versions their reachable revisions run, differ. It is a gc-deploy check, like `requires`.
  - **Unknown means refused.** Every service refuses an installation it doesn't know, so a service on an older version fails closed rather than misattributing.
- **Adding an installation** is rolled out in this order: Policy, then auth, then the API. The API attests last, so no request reaches a service that doesn't know the installation yet.
- **Withdrawing an installation** goes in the reverse order: the API stops attesting it first, then auth, then Policy. Its records stay tagged and unreachable, and are never reassigned to Graffiticode. Re-adding it under the same id makes them reachable again.

**I-2. The installation comes from a verified service identity, never from a request.**
- **At the API.** A frontend server calls the API with its user's token, as today, and also with `X-Caller-Identity`: a Google ID token for its own service account, with audience `urn:graffiticode:api`. The API verifies it with `createCallerIdentity` against the registry. The verified email names the installation.
- **To Policy.** The API passes the installation as an attested field on its `gateway` calls. Policy accepts the field only from the `gateway` role, and never from request bodies or other roles.
- **Directly at Policy.** For the routes the frontends call themselves (`console`: connections, `reconcile`), the installation comes from the caller's own registry entry.
- **The rule:** nothing in a body, a prompt, or a user's token names an installation.

**I-3. Absent means Graffiticode, everywhere, and Graffiticode's derivation never changes.**
- **Records.** A record without an `installation` field is Graffiticode's. This covers command records, key allocations, invocation sequences, connections, grants, ledger and reconciliation records. The helper `installationOf(record)` (common) applies the rule in one place.
- **Keys.**
  - `graffiticode` keeps today's derivation exactly: `[uid, key]`, `[uid, taskId, connectionId]`. Every key issued before the change finds its record, with no aliases and no rewriting.
  - Every other installation derives from `[installationId, uid, key]`. The JSON arrays have a different length, so the two derivations can't collide.
  - The anonymous namespace is per installation by the same rule.
- **The admission check** also compares the stored installation (absent means `graffiticode`). A non-Graffiticode caller therefore can't reach an unprefixed record even by constructing its key.

**I-4. Enforcement in Policy.**
- **Allocation.** `installation` joins the immutable binding beside `connectionId`, `taskId`, `inputDigest`, and later D-3's scope digest. A key reused under another installation is impossible by derivation. A record whose stored installation disagrees is refused.
- **Reads.**
  - `getCommand`, `commandRead`, evidence, ledger and reconciliation reads need the uid and the installation to match. A mismatch reads as `command-not-found`, keeping FAIL-01's `permission` classification.
  - The API's own unattested reads (sweep, materialize) stay internal and act on the record's installation.
- **Repair, materialize, reconciliation and dispatch** inherit the original's installation and must match the caller's. D-2's dispatch commands, when built, do the same.
- **Connections.**
  - A new connection records the creating installation.
  - `accessFor` refuses a connection, or a grant, from another installation (`connection-installation-mismatch`, `permission`).
  - This is D-I3's default: connections are scoped to the installation that made them.
- **Item authority** asks the registry entry of the record's installation, never one fixed console. Graffiticode's entry is today's `ITEM_AUTHORITY_URL`.
- **Shared item resources.** Item ids are an installation's own, so two installations can use the same one. Everything keyed by an item is scoped by installation:
  - Policy's capture counter, `item-captures/{item}`, plus any per-item rate limit and reservation;
  - Broker's published thumbnail, `{item}.png`, and the evidence that names it.

  Graffiticode keeps today's names, by I-3. Every other installation's records live in a separate hierarchy, never inside Graffiticode's namespace:
  - **Policy:** `installation-item-captures/{installation}/items/{item}`, and the same shape for any other per-item record. A prefix inside `item-captures` would collide, because item ids may contain `:` (`ITEM_ID_RE` is `^[A-Za-z0-9_:.-]{1,200}$`). Graffiticode's item `artcompiler:example` and Artcompiler's item `example` would both be `item-captures/artcompiler:example`.
  - **Broker:** `{installation}/{item}.png`. A Graffiticode object name, `{item}.png`, never contains `/`, and every other installation's always does, so they can't collide.
  - **Item ids must be validated the same way everywhere.** Today Broker checks items against a narrower pattern, `^[A-Za-z0-9_-]{1,128}$` (`broker/src/gcs.ts:65`), than Policy's `ITEM_ID_RE`. So Broker refuses to publish an item Policy authorizes, such as one containing `:` or `.`. I2b makes both use one shared pattern from `packages/common`: Policy's, which excludes `/` and so keeps every object name slash-free.
  - **Where Broker gets the installation:** from Policy's signed execution token, which gains an installation claim. Never from the payload or the compiler. The evidence records the object it wrote, so reconciliation and repair read the right one.
  - **The console's thumbnail base** is per installation already (the profile's `hosts.thumbnails`).
  - **Until Broker's slice is released,** Policy refuses item-scoped intents (`snap`, `gcs.put-thumbnail`) for any installation other than Graffiticode (`item-scope-unavailable`, `unavailable`). The capability is off, not shared.
- **D-5's runs and save heads**, when built, carry the installation in the same binding, and are keyed so installations never share a head. This plan only fixes the rule; D-2 and D-5 implement it.

**I-5. Act-as and internal credentials are per installation.**
- **Grants.**
  - A grant gains an installation: format `act-as.v2`, with field `i`.
  - Each installation signs with its own secret (`actAsSecret`).
  - Auth refuses a grant whose installation isn't the presenting caller's.
  - The issued token's `act` claim carries the installation, and the API refuses a request whose `act` installation disagrees with its attested one.
  - `act-as.v1` grants are accepted only from Graffiticode's callers, under Graffiticode's secret, until every Graffiticode producer sends v2.
- **Internal keys are authorized by route.** Auth accepts a key per installation (`internalKey`) and knows whose each key is. A key's owner decides only what that key may reach, and each route lists its installations:
  - **Graffiticode only:**
    - the legacy OAuth routers (`/oauth-tokens`, `/oauth-clients`, `/oauth-pending`, `/oauth-codes`);
    - every `/oauth-migration/v1` route, the inventory included, before and after the seal;
    - `/v1/refresh-tokens/clean-expired`'s internal-key fallback (its own `CLEANUP_API_KEY` is unchanged, [I5a](#i5a-auths-preparation-inert)).

    These hold Graffiticode's legacy records or auth's own maintenance, and no other installation ever has any there.
  - **Granted explicitly:** every other internal route (`/linked-emails` internal, `/authenticate/internal/exists`, and any later one) is reachable only by the installations its entry in the registry grants. A route with no grant for an installation refuses its key (403), as if the key were wrong.
  - `INTERNAL_API_KEY` stays Graffiticode's. Auth's authenticator only skips user-token parsing for internal-key requests (`auth/src/routes/auth.js:10`). Authorization stays with each route, which now checks the key's installation too.

**I-6. Untagged records: the rule first, then an optional backfill.**
- **The rule needs no backfill.** I-3 makes an untagged record Graffiticode's, invisible to every other installation, before and after any backfill.
- **The backfill** sets `installation: "graffiticode"` on untagged records, so the rule's fallback can be removed later. It is:
  - idempotent;
  - verified by counts before and after, for each collection;
  - run only once every writer tags (I-7).

  Until then, removing the fallback is out of scope.

**I-7. Rollout guard and floors (D-3's mechanism).**
- **Marker.** A command record of a non-Graffiticode installation carries a required-capability marker, `installations: 1`. Workers declare the capability, and `ownableBy` and `listDue` refuse it to workers without it (`worker-unsupported`), exactly as `scopes: 1` works today. Graffiticode records carry no marker, so an older worker handles them as it does today.
- **Floors.** Each enforcing service gets a floor baseline, `I-installations`, at its enforcing release's merge commit:
  - Policy and the API;
  - Broker, for item resources (I2b);
  - auth, for act-as v2.

  `requires` makes the API depend on Policy's milestone. A rollback below a floor is refused.
- **The registry holds only Graffiticode** until every floor is installed and `release-check` passes for every enforcing service. Adding a second installation's entry is the activation step (I7).

**I-8. Strict identity covers every protected path.**
- **Protected means:** anything that can allocate an invocation or a command, execute, replay, repair, materialize or reconcile, or read non-public evidence. That includes:
  - `POST /command` and its routes;
  - `POST /compile`;
  - `GET /data` and any pipeline compile that reaches the command bridge;
  - the bridge itself;
  - connection writes.

  The check sits where the API asks Policy for any of these (`allocate`, repair, materialize, admission and the bridge's `runCommand`), not on route names. So a new entry point can't miss it.
- **Public reads stay exempt:** a public task, its form, a language asset, and a compile that allocates nothing. They serve only public content, as today.
- **A supplied identity that fails verification is always refused** (`unauthenticated`), on every route, public or not, and never downgraded to anonymous or to Graffiticode.
- **No identity at all** on a protected path is read as Graffiticode only while the service runs with an explicit leniency setting, `INSTALLATION_IDENTITY_LENIENT=1`, set in `deploy.json` only for I3–I6. Without it, strict is the default.
- **Three guards keep leniency from coming back:**
  1. **At startup.** A service refuses to start with leniency set and a registry listing more than Graffiticode.
  2. **At deploy.** At I6, the setting goes into `removeEnv` and into `forbiddenEnv` for api, policy and auth. gc-deploy then refuses, with no override and whatever the commit:
     - to promote a candidate carrying it, inherited or set;
     - to roll back to any revision that carries it;
     - and `release-check` fails while one is reachable.

     So restoring an I3-era configuration is refused before traffic moves, even from the same commit (`packages/deploy/README.md`, `forbiddenEnv`).
  3. **Older registry versions fail closed.** A revision of the same commit that pins an older registry has no leniency setting, so it stays strict. It doesn't know a newer installation, so it refuses that installation's requests rather than reading them as Graffiticode's.

  The registry is registered for a second installation (I7) only after I6's guard is in `deploy.json` and `release-check` passes.

## Sequencing

This fits the backend's existing order. It doesn't disturb C5:
- C5d's staged drive and activation change Policy's command allocation. The boundary's Policy slices (I2) land after C5d activation step 5. Until then, only the inert slices (I1, I5a) and documentation proceed.
- D-3 (W1) builds on the registry. Its "registered client identity" is the installation's registered caller (I-2). So the boundary's I1–I3 come before D-3's scope work, as W1's first step, and D-3's binding adds the scope digest beside the installation.

| Slice | Repo | Contents | Behavior change | Gate |
| --- | --- | --- | --- | --- |
| I0 | this repo | This plan. [`execution-observation-plan.md`](execution-observation-plan.md) now cross-references it: D-3's issuer is the installation's registered caller, and W1 starts with I1–I3 | none | owner's review |
| I1 | common | Registry schema and parser, `installationOf`, installation-aware key helpers (Graffiticode's unchanged), act-as v2 types | none (inert) | unit tests: v1 and Graffiticode derivations byte-identical |
| I2 | policy | Tagging, binding, read, repair and reconcile checks, connection scoping, item authority and item resources per installation (`item-scope-unavailable` for others until I2b), the installation claim in execution tokens, the `installations` marker and worker capability. The registry lists only Graffiticode | none for Graffiticode (proved below) | Policy floor `I-installations`; the cross-installation suite (below), run against two installations in tests |
| I2b | broker | Object names and evidence per installation, from the token's claim (Graffiticode's unchanged). Item validation aligned with Policy's on one shared pattern (common). Policy then allows item-scoped intents for registered installations | Graffiticode items with `:` or `.` become publishable | Broker floor; the same-item and collision tests (below) |
| I3 | api | Verify `X-Caller-Identity` against the registry, attest the installation to Policy, check `act` against it. A user-token-only request is treated as Graffiticode **while the registry lists only Graffiticode** | none | API floor plus `requires` |
| I4 | graffiticode-app | The console, MCP, REST and app servers send `X-Caller-Identity` to the API (core's `identityToken`); their accounts are entered in the registry | none | the frontends' baseline; API logs show every command request attested |
| I5a | common, auth | Unused helpers and their tests: credential loading, route authorization, grant compatibility ([I5a](#i5a-auths-preparation-inert)) | none (inert) | unit tests; nothing outside the specs imports them |
| I5 | auth | act-as v2; internal keys per installation, authorized by route (legacy OAuth and migration Graffiticode-only); v1 is Graffiticode's only | none for Graffiticode | auth floor; the internal-key tests (below) |
| I6 | operator | Backfill (I-6). Remove `INSTALLATION_IDENTITY_LENIENT` and add it to `removeEnv` and `forbiddenEnv` for api, policy and auth, then release them: every protected path (I-8), `/compile` and `/data` included, refuses a missing identity | the switch | backfill counts; `release-check` on every enforcing service (no lenient revision reachable); the registry check (I-1); the strict-identity and configuration-rollback tests (below) |
| I7 | operator | Register the second installation (P6) | Artcompiler can call | everything above deployed; P6's own gate |

## I5a: auth's preparation (inert)

*Amendment, 2026-11-19.* I5 changes auth's startup, its internal routes and the tokens it issues, so it waits with the other enforcing slices. I5a lands now. Like I1, nothing outside its specs imports it.

### What auth has today

**Internal key.** `requireInternalAuth` accepts `INTERNAL_API_KEY` on these routes:
- the legacy OAuth routers: `/oauth-tokens`, `/oauth-clients`, `/oauth-pending`, `/oauth-codes`;
- `/oauth-migration/v1`;
- `/linked-emails/internal*`;
- `/authenticate/internal/exists/:address`;
- `/v1/refresh-tokens/clean-expired`. `requireCleanupAuth` takes `CLEANUP_API_KEY`, but falls back to the internal key when the cleanup key's header is absent. I-5's list missed this route.

**Act-as.** `/internal/act-as` takes no internal key: it checks the caller identity against `ACT_AS_CALLERS` and a v1 grant under `ACT_AS_GRANT_SECRET`. The token it issues carries `act: { sub, purpose, subject }`.

**The API.** `/oauth/verify` returns the whole token, `act` included. The API keeps only `uid` (`api/src/auth.js`), so an act-as token is accepted wherever a user token is.

### What I5a adds (unused)

1. **Rotation in the registry** (common, a change to I1's parser; decision B). An entry may carry `internalKeyPrevious`.
   - **Allowed:** the same secret name as that entry's `internalKey`, at a different version. Nothing else may share a name.
   - **Still refused:** a name reused across installations, or across credential purposes (an act-as secret and an internal key).
2. **Credential loading** (common). `loadInstallationCredentials(registry, resolve)` takes each entry's `actAsSecret`, `internalKey` and `internalKeyPrevious` references, resolves them to values, and returns a frozen, null-prototype map from installation to credentials. Startup must refuse when:
   - a reference doesn't resolve;
   - an act-as secret is shorter than 32 characters;
   - any two loaded values are equal: across installations, across purposes, or a current and a previous key. Distinct names don't guarantee distinct values, and a shared value would make a key's owner ambiguous.

   `resolve` turns a pinned reference into its value. In I5a it is injected; the production adapter is I5's (decision A). `internalKeyOwner(credentials, presented)` compares a presented key, in constant time, against every installation's current and previous keys. It compares every key, not stopping at the first match, and returns the owner or null.
3. **Route authorization** (common). Auth's internal routes are listed once by id:
   - **Graffiticode only:** `oauth-tokens`, `oauth-clients`, `oauth-pending`, `oauth-codes`, `oauth-migration` and `refresh-tokens-cleanup`;
   - **Grantable:** `linked-emails` and `authenticate-exists`, as I1's parser already allows.

   `internalRouteAllows(registry, route, installation)` answers yes for Graffiticode on the Graffiticode-only routes, and on a grantable route only when the installation's entry grants it. It answers no for an unknown route. To leave Graffiticode's behavior unchanged, its registry entry must grant both grantable routes.
4. **Grant compatibility** (common). `verifyPresentedActAsGrant({ credentials, caller, token, expect })`.
   - **`caller`** is the authenticated result of `createCallerIdentity`, configured with `registryCallers(registry, "actAs")`: a verified service identity carrying its installation. It is never an entry chosen from request data.
   - **Version.** The token's unverified payload selects the version: a `v2` grant carries `i`, and a v1 grant doesn't. The signature is then verified under that version's MAC domain. Since the domains differ, picking the wrong version only fails.
   - **v2.** Verified with the presenting caller's installation's secret, and `i` must equal that installation (`installation-mismatch`).
   - **v1.** Accepted only when the presenting caller is Graffiticode's, under Graffiticode's secret. Any other caller gets `v1-not-accepted`.
   - **The result** names the installation, for the `act` claim I5 will issue.
5. **Tests** (unit only), for each item above:
   - rotation:
     - a current and a previous version of one name are accepted for one installation's internal key;
     - that name is refused across installations or purposes;
     - during rotation, both keys resolve to their owner;
     - once the previous reference is removed, the old key resolves to nobody;
   - credentials: equal values (across installations, across purposes, current and previous), a short secret, an unresolved reference;
   - keys: owner lookup, and that every key is compared;
   - routes: every route id against Graffiticode, a granted installation and an ungranted one;
   - grants: v1 and v2 from each installation's caller, a v2 grant under the wrong secret or naming the wrong installation, and v1 from a non-Graffiticode caller.

### What waits for I5 (after C5d activation step 5)

- **Startup:** auth mounts the pinned registry, refuses an invalid one, loads credentials, and checks `identityLeniency`.
- **Startup, the production resolver (decision A).**
  - gc-deploy owns `PINNED_SECRETS`: on every release it writes the variable from `deploy.json`'s `secrets`, overwriting any value already present.
  - Before promotion, it verifies the map against the candidate revision's actual secret mounts.
  - A user-supplied or stale value never establishes a binding: a mismatch refuses the candidate.
- **Routing:**
  - `requireInternalAuth` is replaced by a per-route check: `internalKeyOwner`, then `internalRouteAllows`. A key that is valid but not authorized for the route is refused with 403.
  - The cleanup route keeps today's precedence. A request carrying `X-Cleanup-API-Key` is judged by that header alone, so an invalid cleanup key fails even when a valid internal key accompanies it. Only a request without that header falls back to the internal key, and now only to Graffiticode's.
- **Issuance:**
  - `/internal/act-as` takes its callers from the registry, replacing `ACT_AS_CALLERS`, and verifies with `verifyPresentedActAsGrant`;
  - the issued token's `act` claim gains `installation`;
  - the auth floor `I-installations`.
- **The API, coordinated (I3):** the API keeps `act` from `/oauth/verify` and refuses a request whose `act.installation` disagrees with its attested installation. An `act` without an installation, issued before I5 within its 5-minute lifetime, is Graffiticode's (I-3). Auth may issue the claim before the API reads it, because only Graffiticode is registered until I7. A second installation is registered only after both I3 and I5 are deployed.

### Decisions taken (owner, 2026-11-19)

- **A. How a reference becomes a value.** Cloud Run exposes secrets as environment variables, which don't carry their reference, so gc-deploy writes `PINNED_SECRETS`: a non-secret JSON map from variable to pinned reference. gc-deploy alone owns the variable, overwrites it on every release, and verifies it against the candidate revision's actual secret mounts. A user-supplied or stale value never establishes a binding, and the loader refuses a reference the service doesn't pin. The production adapter lands with I5. I5a's resolver is injected.
- **B. Rotating an installation's internal key.** An optional `internalKeyPrevious` per entry replaces Graffiticode's `INTERNAL_API_KEY_PREVIOUS`. It may share its name with that entry's `internalKey` at another version. Reuse across installations or purposes, and equal resolved values, stay refused. Both keys work during a rotation, and removing the previous reference stops accepting the old key.
- **C. The cleanup route.** Its internal-key fallback is Graffiticode-only from I5, and today's header precedence is kept: an invalid cleanup header fails even with a valid internal key. Removing the fallback entirely is a separate cleanup.

## Cross-installation rejection tests

These run in Policy's and the API's suites against two registered test installations, A and B, with the **same uid**.

- **Keys:** the same idempotency key in A and in B yields two commands with different ids. A's command can't be allocated from B, even by constructing its id.
- **Reads:** B's `GET /command/:id`, evidence, ledger and reconciliation reads of A's command all return `command-not-found` (`permission`). So do B's replay, repair, materialize, reconciliation and (later) dispatch of A's command.
- **Connections:** A's connection is refused in B, and so is a grant made in A.
- **Item authority:** callbacks for A's records reach A's endpoint only, and B's reach B's.
- **No namespace collision:** Graffiticode's item `B:example` and B's item `example` keep separate counters and separate thumbnails, and neither one's capture reads or advances the other's. Both publish; this needs I2b's aligned validation, because Broker's current pattern refuses `B:example`.
- **The same uid and the same item id in A and B:**
  - captures keep separate counters and publish separate objects;
  - B's capture never overwrites, advances or reconciles A's thumbnail;
  - each one's evidence names its own object.

  Before I2b, B's item-scoped intent is refused (`item-scope-unavailable`) and nothing is written.
- **Act-as:** a grant from A is refused when presented by B's caller, or signed with B's secret. A token whose `act` installation is A is refused on a B-attested request.
- **Attestation:**
  - an installation named in a body, a header from a non-`gateway` role, or a user token is ignored;
  - an unregistered caller gets no installation;
  - **after I6, every protected path refuses a request with no identity:** `POST /command`, `POST /compile` reaching an allocation, and `GET /data` reaching the bridge. A public read with no identity still serves public content;
  - **a supplied identity that's invalid** (wrong audience, unregistered email, unverified, expired) is refused on all of those paths and on public reads, before and after I6;
  - a service with `INSTALLATION_IDENTITY_LENIENT` and a registry listing a second installation refuses to start;
  - **configuration rollback, from the same commit** (gc-deploy's tests, with recorded service state): after I6, a rollback to a revision of the current commit that still carries `INSTALLATION_IDENTITY_LENIENT` is refused before traffic moves, with no override. So is promoting a candidate that inherited it. `release-check` fails while such a revision is reachable. A revision of the same commit pinned to an older registry stays strict, and refuses the newer installation's requests.
- **Internal keys:**
  - B's key is refused (403) by every legacy OAuth route and every `/oauth-migration/v1` route, the inventory included, both before and after the seal;
  - B's key is refused by any internal route the registry doesn't grant it;
  - Graffiticode's key still works where it does today, `/v1/refresh-tokens/clean-expired`'s fallback included;
  - a v1 grant presented by a non-Graffiticode caller is refused (I5a);
  - B's key is refused by the cleanup route's fallback, and an invalid `X-Cleanup-API-Key` fails even beside a valid internal key;
  - during a rotation, the current and previous keys both work, and removing the previous reference stops accepting the old one.
- **The registry across services:** `release-check` fails while api, policy and auth pin different registry versions. A service that doesn't know an installation refuses it.
- **Untagged records:** a record written before the change is readable and replayable by Graffiticode, and invisible to B, before and after the backfill.
- **Graffiticode keys are unchanged:** retrying a save key issued before the change returns the same command id and the same protocol (`legacy` or `command`), with zero provider writes. This covers a completed save, a failed one (retried only through its own path), and a queued `connection_write`.
- **Rollout:** an older worker fails closed on a B record (`worker-unsupported`), and a rollback below `I-installations` is refused.

## Rollback

- **Before I6**, every slice can be rolled back by its receipt, down to its floor. While the registry lists only Graffiticode, nothing untagged-dependent has changed.
- **After a second installation is registered (I7)**, two guards refuse a rollback before traffic moves:
  - **Below the floor:** older code would serve B's records as Graffiticode's.
  - **To a configuration that carries `INSTALLATION_IDENTITY_LENIENT`,** whatever its commit (`forbiddenEnv`, I-8). Rolling back to the same commit with an older registry stays strict, and only refuses the installations it doesn't know.
- **To withdraw an installation,** remove it from the registry. Its records stay tagged and unreachable, never reassigned to Graffiticode.

## Decisions taken (owner, 2026-11-19)

1. **Connections:** scoped to the installation that creates them (I-4).
2. **Registry:** one pinned Secret Manager document. Rollout is coordinated by revision, with one pinned version across services checked by `release-check`, adding in the order Policy, auth, API, and withdrawing in reverse (I-1).
3. **Requests with only a user token:** they count as Graffiticode only while it is the sole installation. Every protected path is closed before another installation is registered. Three guards enforce it: startup refuses leniency with a second installation, gc-deploy's `forbiddenEnv` refuses any lenient revision on release and rollback whatever its commit, and an older registry stays strict. A supplied invalid identity is always refused (I-8).
4. **Broker:** it takes installation context for item resources (I-4, I2b). Until then, item-scoped capabilities are off for other installations.
