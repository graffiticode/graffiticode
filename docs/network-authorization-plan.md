# Network authorization: implementation plan (workstream N)

**Status:** draft, revised after the owner's second review (2026-11-25); the fetch-service direction is the owner's preference. Nothing in it is implemented, and it adds no production gate. The brief it implements, [network-egress-authorization-design-brief.md](network-egress-authorization-design-brief.md), is **proposed**, not approved. Today's enforcement (§1) does **not** provide the brief's guarantees, and nothing in this plan should be read as saying it does. Each step in §6 that changes enforcement or production state needs its own approval, as releases do in the interpreter plan.

**What the first review changed:**
1. Execution contexts are a Policy token profile, signed by Policy's KMS key, with a defined verifier, rotation and fail-closed behavior (decision 4).
2. Settings writes need a console browser session, a same-origin check and a recent re-authentication carried through refresh. The guarantee is stated as "interactive-session credentials required", not "agents cannot change settings" (decision 6).
3. No cross-account sharing of fetched results at first, across every cache layer, CDN and browser included. Destination evidence comes only from the fetch service, and old entries are never shared (decision 7).
4. The inventory no longer joins logs by time. Unattributed traffic is reported as such, and attribution waits for trusted correlation and a second observation period (§4).
5. Enforcement is declared per language, only once its reachable revisions have lost open egress and are drained, with a deploy guard against rollback and no fallback to open egress when the fetch service fails (§6).

**Relation to the interpreter plan.** This is a separate workstream (Track N in [graffiticode-interpreter-plan.md](graffiticode-interpreter-plan.md)). It depends on interpreter execution, because fetches move into `/interpret` (C3) and durable runs (Track E) resume across deployments. It doesn't redesign any Track C upgrade:
- C4 (L0182) makes no public fetch, and documents its platform calls separately (`docs/c4-l0182-assignment-plan.md` §8).
- C5d keeps its own release gates and stays held. Its Broker-mediated, item-scoped snapshot capability never acquires a public-domain opt-in (decision 8).

## 1. Where we start

**The egress proxy (ISOLATE-01, `deploy/egress-proxy/`):**
- **A compiler's class is its source subnet.** Envoy picks the filter chain from the connection's direct source address. There is no PROXY protocol, `X-Forwarded-For` isn't trusted, and no account, user or installation identity reaches the proxy (`README.md`, "How a request is handled").
- **Strict classes** (`compilers-default`, `-l0000`, `-l0176`, `-l0013`) reach only listed hosts. Every listed host is TLS-terminated with the private CA, so the proxy checks `Host`, can route by method and path, and re-originates TLS verifying the public certificate.
- **The open class, `compilers-l0185`** (D2; `l0185r` and the legacy, out-of-repo `l0137` and `l0170`), may `CONNECT` to **any** name on port 443 except the `open.denySuffixes` (`learnosity.com`, `learnosity.net`, `run.app`, `internal`, `googleapis.com`). IP literals and other ports are refused. Plain `http` in absolute form goes through the dynamic forward proxy too. The one exception is `www.googleapis.com` `GET /oauth2/v3/certs`.
- **Inside an open-class tunnel the proxy sees nothing.** The bytes are TLS end to end, so it can't check methods, paths, headers or bodies, and a tunnel opened for a GET can carry any request.
- **Addresses are enforced by the network,** whatever a name resolves to: the `ENVOY_OUT` iptables chain and the VPC firewall refuse private, loopback, link-local and metadata ranges, and DNS goes through fixed resolvers.

**What open languages do with it:**
- **L0185** fetches URLs written in the program (`languages/l0185/crates/core/src/fetch.rs`): GET only, with fixed headers, at most 10 URLs per compile, 10 s and 5 MB per URL. The **compiler** follows up to 3 redirects, each a new `CONNECT` through the proxy. There is a 60 s in-process cache per instance, shared by every caller on that instance.
- Since C3, L0185 fetches during `/interpret`. Interpreted results are `shared` for 5 minutes. The api's stage-cache key includes the authority (`anonymous` or `user:<uid>`), and HTTP responses are `public` for anonymous requests.
- **`l0137` and `l0170`** are legacy Node compilers outside this repository, served through the legacy adapter. Their `compiles/` entries are immutable and keyed by task, so one caller's fetched result is served to every caller.

