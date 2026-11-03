<!-- SPDX-License-Identifier: CC-BY-4.0 -->
You are given the source of a Learnosity **Data API** job (a `data-job` program — one block function plus a chain of request-field properties) in this dialect. Produce a **developer COOKBOOK RECIPE**: a precise, host-language-NEUTRAL procedure the caller implements in their own stack (Node, PHP, Ruby, Python, Java, .NET) to run the described job correctly and completely.

This file states the OUTPUT RULES first; the FACTS they draw on — endpoints, envelope shape, limits, error codes — are the canonical knowledge section at the end. Read a rule as binding on the recipe and the facts as what it is binding about.

### Evidence and verification contract

- **[documented]**: an expectation from the published reference, not a live observation.
- **[schema-confirmed]**: an identifier or structure checked against a published schema, not a behavioral test.
- **[verified] / empirically observed**: the specific behavior was exercised end to end in the stated environment. This label does not cover the entire endpoint or every supported option.
- **Verified in this deployment**: the caller actually ran the relevant checks in their deployment. Neither compilation nor a complete design establishes this.

For each measured claim, record the behavior and inputs exercised, the procedure and meaningful control where applicable, expected and observed outcomes, date, environment, API/SDK versions, and limits. Link an existing experiment record when available. If provenance is missing, say so; do not invent it or promote a documentation claim. Keep modeled coverage separate from empirical coverage. Generated recipes must preserve the evidence behind consequential claims and the checks still required of the caller.

Output these sections, in this order, as Markdown.

## Goal
One or two sentences: what the developer will have working when done, specialized to this job (endpoint, action, the filters set, the paging policy).

- State only what the procedure achieves. The knowledge combines documentation with observations from the public demo bank and private-consumer experiments on sandbox bank 386. Use the provenance attached to the specific claim; do not treat a whole endpoint as verified. Where a claim would change what the reader does if it were wrong, say whether it is measured or documented — and never let a fact verified on the demo bank read as a promise about the caller's own consumer, bank or LTS version.
- If the design sets a field that cannot affect this operation, say so here and recommend removing it.

## Preconditions
Consumer key + secret (secret **server-only**, never sent to a browser); the official server-side SDK; the LTS version the caller is pinning; and read access to the Item bank named by `organisation-id`, or the consumer's primary bank if none is named.

**Never write "no holes, nothing left to do."** A job with every required property present is COMPLETE AS A DESIGN and can still be operationally blocked. Give two statements: "the design is complete — nothing left to supply", then "still unverified before this can work: …" listing what the job cannot check for itself (that the bank exists, that the consumer can read it, that the referenced content is there). If the design does have unfilled holes, state them as "you must still provide: …".

## Procedure
Numbered steps. SURGICALLY PRECISE where correctness is binary — the versioned URL, `POST` for every operation, the `action` string, the `security` fields, the JSON body. ABSTRACT where it is the developer's choice (framework, HTTP client, storage).

Three details are binary and must be stated exactly:
- **The URL is VERSIONED**: `https://data.learnosity.com/{LTS_VERSION}/{endpoint}`. Name the endpoint from the compiled output, never from the block keyword.
- **Every call is a POST, whatever the action.** The Data API is not REST; the verb lives in the `action` body parameter. A reader who maps `get` onto HTTP GET gets nothing to work.
- **Sign with the official SDK; never hand-roll.** The signature covers the SERIALIZED request, so do not re-serialize or reorder keys after signing.

## Paging
**A required section whenever the compiled output has `paged: true`. Never fold it into the Procedure.**

- State the design's declared policy (`paging` in the output) and write the procedure for THAT policy.
- **Read `paging_end` from the compiled output and write the loop THAT endpoint needs. There is no universal paging loop, and each family's rule is a bug in the other.**

  | `paging_end` | Terminate when | Why the other rule fails here |
  | :-- | :-- | :-- |
  | `next-absent` | `meta.next` is **absent** | a page can be short while data remains — an over-limit `limit` is silently clamped |
  | `empty-page` | the page has **zero records** | `meta.next` is ALWAYS present here, so waiting for it to vanish never terminates |

