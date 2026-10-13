<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# L0178 coverage ledger — the Learnosity Data API surface

This is the **denominator**. L0177's credibility rests on being able to say every emitted path
was cross-checked against the published reference, and that sentence is only available against a
known total. This file is that total, so each slice L0178 builds can report progress against it.

It is a map, not knowledge. Everything in the TABLE below is read off Learnosity's published
reference — see "Provenance" — and **none of the table is verified**. It records the shape of the
API, not how the API behaves.

That distinction has already paid out. `itembank/items` + `get` was afterwards exercised against
the live demo Item bank, and the run produced two facts the reference does not state: a `limit`
above the documented maximum is **silently clamped** rather than rejected, and the response
envelope carries a `meta.versions` object. Both are in `instructions.md` marked `[verified]`. The
un-written tricks that make this dialect worth having are, by definition, absent from the
documentation — this map tells you where to go looking, never what you will find there.

**Modeled coverage: 30 of 57 documented operation blocks**, counting the two `sessions` + `set` variants separately as the ledger does. Every `update` is modeled. This count measures vocabulary coverage, not empirical verification. The evidence below applies to specific behaviors; it does not certify every option in a block:

| Block | Shape | Evidence / environment |
| :-- | :-- | :-- |
| `itembank/items` + `get` | paged, ends on an absent cursor | public demo bank |
| twelve additional Item bank read blocks | six paged, six unpaged | `instructions.md` records measured paging termination for the six paged reads; this does not establish every field's behavior. Per-run provenance is not recorded here. |

| `sessions/responses` + `get` | paged, ends on an empty page | public demo bank |
| `jobs` + `get` | not paged; the async polling channel | private consumer, sandbox 386 |
| `itembank/offlinepackage` + `get` | **async** — returns a job reference | private consumer, sandbox 386 |
| `itembank/items` + `set` | **writes**; replaces rather than merges | private consumer, sandbox 386 |
| `itembank/items/tags` + `set` | **writes**; REPLACES the tag set | private consumer, sandbox 386 |
| `itembank/items/tags` + `update` | **writes**; MERGES into the tag set | private consumer, sandbox 386 |
| `sessions` + `set` (from_template) | **writes**, async; branched on `data_format` | documented only |
| `sessions` + `set` (failed_submission) | **writes**, async; branched on `data_format` | documented only |
| `sessions` + `delete` | **destructive**, async; capped at ONE entry | documented only, deliberately |
| `itembank/activities/tags` + `set` / `update` | **writes**; replaces / merges | private consumer, sandbox 386 |
| six further `update` blocks | **writes**; semantics NOT established | documented only |

Each was chosen to DISAGREE with what was already modelled, and each disagreement paid: the two
paged blocks end their loops by opposite rules (C15); the documented `status` default on `jobs`
turned out not to exist, so following the reference breaks a polling loop (C16); `set`
replaces rather than merges, which the reference never states (C18); and the async envelope
genuinely differs per endpoint rather than one form being a doc error (C17); and one endpoint
replaces under `set` while merging under `update`, documented identically, so the verb predicts
nothing (C19). The register
records these conflicts and their resolutions; use its individual entries for provenance and remaining limits, rather than treating a resolved conflict as verification of a whole operation.

**Writes are never sent to the public demo account** — it is shared and writes persist. The
private consumer covers what the demo cannot, and writes land in sandbox bank 386.

### Evidence and verification contract

- **[documented]**: an expectation from the published reference, not a live observation.
- **[schema-confirmed]**: an identifier or structure checked against a published schema, not a behavioral test.
- **[verified] / empirically observed**: the specific behavior was exercised end to end in the stated environment. This label does not cover the entire endpoint or every supported option.
- **Verified in this deployment**: the caller actually ran the relevant checks in their deployment. Neither compilation nor a complete design establishes this.

For each measured claim, record the behavior and inputs exercised, the procedure and meaningful control where applicable, expected and observed outcomes, date, environment, API/SDK versions, and limits. Link an existing experiment record when available. If provenance is missing, say so; do not invent it or promote a documentation claim. Keep modeled coverage separate from empirical coverage. Generated recipes must preserve the evidence behind consequential claims and the checks still required of the caller.


## Totals

