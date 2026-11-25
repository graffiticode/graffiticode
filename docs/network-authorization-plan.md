# Network authorization: implementation plan (workstream N)

**Status:** draft for the owner's review (2026-11-25). Nothing in it is implemented, and it adds no production gate. The brief it implements, [network-egress-authorization-design-brief.md](network-egress-authorization-design-brief.md), is **proposed**, not approved. Today's enforcement (§1) does **not** provide the brief's guarantees, and nothing in this plan should be read as saying it does. Each step in §6 that changes enforcement or production state needs its own approval, as releases do in the interpreter plan.

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
4. **How identity reaches enforcement.**
   - **Compilers never choose an account or claim a capability.** The **api** mints an **execution context** for each stage it runs: a short-lived token, signed by the api's identity, binding installation, account (or `anonymous`), task, stage, mode, command and run (when there is one), and an expiry.
   - The compiler receives it opaquely and can only forward it with a fetch. The enforcement point verifies the signature and audience, and decides from the context. It never decides from anything the compiler asserts.
   - A compiler that replays its own context gets only that execution's authority, until expiry. Nothing in the context names a capability: capability operations keep going through Policy and the Broker (decision 8).
   - **Reuse:** Policy's verified-token checks (`packages/common/src/verified-tokens.ts`) and the installation context from I-8 carry the identity. The api's existing ID-token minting (`caller-identity.js`) is the mechanism.
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
6. **Allowlist changes are human-only, enforced on the server** (brief §8.4).
   - **Storage:** server-only Firestore documents (rules deny every client), written by one route.
   - **The route** accepts only a token from an **interactive sign-in**. Auth adds a claim recording how a token was issued (`amr`-style: `siwe`, `api-key`, `oauth`, …). The route refuses `api-key` and `oauth` tokens, so MCP, A2A and REST agents acting for an account can't change it, and it requires a recent sign-in.
   - **The shared catalog** is platform configuration in this repository (reviewed like the protected registry). Accounts only opt in or out.
   - **Reads** of the effective allowlist are open to the account's own tokens of any kind.
   - **Hostname rules** (brief §8.5) are enforced on write and on match: parsed, normalized and IDNA-mapped names; refusal of IP literals and bare TLD wildcards; label-boundary wildcard matching, never substrings.
7. **Retained data is not permission to request again** (brief §8.3).
   - **Kept:** a result computed before an allowlist change stays readable. Nothing is invalidated by a setting change.
   - **Checked:** every **new** outbound request is authorized against the account's **current** allowlist: each redirect hop, each page of pagination, each retry, and each request a durable run makes on resumption (Track E's E3 continuation re-checks authority at each resume). A recorded observation that is **replayed** (B5 pinned inputs, B6 materialization) makes no request, so it needs no new authorization.
   - **Across accounts:** *proposed rule:* a cached result records the destinations its fetches used. Another account may read it only if its own current policy authorizes every one of them. Otherwise it is a miss, and the request runs under the reader's authority, which may refuse. Cached authorization never confers another account's authority.
   - **What the rule touches:** L0185's interpreted results (keyed by authority today, so already per account); the fetch service's own cache (it replaces L0185's in-process cache, per URL, checked per request before a hit is served); and the legacy `compiles/` entries of `l0137` and `l0170` (keyed by task and served to every caller), which must become per-account or carry their destinations.
   - **Alternative:** no cross-account sharing of fetched results at all. Simpler, but at a higher fetch volume.
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
| Auth | token provenance claim | human-only allowlist writes (decision 6) |
| graffiticode-app (console) | settings UI and the human-only route's client | brief §8.3 |
| `l0137`, `l0170` repositories | legacy open compilers | they move to the fetch service, or stay on a named legacy class until migrated (§4) |

The interpreter plan's compatibility invariant applies: **no chain that works today is newly refused until a step names the affected chains and migrates them first.**

## 4. Migrating the existing open languages

- **Inventory (read-only):** the proxy's open-class log over at least 14 days (names, counts, refusals), joined to the api's stage logs by time and service to attribute each fetch to a caller (account or anonymous), task and chain (for example L0184 over L0185). Also the corpus programs' hosts, and the legacy languages' traffic.
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
- **Identity:** a compiler can't choose an account, can't alter or extend a context, and can't present a capability. An expired or foreign-audience context is refused.
- **Settings:** a write with an `api-key` or `oauth` token is refused, from MCP, A2A and REST alike. An interactive sign-in can write. Agents can read.
- **Cache:** a result fetched for account X is not served to account Y whose allowlist doesn't cover its destinations; it is, when Y's does. An allowlist change leaves stored results readable and refuses the next new request.
- **Interpreter and durable coverage:** a redirect, a retry and a durable resumption each re-check current authorization. A replayed observation makes no request.
- **The capability path** (decision 8): an L0176 save and an L0013 snapshot with an empty allowlist; a public fetch can't reach a capability destination; no credential reaches the fetch service.
- **Anonymous:** the anonymous set, and nothing else.

## 6. Sequence

Every step after N1 is a separate approval. None adds a production gate before its approval.

- **N0. Decisions:** the owner's choices on §2, and any amendment to the brief (for example if design B is chosen).
- **N1. Inventory** (read-only): §4's inventory, the platform endpoints (decision 9), and the legacy compilers' fetch code.
- **N2. Spike:** A against B on latency, payload limits, failure modes and what each can enforce. Then the choice.
- **N3. Identity, inert:** the api mints execution contexts (nothing checks them); auth's provenance claim; storage for catalogs and allowlists; the console's settings, behind a flag.
- **N4. Enforcement point, observe-only:** decisions logged, nothing refused.
- **N5. Account setup and migration:** per §4, chain by chain.
- **N6. Canaried enforcement,** per language.
- **N7. Remove the open class.**
- **N8. Coverage audit:** every outbound path (compile, interpret, command, durable run; MCP, A2A, REST) goes through the enforcement point or the capability path, and is recorded with its authorization path.

## 7. Out of scope

- Information-flow tracking (brief §5.5).
- Any change to the capability path's own rules: registry, grants, Broker operations (decision 8).
- Enterprise policies stricter than the shared service (brief question 7). The design leaves room: an installation-level policy could intersect the account's.
- Content trust: an allowed destination's responses are not trusted (brief §9.2).