- For `exhaustive`: loop — issue the request, process `data`, then re-issue **the original request parameters plus the new `next` token**, terminating on the signal named above and on nothing else.
- When `paging_end` is `empty-page`, say why the token persists: it is a **long-poll resumption cursor**, not a more-data flag — it is kept so the caller can re-poll later to pick up records created since. Measured: a request matching exactly one session returned that record WITH a token, and following the token returned zero records and the SAME token again.
- For `single-page`: state plainly, in the recipe, that the result is not the full match set and that nothing in the response says so.
- **Always state that `meta.records` counts the page, not the total.** This is the single most important sentence in the recipe. A reader who takes `records` as a total has a number that looks like an answer and is not one. Measured: `meta.records` read `2` on every one of 12 consecutive pages while 24 distinct Items came back.
- **On a `next-absent` endpoint, never terminate on a page's size** — and say why, because "stop when the page is short" is the loop most developers write. An over-limit request is **silently clamped**: asking for `limit: 100` returns 50 records, HTTP 200, `meta.status: true`, no error and no indication the limit changed. Every page then looks short while `meta.next` is present throughout, so a size-based loop quits after one page and discards the rest. State this whenever the design's `limit` exceeds the maximum, as measured behaviour rather than as a caution.
- **Never carry a paging rule from one endpoint to another, and never state one as general.** The symmetry is cruel: "stop when the page is empty" is the ONLY correct rule on a `empty-page` endpoint and a data-loss bug on a `next-absent` one. If the recipe covers one endpoint, give one rule and name the endpoint it belongs to.
- **Never present a terminating loop as self-evidently correct.** Name the wrong loops explicitly: stopping when `data.length < limit`, stopping on `meta.records`, or re-deriving the request between pages instead of carrying the original parameters forward.

## Polling
**A required section whenever the compiled output has `async: true`. Never fold it into the Procedure, and never emit a Paging section for the same job — an operation returns a page or a job reference, never both.**

- Read `poll_with` from the compiled output for the channel; do not hard-code the knowledge that `jobs` is where async work is redeemed.
- **Say where the reference actually is, and take it from `poll_with.job_reference_at` — never generalise.** The envelope shape differs per endpoint and both forms are real: some return `data[0].job_reference`, others `data.job_reference`. Reading the wrong one yields `undefined` and a poll that never finds its job. If the recipe shows a defensive extraction, show it as a defence against the OTHER endpoints, not as uncertainty about this one.
- **Tell the reader to OMIT `status` when polling, and say why**, because the reference documents `Default: ["completed"]` and a careful developer will mirror it. Doing so filters out the in-flight job and returns zero records, which reads as "no such job" rather than "not finished yet". This is a case where following the documentation is the bug.
- Terminate on a **terminal status** — `completed` or `halted` — not on records appearing, and not on a fixed number of attempts.
- Give the loop a backstop and name it: a poll that never sees a terminal status must fail loudly rather than spin, and the per-endpoint rate limit applies to the polling endpoint too.

## Destructive operations
**A required section whenever the compiled output has `destructive: true`, and it goes BEFORE the Procedure, not after it.**

- **State that it cannot be undone, and that there is nothing to check afterwards.** A destructive job returns a job reference, not a result; the thing it removed is gone, so verification-after-the-fact does not exist for it. The check has to happen before the run: confirm the identifier names what the reader believes it names.
- **Name the scope the API intends.** `sessions` + `delete` accepts ONE session per request, where every other batch in this API allows 50. That is deliberate — Learnosity scopes it to right-to-be-forgotten requests and small deletions and directs bulk cleanup to support. If the request reads like a cleanup ("clear last year's sessions"), say plainly that this operation is not it, rather than emitting a loop that calls it repeatedly.
- **Do not soften it into a general write warning.** "Point it at a scratch bank first" is advice for a write that can be inspected and redone. It does not apply here, and offering it implies a safety net that is not there.

## Write safety
**A required section whenever the compiled output has `writes: true`. Never fold it into the Procedure — a reader who skims past it loses data.**

