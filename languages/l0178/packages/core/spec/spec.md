<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0178 Vocabulary

This specification documents dialect-specific functions available in the
**L0178** language of Graffiticode. These functions extend the core language
with additional functionality tailored to L0178 use cases.

The core language specification including the definition of its syntax,
semantics and base library can be found here:
[Graffiticode Language Specification](./graffiticode-language-spec.html)

## Structure

A program is one `data-job` head carrying a paging policy and exactly one block
function, terminated with `{}` then `..`.

| Construct | Arity | Shape |
| :-------- | :---: | :---- |
| `data-job` | 1 | Head; takes the whole property + block chain. |
| A block | 2 | Takes a `[list]` of request fields; selects the operation. |
| `paging` | 2 | Design intent: `EXHAUSTIVE` or `SINGLE-PAGE`. Never sent in a request. |
| Request fields | 2 | `name value`, chained; the chain ends with `{}`. |

## Blocks

A keyword names one OPERATION. That is usually the `(endpoint, action)` pair; where the
API branches on a field value it is `(endpoint, action, discriminant)`, which is why
`sessions` + `set` appears twice.

| Block | Endpoint | Action | Shape | Loop ends on | Write semantics |
| :---- | :------- | :----- | :---- | :----------- | :-------------- |
| `items-get` | `itembank/items` | `get` | paged | `meta.next` absent | — |
| `responses-get` | `sessions/responses` | `get` | paged | an empty page | — |
| `jobs-get` | `jobs` | `get` | read | — | — |
| `offlinepackage-get` | `itembank/offlinepackage` | `get` | async | — | — |
| `items-set` | `itembank/items` | `set` | writes | — | replace |
| `items-tags-set` | `itembank/items/tags` | `set` | writes | — | replace |
| `activities-get` | `itembank/activities` | `get` | paged | `meta.next` absent | — |
| `questions-get` | `itembank/questions` | `get` | paged | `meta.next` absent | — |
| `features-get` | `itembank/features` | `get` | paged | `meta.next` absent | — |
| `pools-get` | `itembank/pools` | `get` | paged | `meta.next` absent | — |
| `workflows-get` | `itembank/workflows` | `get` | paged | `meta.next` absent | — |
| `tagging-tags-get` | `itembank/tagging/tags` | `get` | paged | `meta.next` absent | — |
| `tags-get` | `itembank/tags` | `get` | read | — | — |
| `tag-hierarchies-get` | `itembank/tagging/hierarchies` | `get` | read | — | — |
| `tag-hierarchy-nodes-get` | `itembank/tagging/hierarchies/nodes` | `get` | read | — | — |
| `upload-assets-get` | `itembank/upload/assets` | `get` | read | — | — |
| `activity-templates-get` | `itembank/activities/templates` | `get` | read | — | — |
| `player-templates-get` | `itembank/playertemplates` | `get` | read | — | — |
| `activities-tags-set` | `itembank/activities/tags` | `set` | writes | — | replace |
| `activities-tags-update` | `itembank/activities/tags` | `update` | writes | — | merge |
| `pools-update` | `itembank/pools` | `update` | async, writes | — | **not established** |
| `session-statuses-update` | `jobs/sessions/statuses` | `update` | async, writes | — | **not established** |
| `session-item-update` | `sessions/item` | `update` | async, writes | — | **not established** |
| `response-feedback-update` | `sessions/responses/feedback` | `update` | writes | — | **not established** |
| `response-scores-update` | `sessions/responses/scores` | `update` | async, writes | — | **not established** |
| `response-grading-update` | `sessions/responses/scores/grading` | `update` | writes | — | **not established** |
| `sessions-delete` | `sessions` | `delete` | async, **destructive** | — | **not established** |
| `sessions-set-from-template` | `sessions` | `set` | async, writes | — | **not established** |
| `sessions-set-failed-submission` | `sessions` | `set` | async, writes | — | **not established** |
| `items-tags-update` | `itembank/items/tags` | `update` | writes | — | merge |

**Request fields are documented per block in `instructions.md`, not here.** They are not
repeated in both files on purpose: two statements of one fact age independently, and the
field tables are long enough that a stale copy would be believed.

## Reading the table

- **Loop ends on** differs by endpoint and there is no universal rule. On `itembank/*` the
  cursor disappears at exhaustion; on `sessions/*` it is always present and an empty page
  is the signal. Each family's rule is a bug in the other, so the compiled output carries
  `paging_end` and the recipe branches on it.
- **Write semantics** is measured per operation and never inferred from the verb. Where it
  reads *not established*, only the tag-assignment endpoints have been measured and the
  behaviour of that operation is genuinely unknown — absence means unknown, not safe.
- **async** operations return a job reference instead of a result. The output names the
  redemption channel in `poll_with`, including where the reference sits in that
  endpoint's response, which is not the same everywhere.