| | |
| :-- | --: |
| Endpoints | **40** |
| `(endpoint, action)` blocks | **57** |
| Documented parameters (incl. nested) | ~576 |
| Blocks returning a paged result | 13 |
| Blocks that create an async job | 13 |

Actions are exactly four: `get` (28), `set` (20), `update` (8), `delete` (1).

## What the map settled

**1. `duplicate` is a PATH, not an action.** `itembank/items/duplicate` takes action `set`. The
action vocabulary is closed at four verbs, which keeps the registry's second axis small.

**2. The action name does NOT tell you whether an operation writes.** `jobs/sessions/scores/subscores`
takes action **`get`** and triggers a subscore *recalculation* job. Any read/write classification
must come from the operation's own description, never from its verb. This is why the ledger has no
R/W column: a derived one would have been wrong and would have looked authoritative.

**3. `(endpoint, action)` is the right key, but a block may carry VARIANTS.** Field sets are
genuinely disjoint across actions on one endpoint — `itembank/items` under `get` takes
`references`/`limit`/`next`/`status`/`tags`/`include`, under `set` an `items` array of definitions.
That is why the key needs two levels. The one apparent counter-example resolved cleanly: `sessions`
+ `set` is a **discriminated union on `data_format`**, not a third axis —

| `data_format` | `data` | Also takes | Article |
| :-- | :-- | :-- | :-- |
| `failed_submission` | `array[string]` of base64 session blobs | `ignore_response_revisions` | `26076336091933` |
| `from_template` | `array[object]` of sessions + responses | — | `26076278679069` |

Same endpoint, same action, disjoint fields, selected by a field *value*. Model it as a variant
inside the `(sessions, set)` block keyed on `data_format`. **The registry stays two-level.**

**4. Async is a MODE, not a second head — and `jobs` is the shared polling channel.** 13 documented blocks
create a long-running job and return a job reference in an endpoint-specific envelope, to be polled with `jobs` +
`get`. They are spread across `itembank/*`, `sessions/*`, `reports/*` and `jobs/*` — async is a
property of the individual operation, not of a path prefix, so it cannot be modelled by giving
`jobs/*` its own head. Two of the 13 are `get` blocks (`itembank/offlinepackage`,
`jobs/sessions/scores/subscores`), both documented in their response sections; reading the reference is not empirical verification.

**5. Paging and async are disjoint concerns.** 13 blocks page, 13 create jobs, and no block does
both. A read either returns a page (with `meta.next`) or a `job_reference`, never both.

## The scope boundary — SETTLED: the data/UX axis

**L0178 covers all 57 blocks.** The dividing line across this family of dialects is not which
vendor API a call belongs to. It is:

> **"I want the data" vs "I want a UX of the data."** They are two views of the same underlying
> thing, and each view is a dialect.

**L0178 is the DATA plane for the whole family.** Every other Learnosity dialect is a UX plane
over some slice of the same data:

| Underlying data | Data view | UX view |
| :--- | :--- | :--- |
| Item bank | **L0178** `itembank/*` | **L0177** (Author API) |
| Assessment results | **L0178** `sessions/*`, `reports/*` | a Reports dialect, unbuilt |
| Delivery | **L0178** `sessions/*` | an Items/Assess dialect, unbuilt |
| Grading | **L0178** `sessions/responses/scores/grading` | a Grading dialect, unbuilt |

The axis and the per-API split happen to coincide across this surface — nothing in the Data API's
57 blocks renders anything, and nothing in the Reports API's 89 articles returns raw records — but
the AXIS is the rule. Where the two ever disagree, follow the axis.

**Why this and not a per-goal split.** Moving the 19 `sessions/*` + `reports/*` blocks to a
Reports dialect looked attractive (a user asking for learner scores does not care which API
answers). It fails on three counts the ledger makes measurable:

- It splits the paged surface nearly in half — 7 of 13 paged blocks are `itembank/*`, **6 are
  `sessions/*`** — so the `meta.next`/`meta.records` discipline, the one thing here verified
  against a live consumer, would have to be taught in two prompts that then age independently.
- It splits the async mode: 4 `itembank`, 4 `jobs`, **5 `sessions`**.
- **It breaks the polling story outright.** A `sessions` write returns a `job_reference` whose
  only completion path is `jobs` + `get`. Split them and the Reports dialect cannot describe how
  to finish its own writes. The boundary is not even clean at the path level —
  `jobs/sessions/metadata`, `jobs/sessions/statuses`, `jobs/reports/datasets` straddle it.