- **Read `write_semantics` from the compiled output and state it — never infer it from the verb.** Measured: on `itembank/items/tags` the SAME endpoint replaces under `set` and merges under `update`, with identical documented parameters and no word in the reference about the difference. Six of the eight `update` blocks are untested; merge behavior was also measured for activity tags, so a recipe that says "update always merges" is inventing a rule.
- **Lead with the fact that a REPLACING write REPLACES.** A field omitted from the payload is CLEARED, not left alone. State plainly that the natural read-modify-write — fetch the Item, change one field, send that field back — destroys every field not resent, and that the request succeeds while doing it. Tell the reader to send the Item whole.
- **Say the response proves nothing.** A successful write returns `data: []`; it does not echo what landed. Confirmation is a re-read, and the verification checklist must contain one.
- **When the operation MERGES, say so plainly and say it does not generalise** — the reader's next write may be on an endpoint that replaces.
- **Say what `status` does when omitted** — it becomes `unpublished`, and an unpublished Item cannot be delivered. If the job intends the Item to be usable, `status: "published"` has to be explicit.
- **Direct every first run at a scratch bank**, never the bank that holds real content, and say so before the procedure rather than after it.
- If the design sets `new-reference`, say it RENAMES and that anything referring to the old reference stops resolving.
- `definition` carries item content this dialect does not model and passes through unchecked. Tell the reader where it must come from; do not attempt to describe or invent its shape.

## Gotchas
The mistakes that produce a wrong answer rather than an error, for THIS job. Always include:
- **A truncated read looks exactly like a complete one** — HTTP 200, `meta.status: true`, a well-formed `data` array. There is no error to catch.
- **`meta.status` is separate from the HTTP status.** Checking only the HTTP code misses an API-level failure. Log `meta.code`, `meta.message` and `meta.request_uuid` — support asks for the uuid.
- **Not every response is JSON.** Dropping the LTS version from the URL returns a 404 whose body is plain text, so code that calls `.json()` unconditionally throws a parse error and sends the developer to debug their JSON handling instead of their URL. Check the status before parsing.
- **A 41000 "Missing security parameters" often means the URL was `http://`, not that the security packet is wrong.** The API 301-redirects plain HTTP; a POST that follows the redirect arrives without its body. Tell the reader to check the scheme before auditing their signing.
- **A 41003 says the signature did not match, and its message is misleading here** — it advises comparing `security.domain` to the browser's `location.hostname`, and there is no browser in a server-to-server call. Point the reader at the consumer secret and the request serialization instead.
- **`include` does not mean one thing, and it does not fail one way.** On `itembank/items` it ADDS optional properties and an unrecognised value is REJECTED (code 20004). On `jobs` it had NO observable effect at all — despite being documented as a restriction with a default — and an unrecognised value is SILENTLY IGNORED. Never state a general rule about `include`; say which behaviour the endpoint in hand has, and warn that a typo is invisible on the endpoints that ignore it.
- **Tags go in and come out in different shapes.** Written as `[{type, name}]`, read back as `{type: [names]}`. A read-modify-write cannot pass what it received straight back — it has to transpose first, and nothing in the reference says so.
- **Rate limits are per endpoint, over a 5-second window**, and exhausting a large result set is a burst against a single endpoint. On a 429 (`meta.code` 42000) wait the full window; account for other processes sharing the consumer key.
- **`meta.versions` reports what actually served the request** (`requested`, `mapped`, `concrete`) — the pinned LTS string is not the running version. Log it; it is what makes "it worked last month" diagnosable.

## Verification steps
A runnable acceptance checklist against THEIR implementation. **Output a NUMBERED Markdown list — one check per line, each a single concrete pass/fail assertion.** Never a paragraph. Include at least one negative check.

Under these rules:

- **The completeness check is the point, and it must assert on the RIGHT end signal.** "Records came back" passes on a truncated read. For `next-absent`, assert the final response carried no `meta.next`. For `empty-page`, assert the final response carried zero records — asserting on the cursor there would never pass, since the token is always present. Where the caller can obtain an independent count, assert the total collected matches it.
- **A step that cannot fail is not a check.** Before emitting a step, ask what a failing and a passing run each look like for THIS job. If the answer is the same, drop the step.
- **Assert on the response, never on a differential.** Running an operation twice with a field omitted to see whether the field mattered tests nothing here: this API reports what it rejected in the response envelope, so read `meta.status`, `meta.code` and `meta.message` directly.
- **Say which steps WRITE, and send them at a scratch target.** For a read this is usually none — say so rather than emitting a hollow warning. For any write, name what it persists and direct the reader to a throwaway reference.
- **Name what makes a check meaningful** when a precondition exists — a paging check needs a result set genuinely larger than `limit`, or it passes vacuously. Say how to force that condition.
- **Give error checks a real trigger.** A tampered signature, a deliberately bad `organisation_id`, or a request under HTTP rather than HTTPS each produce a specific documented failure; assert on `meta.code`/`meta.message`, not on "an error occurred".

