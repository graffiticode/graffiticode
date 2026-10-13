<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0177 Vocabulary

**L0177** is the Learnosity **Author API** integration oracle. A program is an
`author-embed` head with a chain of property functions and one view function. The
compiled `data` is the normalized design plus `warnings` (steering hints); the
developer-facing deliverable is the `get_spec` recipe (goal, preconditions,
procedure, gotchas, verification steps).

The core language specification (syntax, semantics, base library) is here:
[Graffiticode Language Specification](./graffiticode-language-spec.html)

## Structure

| Function | Arity | Role |
| :------- | :---: | :--- |
| `author-embed` | 1 | Head; takes the property + view chain. |
| `item-edit` `item-list` `activity-edit` `activity-list` | 2 | **Views** — take a `[list]` of members; the view selects the Learnosity mode. |
| `item` `widget` `settings` `filter-restricted` `toolbar` | 1 | **Members** — take a property chain. |
| `container` `widget-templates` `global` | 2 | **Sections** — take a property sub-chain. |

Every **property** is a lowercase-kebab **arity-2** function (`name value`) that
chains; chains terminate with `{}`. Everything is optional (smart defaults). Content
tags are records mirroring Learnosity's payload — `[{type: "Grade", name: "4"}
{type: "Course"}]` — where `type` is required and `name` takes one string, several, or
none (matching every name of that type). A bare
property chain inside a view's `[list]` sets that view's own options rather than a
member's — `limit 25 {}` is `config.item_list.limit`.

## Property functions

A member's legal properties depend on the **view** it appears in: `item` names a
different Learnosity node in `item-edit` than in `item-list`, and the shared name
`status` is a boolean in one and a list of strings in the other.

| Context | Properties |
| :------ | :--------- |
| top-level (`author-embed`) | `domain`(str, req) · `user-id`(str, req) · `user-email` · `user-firstname` · `user-lastname` · `reference`(str) · `organisation-id`(num) · `question-type-groups`(group tag list — the enforced restriction) · `allow-widgets`(widget tag list — intent only) |
| `item-edit` › `item` | `answers` `back` `columns` `dynamic-content` `dynamic-image-tag` `enable-audio-recording` `scoring` `shared-passage` `status` `tabs` `actions-show` `popup-content-enable` `math-hints-generation-enable` (bool) · `reference-show` `reference-edit` (bool) · `reference-prefix`(str) · `title-show` `title-edit` `title-mandatory` (bool) · `tags-show` `tags-edit` (bool) · `save-show` `save-persist` `save-restricted-tags-allow-save` (bool) · `save-restricted-tags-all` `save-restricted-tags-either` (tag list) · `duplicate-show` `duplicate-shared-passages` (bool) · `mode-show`(bool) · `mode-default`(`"edit"`/`"preview"`) · `details-{acknowledgements,description,difficulty,note,scoring-type,source,status}-{show,edit}` (bool) |
| `item-edit` (view-level) | `tags-on-create`(tag list) |
| `item-edit` › `widget` | `edit` `delete` (bool) |
| `item-edit` › `settings` | `show` `full-height` (bool) |
| `item-list` › `item` | `url`(str) · `enable-selection` `status` `title-show` `title-show-reference` (bool) |
| `item-list` › `filter-restricted` | `current-user` `allow-filtered-tags-overwrite` (bool) · `created-by` `status` (str list) · `tags-all` `tags-either` `tags-none` (tag list) |
| `item-list` › `toolbar` | `toolbar-add` `search-show` `search-status` `search-tags-show` `search-widget-type` (bool) · `search-controls`(str list) |
| `item-list` (view-level) | `limit`(num) |
| `activity-edit` › `item` | `add-show` `edit-allow` `status-show` `title-show` `title-show-reference` `custom-points-toggle-show` `custom-points-toggle-default-checked` (bool) |
| `activity-edit` › `item-search` | `show` `back` `sort` `filter-restricted-current-user` `toolbar-search-show` (bool) · `limit`(num) · `filter-restricted-created-by` `toolbar-search-controls` (str list) · `filter-restricted-tags-all` `filter-restricted-tags-either` `filter-restricted-tags-none` (tag list) · `item-banks`(record list of `{organisation_id, item_bank_name, item_pool_id}`) |
| `activity-edit` › `player-playback` `player-time` `player-administration` `player-text` `player-scoring` | the assessment-player panes; each option is a `show`/`edit` pair, e.g. `limit-type-show` `limit-type-edit` |
| `activity-edit` › `activity-edit-save` `duplicate` `title` | `show` `persist` `restricted-tags-allow-save` · `restricted-tags-all` `restricted-tags-either`(tag list) · `deep-copy` `duplicate-shared-passages` · `edit` `mandatory` |
| `activity-list` › `filter-restricted` | `current-user`(bool) · `created-by` `status` (str list) · `tags-all` `tags-either` `tags-none` (tag list) |
| `activity-list` › `toolbar` | `toolbar-add` `add-adaptive` `add-branching` `add-random` `search` (bool) |
| `activity-list` (view-level) | `full-activity-json` `status` `title-show` `title-show-reference` (bool) · `limit`(num) |
| `activity-edit` (view-level) | `back` `details` `source` `status-show` `mode-show` `reference-show` `reference-edit` `tags-show` `tags-edit` `description-*` `difficulty-*` `*-enable` `*-show` `*-default-checked` `activity-edit-settings` (bool) · `mode-default`(`"edit"`/`"preview"`) · `default-player-template`(str) · `enabled-player-templates`(str list) · `tags-on-create`(tag list) |
| `container` | `height` `fixed-footer-height`(num) · `scroll-into-view-selector`(str) |
| `widget-templates` | `back` `save` `require-validation` (bool) |
| `global` | `disable-onbeforeunload` (bool) |

Four keywords mirror more of their Learnosity path than the rest, because the bare
leaf name is already taken: `filter-restricted` and `toolbar-add` (a bare `filter` or
`add` would shadow an inherited L0000 function), and `activity-edit-save` and
`activity-edit-settings` (a bare `save` is a `widget-templates` property, a bare
`settings` an `item-edit` member). A keyword carries one arity and one meaning across
the dialect, so members and properties share a single namespace.

## Question-type group tags (UPPERCASE)

`MCQ`, `CLOZE`, `MATCH`, `WRITE-SPEAK`, `HIGHLIGHT`, `MATH`, `GRAPH`, `CHART`,
`CHEMISTRY`, `OTHER` — the ten panes of the editor's widget picker, and the only
granularity at which the Author API is confirmed to restrict what authors may add.
`question-type-groups [MCQ CLOZE]` keeps those two groups and removes the other eight.

## Widget-type tags (UPPERCASE)

`MCQ`, `SHORT-TEXT`, `LONG-TEXT`, `PLAIN-TEXT`, `CLOZE-TEXT`, `CLOZE-ASSOCIATION`,
`CLOZE-DROPDOWN`, `CLOZE-FORMULA`, `CLOZE-INLINE-TEXT`, `CHOICE-MATRIX`,
`CLASSIFICATION`, `ORDER-LIST`, `SORT-LIST`, `FORMULA`, `GRAPH-PLOTTING`,
`HIGHLIGHT-TEXT`, `HOTSPOT`, `TOKEN-HIGHLIGHT`, `NUMBER-LINE`, `ASSOCIATION`,
`FILL-IN-THE-BLANKS`, `IMAGE-CLOZE-ASSOCIATION`, `IMAGE-CLOZE-TEXT`.

Function keywords are lowercase-kebab; tag values are UPPERCASE-kebab — so they
never collide. An unknown property is a parse error (every valid property is a
function).

## Example

```
author-embed
  domain "lms.example.edu"
  user-id "u123"
  reference "algebra-item-1"
  question-type-groups [MCQ CLOZE]
  allow-widgets [MCQ CLOZE-TEXT]
  item-edit [
    item back true scoring true reference-prefix "LEAR_" {}
    widget edit true delete false {}
  ]
  {}..
```