And it does not recur. Session data is wanted by delivery, reporting AND grading; a goal-based cut
re-opens the same argument with every new dialect, while the axis answers it once.

**Two seams, stated rather than papered over.**

- L0178 is the data **access** plane, not a retrieval plane: it writes as well as reads. So the
  item bank has a UX write path (L0177's editor) and a data write path (L0178's `set`). That is
  not a contradiction; it is what "two views of the same data" means.
- **L0176 sits off the axis.** It composes item CONTENT — it is neither a data view nor a UX view
  of existing data, it makes the payload that `itembank/items` + `set` transports. The chain is
  L0176 composes → L0178 moves → L0177 renders for humans. Worth stating, because "authors
  Learnosity items" and "writes items to the bank" sound like one job and are not.

**Naming hazard.** Data API `reports/datasets` is NOT the Reports API. Two different things
sharing a word; L0178 owns the former and will never own the latter.

**Consequence for priorities.** Because this is the single data plane, partial coverage leaves
every future UX dialect with holes it cannot fill — a Reports dialect would punt score extraction
here and find it unbuilt. Completeness over the 57 matters more than it would for a leaf dialect.

## Provenance

Extracted from Learnosity's Zendesk help centre on 2026-08-13 — 56 Data API articles of 2,166
total. `help.learnosity.com` 403s WebFetch and curl, but the Zendesk API underneath is open:

```bash
curl -s "https://help.learnosity.com/api/v2/help_center/en-us/articles.json?per_page=100&page=N"
curl -s "https://help.learnosity.com/api/v2/help_center/en-us/articles/<id>.json"   # -> .article.body
```

Endpoint articles are titled `<Endpoint> - Endpoints - Data API`; error codes are
`<HTTP code> - Troubleshooting - Data API`. The `Source article` column below is the Zendesk id,
so any row can be re-read at its source. Parameter counts include nested properties and are for
SIZING ONLY — do not treat them as a field list.

Two extraction traps, both hit and fixed, both worth knowing before re-deriving this table: several
articles embed an `Example Response:` *inside* a parameter description, which truncates the
parameter section early (it put `itembank/questions get` at 6 params instead of 16); and an action
block's text runs on into the next operation's prose, so scanning a whole block for `job_reference`
marks every operation in a mixed article as async. Bound the parameter section on the
`Responses`/`Response example` header, and the async check on a short window after it.

## The ledger

### itembank  (25 blocks, 16 endpoints) — L0178 core

| Endpoint | Action | Paged | Async | Params | Source article |
| :-- | :-- | :-: | :-: | --: | :-- |
| `itembank/activities` | `get` | yes | — | 23 | `26076378893725` |
| `itembank/activities` | `set` | — | — | 22 | `26076378893725` |
| `itembank/activities/duplicate` | `set` | — | **job** | 14 | `26076378893725` |
| `itembank/activities/tags` | `set` | — | — | 12 | `26076378932765` |
| `itembank/activities/tags` | `update` | — | — | 12 | `26076378932765` |
| `itembank/activities/templates` | `get` | — | — | 1 | `26076390673565` |
| `itembank/features` | `get` | yes | — | 17 | `26076399481501` |
| `itembank/features` | `set` | — | — | 13 | `26076399481501` |
| `itembank/features/duplicate` | `set` | — | — | 10 | `26076399481501` |
| `itembank/items` | `get` | yes | — | 24 | `26076386828189` |
| `itembank/items` | `set` | — | — | 32 | `26076386828189` |
| `itembank/items/duplicate` | `set` | — | — | 13 | `26076386828189` |
| `itembank/items/tags` | `set` | — | — | 12 | `26076399449757` |
| `itembank/items/tags` | `update` | — | — | 13 | `26076399449757` |
| `itembank/offlinepackage` | `get` | — | **job** | 5 | `26076363707421` |
| `itembank/playertemplates` | `get` | — | — | 1 | `26076390673565` |
| `itembank/pools` | `get` | yes | — | 8 | `26076363663005` |
| `itembank/pools` | `set` | — | **job** | 17 | `26076363663005` |
| `itembank/pools` | `update` | — | **job** | 16 | `26076363663005` |
| `itembank/questions` | `get` | yes | — | 16 | `26076378985629` |
| `itembank/questions` | `set` | — | — | 13 | `26076378985629` |
| `itembank/questions/duplicate` | `set` | — | — | 10 | `26076378985629` |
| `itembank/upload/assets` | `get` | — | — | 5 | `26076399578397` |
| `itembank/workflows` | `get` | yes | — | 5 | `26076399599005` |
| `itembank/workflows` | `set` | — | — | 12 | `26076399599005` |