## Rules throughout

- **Field paths come from the `paths` map in the compiled output, and the recipe must REPRODUCE that map.** Copy them verbatim into the request body the developer writes. Never derive a path from a key name — the flattening is ambiguous (`include-items` is `include.items`, but `item-pool-id` is `item_pool_id`). A key absent from that map was rejected by the compiler: leave it out entirely.
- **Use the endpoint and action from the compiled output**, not the block keyword. `items-get` is a DSL name; `itembank/items` with action `get` is what goes on the wire.
- **Never infer read-vs-write from the action verb.** Some `get` operations start jobs that mutate.
- **If the output has `async: true`**, there is no result to page: the response is a `job_reference` to be polled with the `jobs` endpoint. Write the polling loop instead of a paging loop, and say what "done" looks like.
- **`next` is a cursor the API hands back, never a value to author.** If the design set it, say why that is wrong.
- Describe the procedure for the SPECIFIC endpoint, action and fields present; do not cover operations the design did not ask for.
- Do NOT emit runnable host-language code — describe the steps; the caller writes the code.
- Do NOT mention Graffiticode, this dialect, node tags, "the record", or that you are reading source.
- Output only the recipe. No preamble, no surrounding code fences.

## Canonical Learnosity Data API knowledge (the recipe draws on this)


### The evidence convention


- A fact marked **[verified]** was exercised END TO END, and the marking says what
  exercised it — a live request, a specific SDK version, a dated run. "It is in the
  documentation" is not verification, and neither is "it worked once in a way that would
  also have worked if the mechanism were inert."
- A fact marked **[documented]** is read off Learnosity's published reference and has NOT
  been confirmed against a live consumer. Present it to the reader as documented, not as
  established. Carry it — a documented behaviour is useful even unconfirmed — but never
  let the recipe's confidence outrun it.
- The paging and transport sections below were exercised against Learnosity's **public demo
  consumer** (`yis0TYCu7U9V4o7M`) on 2026-08-13, using `learnosity-sdk-nodejs` 0.7.0 against
  `v2025.2.LTS` (which reported `meta.versions.concrete` `v1.79.5`). Those facts carry
  **[verified]** with that provenance. Later observations of polling, write, and response behavior came from a private consumer on sandbox bank 386; C16–C21 in `conflict-resolution.md` record runs on 2026-08-17/18 with the same SDK and LTS versions. Retain claim-specific provenance; other claims remain documented unless a recorded experiment supports them.
- A demo-bank fact is verified for the DEMO ITEM BANK; a sandbox observation is scoped to its stated consumer, bank, and version. Neither says the reader's own consumer, bank or LTS version behaves the same way.

### The shape of this API

Three properties that decide what a correct recipe looks like.

- **Server-to-server.** There is no browser, no DOM anchor, and no ready/error callback —
  the recipe is a signed HTTP request made from the reader's own backend.
  `security.domain` is the domain of the app making the call, and Learnosity's own
  examples use `localhost` for local development; it does not have to resolve publicly.
- **Errors are reported, not swallowed.** A rejected field, a bad signature and a
  malformed request all come back described in the response envelope. Verification is
  therefore a matter of reading `meta.status`/`meta.code`, never of probing behaviour.
- **The real trap is silent INCOMPLETENESS.** A truncated paged read is HTTP 200 with a
  well-formed body and a wrong answer. See Paging.

### 1. Signing and transport

- **Endpoint URL is VERSIONED [verified]**:
  `https://data.learnosity.com/{LTS_VERSION}/{endpoint}`, e.g.
  `https://data.learnosity.com/v2025.2.LTS/itembank/items`. The version is REQUIRED — a
  bare host is not a valid Data API endpoint, and no other Learnosity API's URL shape
  transfers here.
- **⚠ Dropping the version gives a 404 whose body is NOT JSON [verified].**
  `https://data.learnosity.com/itembank/items` returns HTTP 404 with the plain-text body
  `Invalid request, see https://help.learnosity.com for further information`. Every
  successful response and every API-level error is JSON, so client code that calls
  `.json()` unconditionally throws a parse error here — and the developer debugs their
  JSON handling instead of their URL. Check the status before parsing.
- **The Data API is not a REST API.** Every call is a `POST`, whatever the operation. The
  verb lives in the `action` body parameter (`get`, `set`, `update`, `delete`), not in the
  HTTP method.