**Identity on a compile today:**
- The api sends the caller's token in the compile body (`auth`). `X-Caller-Identity` is minted only for L0176 (`packages/api/src/caller-identity.js`).
- Anonymous callers share `uid = "anonymous"`.
- The installation-boundary plan ([installation-boundary-plan.md](installation-boundary-plan.md), I-8) will make an authenticated installation context mandatory on every protected path. It isn't built yet.

**Auth's tokens don't say how they were issued.** An access token carries `sub` and optional extra claims (`packages/auth/src/services/auth.js`). A SIWE sign-in, an API key exchange and an OAuth grant (MCP) can't be told apart by a server today.

**Capability operations already have their own path.** L0176's Learnosity reads and saves, and L0013's item-scoped snapshot, go through Policy and the Broker. Policy and Broker are terminated hosts on the compilers' strict classes, and the Broker holds the credentials. None of these uses the open class.

**The gap against the brief:**
- **Account allowlist:** none. A language's class, not an account, decides.
- **Per-operation authorization on the public path:** none. Any public name except the denied suffixes is reachable from an open language, by any caller, including anonymous ones.
- **Method and path control on the public path:** none inside tunnels.
- **An authorization record per outbound operation:** only the proxy's per-`CONNECT` log, with no account and no reason beyond `open` or `listed`.
- **Coverage of retries, redirects, pagination and durable resumptions:** only what the proxy sees per connection.
- **Human-only settings:** no setting exists, and no token kind could enforce it.

## 2. Decisions

Every decision is **open** until the owner chooses. Each says what is proposed and what it costs.

1. **What "account" means.** *Proposed:* the pair `(installation, uid)`. The uid is the Graffiticode user, and the installation comes from the installation-boundary work (I-8), so two installations' users never share an allowlist.
   - **Alternatives:** an organization or workspace (none exists today), or the item owner (decision 2 covers that case).
   - **Dependency:** until I-8 ships, the installation is implicitly Graffiticode, and the account is the uid.
2. **Whose policy applies to an execution.** *Proposed:* the **caller's** account, for every compile, interpret or command, whoever owns the item.
   - **Why:** the caller is who is making the request. Applying the owner's allowlist to a stranger's request would let anyone trigger the owner's authority by viewing the owner's public item, which is the cross-account authority the brief rules out.
   - **Consequence for public items viewed by others:** a viewer gets results their own account's allowlist permits (or the anonymous policy, decision 3), plus any cached result they may read under decision 7. A published artifact is served from its stored result with no fetch, so publications are unaffected.
   - **Alternative:** the item owner's account for item-bound views. That needs the api to know the item behind a task (it doesn't today), and it lends the owner's authority to viewers.
3. **What anonymous requests receive** (brief question 3). *Proposed:* no public retrieval by default. A small, curated **anonymous set**, reviewed like the shared catalog, can be enabled by the owner. Free-plan MCP use is anonymous unless it carries a signed-in account.
   - **Alternatives:** deny always, or treat the platform's own system account as the anonymous account.
   - The inventory (§4) measures how much anonymous use exists before this is chosen.
