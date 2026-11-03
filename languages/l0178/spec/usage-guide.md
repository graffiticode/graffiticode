<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# L0178 Usage Guide

## Overview

L0178 is a developer cookbook for the **Learnosity Data API** — the server-to-server
interface to a Learnosity Item bank. A client describes a *data job*: which operation to
run, and what the request carries. L0178 validates that description, reports holes and
unsafe combinations as steering warnings, and returns a host-language-neutral recipe
covering how to sign the request, how to page the result set to completion, how to read
the response envelope, and how to verify the job did what was intended.

It produces empirically informed recipes. When handling a recipe request it never calls the Data API: the caller's own code signs and
sends every request with the caller's own consumer key. What L0178 supplies is the
published documentation plus the un-written tricks and tips — the things the docs omit,
or state in a way that reads correctly and behaves otherwise.

The failure it is built to prevent is a **truncated read**. A short result set comes back
as HTTP 200 with `meta.status: true` and a well-formed `data` array, and `meta.records`
counts the page you got rather than the total that matched — so nothing about it looks
wrong. That is why a paged job must declare how far it reads before the design is
considered complete.

It does not author item content (that is L0176) and does not cover the Author API
authoring experience (that is L0177).

This is an empirical integration oracle. Its knowledge combines Learnosity's published documentation with observations from direct API experiments. It checks the integration design and returns a host-language-neutral recipe that identifies known behavior, documented expectations, and remaining verification work.

When handling a recipe request, the oracle does not sign or send Learnosity API requests. The caller implements the recipe using their own credentials and environment. A complete design means the modeled inputs are present; it does not mean the integration has been verified in that environment.

## Vocabulary Cues

A program is one `data-job` head carrying a paging policy and exactly one **block**
function, terminated with `{}` then `..`:

```
data-job
  paging EXHAUSTIVE
  items-get [
    references ["Grade7_ELA_1021" "Grade7_ELA_1022"]
    status ["published"]
    include-items ["dt_created" "dt_updated"]
    organisation-id 123
    limit 50
    {}
  ]
  {}..
```

- **A block is one `(endpoint, action)` pair.** `items-get` is `itembank/items` + `get`.
  One keyword per pair, because a field's legality depends on the pair rather than on the
  endpoint alone — and because bare `get` and `set` belong to the base language.
  Thirty are modelled, spanning every shape the API has — see `spec.md` for the index
  and `instructions.md` for each one's request fields.
- **`offlinepackage-get` is asynchronous** — it returns a job reference rather than a
  result, and is redeemed by polling `jobs-get`. Neither of those two is paged, so neither
  takes a paging policy. Note it is an async `get`: the action verb says nothing about what
  an operation does.
- **`paging`** takes `EXHAUSTIVE` (read until the operation's `paging_end`: absent `meta.next` for Item bank reads, an empty page for session responses) or `SINGLE-PAGE`
  (deliberately take one page). It is design intent, never sent in a request. On a paged
  block its absence is a hole.
- **Request fields are lowercase-kebab**, flattened from the API's nesting:
  `include-items` is `include.items`, `authoring-workflow-reference` is
  `authoring_workflow.reference`. The exact path is recorded in the output's `paths` map,
  because the kebab name alone can't say whether a hyphen was a `.` or a `_`.
- **Everything except the block and the paging policy is optional** — an unfiltered read
  is legal, and warns that it reads the whole bank.
- An unknown property is a **parse error**, not a warning. Warnings are reserved for
  values and combinations the compiler accepted but wants to steer.

## Example Prompts

- "Read the published Items tagged subject=English from Item bank 123, all of them."
- "Fetch Items Grade7_ELA_1021 and Grade7_ELA_1022 with their creation and update dates."
- "Get every Item containing an mcq question, created since January, newest first."
- "Pull one page of archived Items so I can eyeball the shape of the data."

## Out of Scope

- Authoring item **content** → L0176.
- Embedding the Author API authoring experience → L0177.
- Assessment delivery (Items API), analytics (Reports API) → separate sibling dialects,
  neither of which exists. Say no dialect covers it rather than stretching this one.
- Data API operations not yet modelled — 39 of the 57, mostly reads and `set`s in the
  `itembank/*`, `sessions/*` and `reports/*` families. `spec/coverage.md` lists the whole
  surface; an operation absent from the vocabulary is unbuilt, not unsupported, and must
  not be guessed at.
- Calling the Learnosity API. L0178 holds no credentials and sends no requests.
- Runnable host-language code — the recipe is a language-neutral procedure you implement
  yourself.