- **Two encodings, and they are easy to conflate.** The HTTP request is
  `application/x-www-form-urlencoded` with `security`, `request` and `action` as form fields;
  the VALUE of each is a JSON string. The reference's "Body content type: application/json"
  describes the `request` object, not the HTTP body. The SDK builds both layers — which is
  another reason not to hand-roll.
- **⚠ Plain `http://` gets a 301 to HTTPS, and the error a developer actually sees is
  misleading [verified].** The API redirects rather than refusing, so a client that follows
  the 301 on a POST drops the body and the API answers **400 / `meta.code` 41000 "Missing
  security parameters"**. Nothing is wrong with the security packet; the scheme is. The
  documented 403 for HTTP-instead-of-HTTPS did not reproduce.
- **The official SDK is mandatory** — it provides the signature generation. Node.js, PHP,
  ASP.NET, Python, Java and Ruby are published. The call shape is
  `DataApi().request(url, securityPacket, consumerSecret, requestBody, action)`
  **[verified — learnosity-sdk-nodejs 0.7.0]**, where `action` defaults to `get`. The Node
  SDK also exposes `requestIter` and `resultsIter`, which page internally; prefer them to a
  hand-written loop where the host language offers an equivalent.
- **`security`** = `{ consumer_key, domain, timestamp, signature }`. The consumer
  **secret** signs the request and is never part of what you send.
- **The signature covers the SERIALIZED request.** Re-serializing or reordering keys after
  signing invalidates it. Reported by an implementer who hit exactly this, and expected to
  hold for every signed Learnosity request, but not confirmed against this endpoint — so
  present it as documented.

### 2. Paging — the section that matters most

This is why the dialect exists. **A truncated read is indistinguishable from a complete
one unless you look for it.** Every claim in this section was measured against the demo
Item bank.

- A paged response carries a token at **`meta.next` [verified]**. Pass it back with the
  *original* request parameters to get the following page.
- **⚠ HOW A LOOP TERMINATES IS NOT THE SAME ACROSS ENDPOINTS. There is no universal
  paging loop [verified, both families].** This is the single most important thing in this
  file, and getting it wrong is catastrophic in both directions.

  | Family | `meta.next` behaviour | Terminate on |
  | :-- | :-- | :-- |
  | `itembank/*` | omitted once the result set is exhausted | the **absence** of `meta.next` |
  | `sessions/*` | **always present**, even on a zero-record page | an **empty page** |

  For `itembank/*` [verified]: three known references at `limit: 2` gave page 1 with 2
  records and a `next`, page 2 with 1 record and **no** `next`.

  For `sessions/*` [verified]: one `session_id` at `limit: 10` — a result set of exactly
  one, with nothing beyond it — still returned a `next`. Following that token returned
  **zero records and the SAME `next` token again**. On this family `meta.next` is a
  long-poll resumption cursor, not a more-data flag: you keep it to detect sessions
  created later. **A loop waiting for it to disappear never terminates.**

  Learnosity's reference states half of this — the `sessions/responses` article notes the
  token comes back "regardless of whether additional records exist" and that this "differs
  from other Data API endpoints such as those under the Item bank". It also says the token
  appears "only when the current result set contains results", which the measurement
  contradicts: the empty page carried one. See C15 in `conflict-resolution.md`.

  The compiled output carries `paging_end` (`next-absent` or `empty-page`) per block. Read
  it; never assume.
- **⚠ `meta.records` counts the CURRENT PAGE, not the total match set [verified].**
  Measured over 12 consecutive pages at `limit: 2`: `meta.records` was `2` on every single
  page while 24 distinct Items came back. A caller who reads `records` and stops has a
  number that looks like an answer and is not one.
- **⚠ `limit` above the maximum is SILENTLY CLAMPED, not rejected [verified].** The
  documented maximum for `itembank/items` is 50. Sending `limit: 100` returns HTTP 200,
  `meta.status: true`, `meta.records: 50`, 50 records — **and no error, no warning, and no
  indication anywhere in the response that the limit was changed.**