4. **How identity reaches enforcement: a signed execution context.** Compilers never choose an account or claim a capability. `caller-identity.js` only proves the api's service identity to an audience; it signs no account, task or stage, and controls no expiry. So it is **not** the mechanism.
   - **Issuer: Policy,** as a new token profile beside `invocation`, `session` and `execution` (`packages/policy/src/tokens.ts` `PROFILES`):
     - `typ: gc-retrieval+jwt`, audience `urn:graffiticode:fetch`;
     - required claims: `sub` (the account's uid, or `anonymous`), `ins` (the installation; `graffiticode` until I-8), `task`, `stg` (stage id), `mode`;
     - optional claims: `inv`, `cmd`, `run` (when the stage belongs to one), and `max` (the request budget, today L0185's 10);
     - `iat`, `nbf`, `exp` and `jti` from the profile's TTL: at most the stage's deadline, capped at 120 s. A durable run's resumption mints a fresh one (Track E's E3); a context is never extended.
   - **Who asks:** the api, per stage of a language declared to fetch, before calling `/interpret` or `/compile`. It calls Policy in its `gateway` role, as its own service identity.
   - **Where each claim comes from:**
     - **`sub`** comes from the **caller's verified user token**, which the api passes. An anonymous call gets `sub: anonymous`.
     - **`ins`** follows the installation plan's I-2, never the user token. The frontend's own service identity (`X-Caller-Identity`, verified by the api against the installation registry) names the installation. The api passes it to Policy as an **attested field on its `gateway` call**, and Policy accepts that field only from the `gateway` role. Nothing in a body, a prompt, a compiler's request or a user's token names it. Until I-2 ships, `ins` is `graffiticode` (I-3: absent means Graffiticode).
     - Neither the api nor a compiler can supply any other claim's value.
   - **Signing: a separate retrieval key.** A new Cloud KMS key (`EC_SIGN_P256_SHA256`, JWS ES256) used only for this profile. The private key never leaves KMS, and only Policy's service account may sign with it. Policy's existing key keeps signing every existing profile, unchanged.
     - **Why separate:** the existing key signs 30-minute `invocation` tokens and 15-minute `session` tokens, among others. Broker loads exactly one verification key at startup (`packages/broker/src/main.ts:95`). Sharing a key would tie retrieval rotation to every existing verifier, and would need an overlap covering the longest existing lifetime, with a coordinated Broker change. A separate key leaves Broker, Policy's own verification and every existing profile untouched.
     - **Separation in both directions:** the retrieval key's `kid` and `typ` are distinct. The fetch service accepts only retrieval-key `kid`s and the `gc-retrieval+jwt` type. Broker and Policy keep pinning their existing key, so a retrieval token is refused there, and an existing-key token is refused by the fetch service.
   - **Verifier:** the fetch service. It checks the signature against Policy's JWKS (`GET /v1/jwks`), and checks `typ`, audience, `nbf` and `exp` with at most 5 s of skew, plus every required claim. It counts requests per `jti` against `max`. A context is reusable within its life for that stage's fetches, and only for them.
   - **Rotation, of the retrieval key only:**
     - Policy publishes the retrieval key's current and next versions by `kid` on a JWKS of their own (`GET /v1/jwks/retrieval`), separate from today's `/v1/jwks`, so no existing consumer sees a new key.
     - A new version is published at least the retrieval TTL (120 s) plus the fetch service's JWKS cache lifetime before Policy signs with it. The old version is removed only after the same interval past its last signature.
     - The 120 s basis is valid only because nothing else verifies this key.
     - Rotating Policy's **existing** key is out of scope here. It would need its own plan covering every profile's lifetime and every verifier, Broker's startup-loaded key included.
   - **Fail closed, everywhere:**
     - **minting:** Policy unreachable, or the caller's token invalid → the stage gets no context, and fails with a temporary `retrieval-context-unavailable`;
     - **verifying:** no context, a bad signature, an unknown `kid` after one JWKS refresh, the JWKS unavailable with no cached key, expired, not yet valid, the wrong audience or `typ`, or over budget → the fetch is **refused** (temporary where the cause is), never allowed;
     - there is no unauthenticated mode.
   - **What a compiler can do with it:** only forward it. Replaying it gets that stage's account, budget and expiry, nothing more. Nothing in it names a capability: capability operations keep going through Policy and the Broker (decision 8).
5. **Where public retrieval is enforced.** Two designs, to be compared in a spike (§6, N2) before choosing.
   - **A. A trusted public-fetch service** *(the owner's preferred direction)*:
     - A new service, not a compiler, performs every public retrieval. Compilers lose the open class: they reach only the fetch service and their platform endpoints, through strict classes.
     - The fetch service receives `{ url, method, execution context }`, authorizes against the account's current allowlist, and enforces GET/HEAD. It resolves and checks addresses (re-using the kernel's egress guards and the proxy's network controls), verifies TLS, and follows redirects itself, authorizing each hop. It applies size and time limits, and logs the authorization path for each request.
     - **Gains:** method and path control (it is the HTTP client); per-account decisions; a precise audit record; and one place where retries and redirects are re-checked.
     - **Costs:** a new service and its availability; an extra hop; moving L0185's limits and cache into it; and changes to the out-of-repo `l0137` and `l0170`.
   - **B. An authenticated proxy:**
     - Compilers keep `CONNECT`ing through Envoy, presenting the execution context in `Proxy-Authorization`. An external authorization call (Envoy `ext_authz`, to Policy or a small authorizer) decides per `CONNECT` against the account's allowlist.
     - **Gains:** no new data path, and compilers change little.
     - **Costs:** inside a tunnel the proxy still sees nothing, so methods, paths and redirects can't be checked. Doing so needs terminating TLS for arbitrary public hosts (a dynamically minted certificate per name, with the private CA trusted by compilers), a much larger attack surface. Authorization is per connection, not per request: a kept-alive tunnel carries many requests on one decision.
   - **Proposed:** A, subject to the spike confirming latency and payload limits. B meets the brief's destination rule but not its method rule (§7.4), so choosing B means amending the brief.
6. **Allowlist changes need interactive-session credentials, enforced on the server** (brief §8.4).
   - **The honest guarantee.** A bearer token from an interactive sign-in can still be used by a program, and a person can script their own browser. So the server can't prove a human acted. What it can enforce, and what this plan promises, is that **interactive-session credentials, and a recent re-authentication, are required**. Programmatic credentials (API keys, OAuth grants for MCP, A2A and REST) can't change the allowlist. The brief's "agents cannot change it" is restated in those terms.
   - **Storage:** server-only Firestore documents (rules deny every client), written only by the backend's settings route.
   - **The boundary:**
     - **A console browser session.** The console's settings page posts to a console server route that requires the console's own session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`), set only by the interactive sign-in flow, never by an API-key or OAuth exchange. It also requires a same-origin check (`Origin` equal to the console) and a CSRF token.
     - **Confirmation by re-authentication** for any change that **widens** authority (opting in, adding a domain). A fresh SIWE signature (or the sign-in method's equivalent) within 5 minutes, with the change summarized in what is signed. Narrowing changes (opting out, removing) need only the session.
     - **The backend route** accepts a write only from the console's service identity (its ID token, audience the settings route), carrying the user's token. That token must have `amr` `interactive` and an `auth_time` within the confirmation window for a widening change.
   - **Auth changes (N3):**
     - access tokens gain `amr` (`interactive`, `api-key`, `oauth`, …) and `auth_time`;
     - a refresh copies **both** from the original sign-in and never resets them;
     - a re-authentication issues a token with a new `auth_time`;
     - API-key and OAuth exchanges can never produce `amr: interactive`.
   - **The shared catalog** is platform configuration in this repository (reviewed like the protected registry). Accounts only opt in or out.
   - **Reads** of the effective allowlist are open to the account's own tokens of any kind.
   - **Hostname rules** (brief §8.5) are enforced on write and on match: parsed, normalized and IDNA-mapped names; refusal of IP literals and bare TLD wildcards; label-boundary wildcard matching, never substrings.
7. **Retained data is not permission to request again** (brief §8.3).
   - **Kept:** a result computed before an allowlist change stays readable. Nothing is invalidated by a setting change.
   - **Checked:** every **new** outbound request is authorized against the account's **current** allowlist: each redirect hop, each page of pagination, each retry, and each request a durable run makes on resumption (Track E's E3 continuation re-checks authority at each resume). A recorded observation that is **replayed** (B5 pinned inputs, B6 materialization) makes no request, so it needs no new authorization.
   - **Across accounts: no sharing at first** (the owner's recommendation). A result that fetched anything is never served from a cache to a different account `(installation, uid)`, or from an authenticated account to anonymous, or the reverse. Sharing can be designed later, on destination evidence, as its own decision.
   - **Every cache layer and trust boundary:**
     - **The fetch service's cache** (replacing L0185's per-instance cache): keyed by account and URL, and re-authorized against the account's current allowlist before a hit is served.
     - **The stage cache:** its authority today is `user:<uid>` or `anonymous` (`packages/api/src/interpret.js:108`), which is **not** account-isolated under decision 1's definition. N3 makes it `(installation, uid)`. Until I-8, the only installation is Graffiticode, which is what makes today's keys safe in the meantime.
     - **The legacy `compiles/` store** (keyed by task, served to every caller): an open-language stage is never read from or written to it once that language is enforced (§6).
     - **HTTP, CDN and browser:** today a `shared` interpreted result goes out `max-age` and `public` to anonymous callers (C3 decision 6), so a CDN could serve one anonymous request's fetched result to another, or to another installation. From enforcement, a result whose chain fetched is `private, no-store` for an authenticated request and `no-store` for an anonymous one. Never `public`.
     - **Publications and artifacts** are retained data deliberately shared by their owner. They are served without a fetch, as today.
   - **Destination evidence comes only from the fetch service.** It records, per context (`jti`), every request it made, **every redirect hop included**, with the decision and the resolved destination. It returns a signed receipt for them to the api with the stage. Nothing a compiler reports about its own fetches is evidence. With no sharing, the receipt serves audit (brief question 8). A later sharing design would rest on it.
   - **Old entries without evidence** (stage-cache entries under the old key, legacy `compiles/` results, CDN copies) are never shared across accounts:
     - stage-cache entries become unreachable when the key changes;
     - a new generation for each language at its enforcement leaves its legacy `compiles/` entries unserved;
     - a Cloudflare purge after each language's enforcement removes edge copies.

     An account's own retained results stay readable through its own publications and artifacts.
8. **The capability path is preserved, not re-gated.**
   - Capability-authorized operations keep going through Policy and the Broker: L0176's Learnosity operations, and L0013's item-scoped snapshot with the Broker's service credential (C5a/C5b/C5d). They never consult an account's public allowlist.
   - C5d keeps its existing release gates and stays held. Nothing in this workstream adds a public-domain opt-in to its snapshot capability.
   - **Test both paths together** (§5): a capability operation succeeds with an empty public allowlist; a public fetch with the same execution context can't reach a capability destination (`*.learnosity.com`, the thumbnails bucket); and a capability credential is never available to the fetch service.
9. **Platform endpoints are a separate, documented class of authority.** The api, auth, Policy, Broker, Google's certificate endpoint and Cloud Storage for the Broker are reached under service identities and the strict classes. They are not account-controlled retrieval. The api's Firestore and item-authority calls (C4 §8 is an example) belong here.
   - The plan's inventory lists them, so that enforcement keeps them reachable and never routes them through public retrieval.
   - No account setting widens or narrows them.

## 3. Dependencies

| On | Why | Effect |
|---|---|---|
| Interpreter B3/C3 (done) | L0185 fetches during `/interpret` | The execution context is minted per stage in `interpret.js`, not only on `/compile` |
| Track E (E1–E3) | durable runs resume across deployments | each resume re-authorizes new requests (decision 7); E3's Policy continuation carries the context |
| B5/B6 (done) | pinned inputs and recorded observations | replay makes no request and needs no authorization; a new observation is a new request |
| Installation boundary (I-8) | authenticated installation context | the account's installation (decision 1); before I-8, Graffiticode only |
| Auth | `amr` and `auth_time`, kept through refresh | interactive-session settings writes (decision 6) |
| Policy | the `retrieval` profile, a separate KMS key and its own JWKS; the attested `ins` on `gateway` calls (I-2) | execution contexts and their rotation (decision 4) |
| graffiticode-app (console) | the settings page, its session-cookie route, CSRF and re-authentication | brief §8.3, decision 6 |
| `l0137`, `l0170` repositories | legacy open compilers | they move to the fetch service, or stay on a named legacy class until migrated (§4) |

The interpreter plan's compatibility invariant applies: **no chain that works today is newly refused until a step names the affected chains and migrates them first.**

## 4. Migrating the existing open languages

- **Inventory in two phases, never joined by time.** Concurrent requests share an instance, and a kept-alive tunnel carries many requests, so matching `CONNECT` log lines to stage log lines by time and service would attribute fetches to the wrong caller. The plan doesn't do it.
  - **N1a, from existing logs (read-only):**
    - destinations by name, with counts and refusals, from the open-class log, reported as **unattributed**;
    - which accounts (and anonymous callers) run open-language stages, and in which chains (for example L0184 over L0185), from the api's own stage logs;
    - the corpus programs' hosts, and the legacy languages' code paths.

    Nothing connects the two lists, and the report says so.
  - **N1b, attributed, after instrumentation:** once N3 mints execution contexts, the open-class path logs each context's `jti`, `sub` and `ins` beside the destination (observe-only: nothing is refused yet, and the context is verified, not trusted blindly). After a further observation period of at least 14 days, the inventory reports per-account destinations. Traffic without a valid context stays **unattributed**, in its own line.
- **Account setup.** Every account starts with no shared destinations opted in, so enforcing on day one would break every working fetch. *Options (owner):*
  - **(a)** Accounts with observed use get a **proposed** opt-in set, shown in settings for the account's person to confirm. Nothing is enforced for them until they confirm or the notice period ends.
  - **(b)** A platform-applied migration opt-in, recorded as such and revocable by the account's person (a platform action, not an agent's).
  - **(c)** Notice and an enforcement date, with no pre-population.
- **Anonymous behavior** follows decision 3, decided with the inventory's anonymous share in hand.
- **Staging:**
  - **observe-only:** decisions are computed and logged (`would-deny`), with no refusal;
  - **per-chain migration:** each affected chain is named, its accounts set up, and it is verified;
  - **canaried enforcement per language:** L0185 first, then `l0137` and `l0170` once they use the enforcement point.

  A refusal names the account setting to change.
- **Removing the open class** is the last step, after no compiler depends on it. It is its own approval, and it is what makes the guarantee real.

## 5. Tests

- **Hostname matching:** exact, wildcard on label boundaries, IDN and normalization, trailing dots, IP literals, bare-TLD wildcards refused.
- **Network safety, on both paths:** DNS rebinding (an approved name resolving to a private address), redirects to unapproved hosts (each hop authorized), direct-connection bypass, other ports and protocols, the metadata service.
- **Methods:** only GET and HEAD on the public path (A enforces them; B can't, which the spike records).
- **Identity:** a compiler can't choose an account, can't alter or extend a context, and can't present a capability. Each fail-closed case of decision 4 refuses: expired, not yet valid, foreign audience or `typ`, bad signature, unknown `kid` after refresh, JWKS unavailable, over budget. Rotating the retrieval key with overlapping versions verifies throughout. A retrieval token is refused by Broker and Policy, and a token signed with Policy's existing key is refused by the fetch service. `ins` can't be set from a user token, a body or a compiler: only the attested `gateway` field sets it.
- **Settings:**
  - a write with an `api-key` or `oauth` token is refused, from MCP, A2A and REST alike, and so is a write without the console session, from another origin, or without the CSRF token;
  - a widening change without a re-authentication in the window is refused, and a narrowing one is accepted with the session;
  - a refreshed token keeps the original `amr` and `auth_time`;
  - agents can read.
- **Cache, at every layer:**
  - a result fetched for account X is never served to account Y, or to anonymous, from the fetch service's cache, the stage cache, `compiles/`, or HTTP (no `public`, no CDN-cacheable headers);
  - two installations' users with the same uid don't share;
  - an allowlist change leaves stored results readable and refuses the next new request;
  - the fetch service's receipt lists every redirect hop.
- **Interpreter and durable coverage:** a redirect, a retry and a durable resumption each re-check current authorization (a resumption with a fresh context). A replayed observation makes no request.
- **Enforcement and rollback:** the deploy guard refuses a release, promotion or rollback into an open class for an enforced language; a stopped fetch service fails the fetch and opens nothing.
- **The capability path** (decision 8): an L0176 save and an L0013 snapshot with an empty allowlist; a public fetch can't reach a capability destination; no credential reaches the fetch service.
- **Anonymous:** the anonymous set, and nothing else.

## 6. Sequence

Every step after N1 is a separate approval. None adds a production gate before its approval.

- **N0. Decisions:** the owner's choices on §2, and any amendment to the brief (for example if design B is chosen).
- **N1a. Inventory from existing logs** (read-only): §4's N1a, with unattributed traffic reported as such; the platform endpoints (decision 9); and the legacy compilers' fetch code.
- **N2. Spike:** A against B on latency, payload limits, failure modes and what each can enforce. Then the choice.
- **N3. Identity, inert:**
  - Policy's `retrieval` profile, its separate KMS key and `/v1/jwks/retrieval`; the api requests a context per fetching stage, with `ins` attested per I-2 (Graffiticode until I-2 ships), and forwards it (nothing enforces it yet);
  - auth's `amr` and `auth_time`;
  - the stage cache's authority becomes `(installation, uid)`;
  - storage for catalogs and allowlists;
  - the console's settings page and route, behind a flag.
- **N4. Enforcement point, observe-only:** decisions logged, nothing refused. **N1b** runs here: attributed inventory from verified contexts, over at least 14 more days.
- **N5. Account setup and migration:** per §4, chain by chain.
- **N6. Canaried enforcement, per language** (below).
- **N7. Remove the shared open class:** cleanup, after no language uses it.
- **N8. Coverage audit:** every outbound path (compile, interpret, command, durable run; MCP, A2A, REST) goes through the enforcement point or the capability path, and is recorded with its authorization path.

### Enforcing one language, and rolling it back

A language counts as **enforced** only when every one of these holds:
1. **Its new revision has no open egress.** It moves from `compilers-l0185` to a strict class of its own (for example `compilers-l0185-fetch`), whose only names are the fetch service and its platform endpoints. The open class is shared by `l0185r`, `l0137` and `l0170`, and the proxy tells classes apart only by subnet, so a language leaves it for its own class rather than being narrowed in place.
2. **No reachable revision of its services keeps open egress.** Every older revision's traffic and tags are retired (`npm run deploy -- retire`).
3. **Old routes and connections are drained.** Wait at least the service's request timeout plus a margin after the last retirement, so in-flight requests and any kept-alive tunnels from old instances end with them. Then confirm from Cloud Run that no instance of a retired revision is running.
4. **The proxy shows it.** For the open class, no `CONNECT` from the language's old revisions appears after the drain. Since the class is shared, this is checked from the language's own instance addresses, where the logs can show them, or by the language's new class being the only one its service uses.
5. **The canary passes:** allowed fetches through the fetch service for a test account, a refused one with the setting named, the capability path (decision 8) unaffected, and caches per decision 7.

**Rollback**, so a failure can never silently restore open access:
- **A deploy guard.** When a language is declared enforced, its `deploy.json` entry is marked (for example `"egress": "enforced"`). From then on, the deploy CLI refuses to release, promote or roll back to any revision of that service whose network names an open class. Only removing the mark (an explicit, reviewed configuration change, with the owner's approval) re-allows it.
- **A fetch-service failure fails closed.** An enforced compiler's network allows only the fetch service and platform endpoints, so when the fetch service is down, unreachable, or can't verify a context or read an allowlist, the compiler's fetches fail with a temporary error. No code path, flag or environment variable falls back to direct or open egress.
- **Rolling back the fetch service** (a bad revision) moves to an earlier fetch-service revision. It never moves the language back to the open class.
- **Rolling back enforcement itself** (moving a language back to the open class) is a deliberate step: the guard removed with approval, a release in the open class, and the inventory and settings untouched. It is never automatic.

## 7. Out of scope

- Information-flow tracking (brief §5.5).
- Any change to the capability path's own rules: registry, grants, Broker operations (decision 8).
- Enterprise policies stricter than the shared service (brief question 7). The design leaves room: an installation-level policy could intersect the account's.
- Content trust: an allowed destination's responses are not trusted (brief §9.2).