### itembank-tags  (6 blocks, 4 endpoints) — L0178 core

| Endpoint | Action | Paged | Async | Params | Source article |
| :-- | :-- | :-: | :-: | --: | :-- |
| `itembank/tagging/hierarchies` | `get` | — | — | 2 | `26076373806749` |
| `itembank/tagging/hierarchies/nodes` | `get` | — | — | 3 | `26076373806749` |
| `itembank/tagging/tags` | `get` | yes | — | 9 | `26076379042589` |
| `itembank/tagging/tags` | `set` | — | — | 14 | `26076379042589` |
| `itembank/tags` | `get` | — | — | 4 | `26076379042589` |
| `itembank/tags` | `set` | — | — | 3 | `26076379042589` |

### jobs  (5 blocks, 5 endpoints) — L0178 — async polling channel

| Endpoint | Action | Paged | Async | Params | Source article |
| :-- | :-- | :-: | :-: | --: | :-- |
| `jobs` | `get` | — | — | 10 | `26076318439197` |
| `jobs/reports/datasets` | `set` | — | **job** | 2 | `26076335897757` |
| `jobs/sessions/metadata` | `set` | — | **job** | 5 | `26076304349213` |
| `jobs/sessions/scores/subscores` | `get` | — | **job** | 1 | `26076310392861` |
| `jobs/sessions/statuses` | `update` | — | **job** | 4 | `26076335907869` |

### sessions  (16 blocks, 11 endpoints) — BOUNDARY — results surface

| Endpoint | Action | Paged | Async | Params | Source article |
| :-- | :-- | :-: | :-: | --: | :-- |
| `sessions` | `delete` | — | **job** | 1 | `26076304588445` |
| `sessions` | `set` | — | **job** | 28 | `26076278679069` |
| `sessions` | `set` | — | **job** | 4 | `26076336091933` |
| `sessions/item` | `update` | — | **job** | 6 | `26076318688925` |
| `sessions/metadata` | `get` | yes | — | 15 | `26076336114461` |
| `sessions/reports/adaptive` | `get` | yes | — | 15 | `26076304443165` |
| `sessions/responses` | `get` | yes | — | 17 | `26076304385565` |
| `sessions/responses/feedback` | `get` | — | — | 1 | `27824043349661` |
| `sessions/responses/feedback` | `update` | — | — | 10 | `27824043349661` |
| `sessions/responses/scores` | `get` | yes | — | 15 | `26076278639389` |
| `sessions/responses/scores` | `update` | — | **job** | 12 | `26076278639389` |
| `sessions/responses/scores/grading` | `get` | — | — | 1 | `37621876726813` |
| `sessions/responses/scores/grading` | `update` | — | — | 10 | `37621876726813` |
| `sessions/scores` | `get` | yes | — | 17 | `26076278627869` |
| `sessions/statuses` | `get` | yes | — | 17 | `26076351111453` |
| `sessions/templates` | `get` | — | — | 7 | `26076278657821` |

### reports  (3 blocks, 2 endpoints) — BOUNDARY — results surface

| Endpoint | Action | Paged | Async | Params | Source article |
| :-- | :-- | :-: | :-: | --: | :-- |
| `reports/datasets` | `get` | — | — | 4 | `26076304360861` |
| `reports/datasets` | `set` | — | — | 2 | `26076304360861` |
| `scoring` | `get` | — | — | 5 | `26076278598813` |

### misc  (2 blocks, 2 endpoints) — L0178 (fringe)

| Endpoint | Action | Paged | Async | Params | Source article |
| :-- | :-- | :-: | :-: | --: | :-- |
| `assets` | `get` | — | — | 2 | `26076278454301` |
| `consumer/keys/lti` | `set` | — | — | 4 | `26076278463389` |