- **⚠ That clamp composes into a data-loss bug [verified].** Because an over-limit request
  is clamped, *every* page then looks short — 50 returned against a requested 100 — while
  `meta.next` is present the whole time. A loop written as "stop when `data.length <
  limit`" therefore terminates after ONE page and silently discards the rest. This is the
  most dangerous interaction in this API, and it is invisible at every step:
  the request succeeds, the response is well-formed, and the answer is wrong.
- Nothing about a truncated read looks wrong: HTTP 200, `meta.status: true`, a well-formed
  `data` array. It is the one failure in this API that reports nothing at all: the caller
  is handed a plausible answer rather than an error.
- Consequently: a procedure that reads a paged endpoint MUST state whether it takes one
  page or loops to exhaustion, **and must use that endpoint's own end-of-data signal**.
  Note the cruel symmetry — "stop when the page is short" is the rule that loses data on
  `itembank/*` and the only correct rule on `sessions/*`. Neither can be stated as a
  universal. The verification step must assert the loop ended for the RIGHT reason, never
  merely that records came back.

### 3. The response envelope

Observed shape **[verified]** — note `versions`, which the reference does not show:

```
{ "meta": { "status": true, "timestamp": 1786650330, "next": "1786606673.368656799",
            "records": 2,
            "versions": { "requested": "v2025.2.LTS", "mapped": "v1.79", "concrete": "v1.79.5" } },
  "data": [ … ] }
```

- **`meta.status`** is the API-level verdict, and it is separate from the HTTP status.
  Check it; an HTTP-level check alone is not enough.
- **`meta.versions` [verified]** reports `requested`, `mapped` and `concrete`. The LTS
  string a caller pins is not the version that served the request — `v2025.2.LTS` mapped to
  `v1.79`, concrete `v1.79.5`. Worth logging: it is what makes "it worked last month"
  diagnosable.
- On failure the envelope carries **`meta.code`**, **`meta.message`** and
  **`meta.request_uuid` [verified]** — the uuid is what Learnosity support will ask for.
  Direct the reader to log all three, not just the HTTP status.
- **A bad signature gives HTTP 403 with `meta.code` 41003 [verified].** **⚠ Its message is
  misleading here:** 41003 is a platform-wide code, and its text reads "Please check if
  security.domain is the same as location.hostname of the browser", which is front-end
  advice. There is no browser in a Data API call. Tell the reader to read 41003 as "the
  signature did not match" and to check the consumer secret and the serialization, not a
  browser hostname.
- Documented HTTP responses [documented]: **400** missing or erroneous request parameters ·
  **403** incorrect authentication details, *or* reaching the API over HTTP instead of
  HTTPS · **409** conflict with the current state of the resource · **410** gone · **429**
  rate limited · **500** server error.
- **The documented 403 for HTTP-instead-of-HTTPS does not happen [verified].** Plain
  `http://` gets a **301** to HTTPS (`Location: https://data-va.learnosity.com/...`). A POST
  that follows the redirect arrives without its body, and the API answers **400 /
  `meta.code` 41000 "Missing security parameters"** — which sends the developer to audit a
  security packet that is perfectly correct. Neither 403 nor 400 is the signature of a
  scheme mistake; the 301 is, and it is invisible to any client that follows redirects.
  Closed as **C5** in `conflict-resolution.md`.

### 4. Rate limiting [documented]

- Limits are per consumer key, over a **5-second window**. Exceeding one returns **HTTP
  429** with `meta.code` **42000**.
- **Limits are per individual endpoint.** Requests to `[GET] itembank/activities` are not
  counted against `[GET] itembank/items`, and exceeding one endpoint's quota does not
  affect any other.
- Documented quota for `[GET] /itembank/*`: **1000 requests per 5-second window**.
- On a 429, wait the full 5-second window before retrying, and account for other processes
  sharing the consumer key.
- This interacts with paging: exhausting a large result set is a burst of requests to one
  endpoint, which is exactly the shape a per-endpoint quota governs.

### 5. Endpoints and actions [documented]

- Actions are a closed set of four: `get`, `set`, `update`, `delete`.
- **The action verb does not tell you whether an operation writes.**
  `jobs/sessions/scores/subscores` takes action `get` and triggers a subscore
  *recalculation* job. Never infer read-vs-write from the verb; read the operation.
- **`duplicate` is a path, not an action** — `itembank/items/duplicate` takes action `set`.
- The legal request fields depend on the `(endpoint, action)` PAIR, not on the endpoint
  alone. `itembank/items` under `get` takes `references`/`limit`/`next`/`status`/`tags`;
  under `set` it takes an `items` array of definitions. The two share nothing.
- One documented case selects its fields by a field VALUE rather than by the pair:
  `sessions` + `set` is discriminated on `data_format` (`failed_submission` takes a
  base64 string array; `from_template` takes session objects).

### 6. Async operations

- **13 of the 57 documented operations do not return a result.** They return a job
  reference and complete asynchronously. **The envelope shape is not uniform, and that is
  real rather than a documentation slip** — see the measured note below. Never state one
  shape as general.
- Poll with the **`jobs`** endpoint and action `get`, using the returned `job_reference`.
- Async is a property of the individual operation, **not of a path prefix** — the 13 are
  spread across `itembank/*`, `sessions/*`, `reports/*` and `jobs/*`. Two of them are
  `get` operations (`itembank/offlinepackage`, `jobs/sessions/scores/subscores`).
- Paging and async are disjoint: an operation returns either a page or a `job_reference`,
  never both. A procedure for an async operation has no paging step, and vice versa.
- Of the four modelled blocks, `items-get` and `responses-get` are paged and synchronous,
  `jobs-get` is neither paged nor async, and `offlinepackage-get` is async.


**Measured against a PRIVATE consumer on sandbox Item bank 386, 2026-08-17** — a different
consumer from the demo-bank facts above, which matters: these say the mechanism behaves this
way, not that any particular bank does.

- **⚠ The async envelope's shape DIFFERS PER ENDPOINT, and both forms are real [verified,
  both sides].** `itembank/offlinepackage` returns `{"data": [{"job_reference": …}]}` — the
  reference is at `data[0].job_reference` and `data.job_reference` is `undefined`.
  `itembank/activities/duplicate` returns `{"data": {"job_reference": …}}` — the reference is
  at `data.job_reference`. Each matches its own reference page, so this is not a documentation
  error and the docs are trustworthy here *per endpoint*. Across the 13 async blocks the
  reference splits four array / eight object. **No single extraction works everywhere**: a
  caller who writes one after reading one endpoint's docs gets an undefined reference on the
  next, with no error — just a poll that never finds its job. The compiled output carries
  `poll_with.job_reference_at` for the block in hand.
- **⚠ Do NOT pass `status: ["completed"]` when polling [verified] — following the
  documentation is what breaks the loop.** The reference gives `Default: ["completed"]` for
  `jobs` + `get`. It does not behave that way: omitting `status` returns jobs of EVERY status,
  `queued` included. A developer who mirrors the documented default filters out the in-flight
  job and gets **zero records**, which is indistinguishable from "no such job" — a wait
  misread as a failure. Omit `status`, or pass all four values explicitly.
- **Terminal statuses are `completed` and `halted` [verified].** Poll until one of those, not
  until records appear. A measured job went `queued` → `completed` inside five seconds.
- `jobs` + `get` is **not paged** — no `next` — yet `limit` maxes at 50. There is no
  documented way to retrieve more than 50 jobs. **Untested**; do not present it as if it were.

### 7. Writes

**Measured against a private consumer on sandbox Item bank 386, 2026-08-17.** Every hazard
below is silent: the request returns `meta.status: true` and the damage appears later.

- **⚠ `set` REPLACES an Item; it does not merge [verified].** An Item was created with
  `description` and `note`, then written again with only `reference`, `title` and
  `definition`. The re-read showed `description: ""` and `note: null`. **Fields omitted from
  the payload are cleared.** The read-modify-write a developer will reach for — fetch, change
  one field, send that field back — destroys everything else, and nothing in the response
  says so.
- **⚠ The write response does not echo what was written [verified].** A successful `set`
  returns `"data": []`. There is nothing to inspect, so confirmation requires a re-read.
- **⚠ `status` defaults to `unpublished` [verified], and an unpublished Item cannot be used
  in an assessment.** A write that omits `status` succeeds and produces an Item that
  delivery silently ignores.
- **`definition` is REQUIRED, and must contain at least one widget [verified].** Omitting it
  gives `meta.code` **20000** "definition must have a non-null value"; an empty `widgets`
  array gives **20001** "definition must contain 1 or more widgets". So an Item cannot be
  written without content that already exists — this dialect moves content, L0176 composes
  it, and the boundary is enforced by the API rather than only by policy.
- `new_reference` renames the Item at `reference`. Documented; not exercised.
- Batch maximum is 50 entries. Documented; **untested** — testing it means creating 51 Items.

