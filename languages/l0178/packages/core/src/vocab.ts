// SPDX-License-Identifier: MIT
// L0178 vocabulary — single source of truth for the lexicon and the compiler.
//
// Every PROPERTY is a kebab-case arity-2 function (value + continuation); chains
// terminate with `{}`. A BLOCK is arity-2 and takes a `[list]` holding one property
// chain. The head is arity-1.
//
// A keyword names one OPERATION. That is usually the (endpoint, action) PAIR —
// `items-get` is `itembank/items` + `get` — but where the API branches on a field VALUE
// it is (endpoint, action, discriminant): `sessions` + `set` is two operations selected
// by `data_format`, and they get a keyword each. See DISCRIMINATED OPERATIONS below. Modelling the pair as a single keyword
// rather than as two properties is what makes the scoping work: a field's legality
// depends on the pair, not on the endpoint alone (`itembank/items` under `get` takes
// `references`/`limit`/`next`; under `set` it takes an `items` array of definitions —
// disjoint sets). It also sidesteps the base lexicon, where bare `get` and `set` are
// already taken by L0000.
//
// See spec/coverage.md for the whole surface this is a slice of, and for the rules
// that fixed this design: `duplicate` is a path not an action; the action verb does
// not imply read-vs-write; async is a mode carried by 13 individual blocks rather
// than a path prefix; and a block may carry variants selected by a field VALUE
// (`sessions` + `set` on `data_format`) rather than by a third key axis.
//
// Field entries are [apiPath, type, constraint?]. The path is recorded because the
// kebab name alone is ambiguous about its separator: `include-items` is
// `include.items` but `item-pool-id` is `item_pool_id`. The recipe must name exact
// paths, so it is never left to infer them.

// gc token / dispatch tag = UPPER_SNAKE of the kebab keyword.
export const TOK = (kw: string) => kw.toUpperCase().replace(/-/g, "_");

// Value types a field may declare.
//   string | number | strings (list of strings) | tags (Learnosity TagsV2: records of
//   {type, name?}) | timestamp (a UTC Unix integer OR an ISO 8601 string — Learnosity
//   accepts either, so neither alone is a type error) | records (a list of records
//   validated against a declared element schema, so nested keys and types are checked by
//   the same machinery as a top-level field) | unmodeled (documented by Learnosity but
//   deliberately not modelled here — it reports itself as such rather than as a typo)
export type Constraint = {
  values?: string[];      // accepted values, for string / strings
  max?: number;           // maximum numeric value
  maxEntries?: number;    // maximum list length
  schema?: Fields;        // element schema, for `records`
  required?: string[];    // keys an element must carry, for `records`
};
export type Field = [string, string] | [string, string, Constraint];
export type Fields = Record<string, Field>;

// How a paged read signals that it is finished. THIS DIFFERS PER ENDPOINT FAMILY, and
// using the wrong one is catastrophic in both directions — both verified against the
// live demo consumer, 2026-08-13:
//
//   "next-absent"  (itembank/*)  meta.next is omitted once the result set is exhausted.
//                                Absence is the end signal. Page size means nothing here:
//                                an over-limit request is silently clamped, so every page
//                                can look short while more data remains.
//
//   "empty-page"   (sessions/*)  meta.next is ALWAYS present — it came back even on a
//                                zero-record page, and with the same token, because it is
//                                a long-poll resumption cursor rather than a more-data
//                                flag. Waiting for it to disappear NEVER TERMINATES. The
//                                end signal is a page with no records.
//
// So the rule the other family needs is the rule that breaks this one. Neither can be
// stated as a universal, and `paged: true` alone is not enough to write a loop.
export type PagingEnd = "next-absent" | "empty-page";

export type Block = {
  endpoint: string;      // Learnosity endpoint path, minus the {LTS_VERSION} prefix
  action: string;        // one of get | set | update | delete — the closed verb set
  paged: boolean;        // returns meta.next, so a paging policy is required
  pagingEnd?: PagingEnd; // required when paged — how the loop knows it is done
  async: boolean;        // returns { data: { job_reference } } instead of a result
  // True when the reference documents `organisation_id` as defaulting to the consumer's
  // PRIMARY Item bank. Not universal: on `jobs` the field filters jobs to a bank and no
  // default is documented, so omitting it means unfiltered rather than primary — and an
  // advisory saying "the primary bank is used" would be plainly false there.
  primaryBankDefault?: boolean;
  // Where the job reference sits in an async response. VERIFIED to differ per endpoint,
  // and NOT a documentation error: itembank/offlinepackage returns
  // `data: [{job_reference}]` and itembank/activities/duplicate returns
  // `data: {job_reference}`, each matching its own reference page. So one extraction does
  // not work everywhere — `data.job_reference` is undefined on the array endpoints — and
  // the shape has to travel with the block, like pagingEnd does.
  asyncEnvelope?: "array" | "object";
  // How a write treats what is already there. VERIFIED to differ BY ACTION on one and the
  // same endpoint: `itembank/items/tags` + `set` replaces the Item's tag set, while
  // + `update` merges into it. The reference documents identical parameters for both and
  // never says which is which, so the verb is the only signal and it is not a reliable one
  // (`itembank/items` + `set` also replaces, but nothing says `set` always means replace).
  writeSemantics?: "merge" | "replace";
  // Values this operation always sends, whatever the author writes — the discriminant of
  // a branched operation. Emitted into the request with their paths recorded, so the
  // author cannot omit one or contradict the payload it selects.
  fixed?: Record<string, [string, unknown]>;
  // True when the operation DESTROYS data irreversibly. Declared per block rather than
  // derived from `action === "delete"`, because this API has taught repeatedly that the
  // verb does not predict behaviour (C19) — and a destructive operation is the last place
  // to start inferring.
  destructive?: boolean;
  // True when the operation PERSISTS. Drives the write-safety warnings, and is not the
  // same as `action !== "get"` — some `get` operations start jobs that mutate.
  writes?: boolean;
  article: string;       // Zendesk article id — provenance for every field below
  fields: Fields;
};

// The head.
export const HEAD = "data-job";

// Blocks. One keyword per (endpoint, action) pair; exactly one per program.
//
// SLICE: 4 of the 57 blocks are modelled. coverage.md lists the rest. A block that is
// not here is not a typo — it is unbuilt, and the compiler says so rather than guessing
// at its fields.
//
// Each was chosen to DISAGREE with what was already modelled, which is the only reason
// the traps below were found rather than assumed:
//   items-get      itembank/*, paged, ends on an absent cursor
//   responses-get  sessions/*, paged, ends on an empty page — the opposite rule
//   jobs-get       not paged at all, and the channel every async operation redeems at
//   offlinepackage-get  async, and an async `get` — the verb says nothing about the shape
export const BLOCKS: Record<string, Block> = {
  "items-get": {
    endpoint: "itembank/items",
    action: "get",
    paged: true,
    pagingEnd: "next-absent",
    async: false,
    primaryBankDefault: true,
    article: "26076386828189",
    fields: {
      // filters
      "references": ["references", "strings", { maxEntries: 1000 }],
      "status": ["status", "strings", { values: ["published", "unpublished", "archived"] }],
      "created-by": ["created_by", "strings"],
      "scoring-type": ["scoring_type", "strings", {
        values: ["per-question", "per-dichotomous", "dependent"],
      }],
      "item-pool-id": ["item_pool_id", "string"],
      "organisation-id": ["organisation_id", "number"],
      // authoring_workflow — `reference` is mandatory whenever the object is present
      "authoring-workflow-reference": ["authoring_workflow.reference", "string"],
      "authoring-workflow-states": ["authoring_workflow.states", "strings"],
      // questions
      "questions-references": ["questions.references", "strings", { maxEntries: 1000 }],
      "questions-types": ["questions.types", "strings"],
      // tags. `tags` is a flat list; advanced_tags expresses all/either/none, and
      // `none` may never appear on its own.
      "tags": ["tags", "tags"],
      "advanced-tags-all": ["advanced_tags.all", "tags"],
      "advanced-tags-either": ["advanced_tags.either", "tags"],
      "advanced-tags-none": ["advanced_tags.none", "tags"],
      // response shaping
      "include-items": ["include.items", "strings", {
        values: [
          "adaptive", "dt_created", "dt_updated", "created_by",
          "last_updated_by", "max_score", "dynamic_content_data", "authoring_workflow",
        ],
      }],
      // ordering and windowing
      "sort": ["sort", "string", { values: ["asc", "desc"] }],
      "sort-field": ["sort_field", "string", {
        values: ["created", "updated", "reference", "title"],
      }],
      "mintime": ["mintime", "timestamp"],
      "maxtime": ["maxtime", "timestamp"],
      // paging
      "limit": ["limit", "number", { max: 50 }],
      "next": ["next", "string"],
    },
  },

  "responses-get": {
    endpoint: "sessions/responses",
    action: "get",
    paged: true,
    // NOT "next-absent". Measured: meta.next came back on a zero-record page, with the
    // same token. It is a long-poll resumption cursor here, not a more-data flag.
    pagingEnd: "empty-page",
    async: false,
    article: "26076304385565",
    fields: {
      // who / what
      "session-id": ["session_id", "strings", { maxEntries: 1000 }],
      "user-id": ["user_id", "strings", { maxEntries: 1000 }],
      "activity-id": ["activity_id", "strings", { maxEntries: 1000 }],
      // `status` is a SESSION status here. Same keyword as items-get, disjoint values —
      // which is why fields are scoped to their block rather than to the dialect.
      "status": ["status", "strings", {
        values: ["Incomplete", "Completed", "Discarded", "Pending Scoring"],
      }],
      // Three independent time axes: updated, started, submitted. Picking the wrong one
      // silently changes which sessions match, so each keeps its own keyword.
      "mintime": ["mintime", "timestamp"],
      "maxtime": ["maxtime", "timestamp"],
      "mintime-started": ["mintime_started", "timestamp"],
      "maxtime-started": ["maxtime_started", "timestamp"],
      "mintime-completed": ["mintime_completed", "timestamp"],
      "maxtime-completed": ["maxtime_completed", "timestamp"],
      // response shaping. The path is doubly nested and the kebab name cannot express
      // where the separators fall — the sharpest example yet of why paths are recorded.
      "include-session-metadata": ["include.sessions.session_metadata", "strings"],
      // ordering and windowing
      "sort": ["sort", "string", { values: ["asc", "desc"] }],
      "limit": ["limit", "number", { max: 50 }],
      "next": ["next", "string"],
    },
  },

  // The polling channel. Every async operation anywhere in the API is redeemed here, so
  // this is a legitimate standalone block: a caller polls a job_reference they already
  // hold. Not paged — it has no `next` — and not itself async.
  "jobs-get": {
    endpoint: "jobs",
    action: "get",
    paged: false,
    async: false,
    article: "26076318439197",
    fields: {
      "references": ["references", "strings", { maxEntries: 1000 }],
      // Learnosity documents Default: ["completed"]. It does not behave that way, and
      // MIRRORING the documented default is what breaks a polling loop — see
      // instructions.md §6 and C16. Omitting this field returns every status.
      "status": ["status", "strings", {
        values: ["queued", "running", "halted", "completed"],
      }],
      "include": ["include", "strings"],
      "organisation-id": ["organisation_id", "number"],
      "mintime": ["mintime", "timestamp"],
      "maxtime": ["maxtime", "timestamp"],
      "limit": ["limit", "number", { max: 50 }],
    },
  },

  // An async PRODUCER, and an async `get` — proof that the action verb says nothing about
  // whether an operation is a plain read. It returns a job_reference instead of a result.
  "offlinepackage-get": {
    endpoint: "itembank/offlinepackage",
    action: "get",
    paged: false,
    async: true,
    asyncEnvelope: "array",
    primaryBankDefault: true,
    article: "26076363707421",
    fields: {
      "organisation-id": ["organisation_id", "number"],
      "activity-references": ["activity_references", "strings", { maxEntries: 1000 }],
      // ItemObjects. `item_references` is documented alongside this and is DEPRECATED in
      // favour of it, so it is left out rather than carried — the same treatment L0177
      // gave `item_title`.
      "items": ["items", "records", {
        required: ["reference"],
        schema: {
          "id": ["id", "string"],
          "reference": ["reference", "string"],
          "organisation-id": ["organisation_id", "number"],
        },
      }],
      "base-directory": ["base_directory", "string"],
    },
  },

  // The first WRITE. Verified against sandbox 386 on 2026-08-17, and every one of its
  // hazards is silent: the request succeeds and the damage shows up later.
  //   - `set` REPLACES an Item. Fields omitted from the payload are cleared, not kept.
  //   - `status` defaults to `unpublished`, and an unpublished Item cannot be delivered.
  //   - the response `data` is an empty array — it does not echo what was written.
  //   - `definition` is REQUIRED and must hold at least one widget, so a complete write
  //     is impossible without content composed elsewhere (L0176).
  "items-set": {
    endpoint: "itembank/items",
    action: "set",
    paged: false,
    async: false,
    writes: true,
    writeSemantics: "replace",
    primaryBankDefault: true,
    article: "26076386828189",
    fields: {
      "organisation-id": ["organisation_id", "number"],
      "items": ["items", "records", {
        maxEntries: 50,
        required: ["reference", "definition"],
        schema: {
          "reference": ["reference", "string"],
          // Renames an existing Item when sent alongside `reference`.
          "new-reference": ["new_reference", "string"],
          "title": ["title", "string"],
          "description": ["description", "string"],
          "source": ["source", "string"],
          "note": ["note", "string"],
          // Defaults to "unpublished". An Item must be "published" to be used in an
          // assessment, so omitting this writes an Item nothing can deliver.
          "status": ["status", "string", {
            values: ["published", "unpublished", "archived"],
          }],
          "tags": ["tags", "tags"],
          "features": ["features", "strings"],
          "questions": ["questions", "records", {
            required: ["reference"],
            schema: { "reference": ["reference", "string"] },
          }],
          "metadata-acknowledgements": ["metadata.acknowledgements", "string"],
          "metadata-scoring-type": ["metadata.scoring_type", "string", {
            values: ["per-question", "per-dichotomous", "dependent"],
          }],
          "adaptive-difficulty": ["adaptive.difficulty", "number"],
          "authoring-workflow-reference": ["authoring_workflow.reference", "string"],
          "authoring-workflow-state": ["authoring_workflow.state", "string"],
          // CONTENT, and therefore L0176's surface — this dialect moves items, it does
          // not compose them. `definition` is nevertheless REQUIRED by the API, so it is
          // carried as unmodeled rather than omitted: a caller must pass a definition
          // through from wherever the content was authored, and saying "not modelled"
          // is more useful than either silence or a typo error.
          "definition": ["definition", "unmodeled"],
          "dynamic-content-data": ["dynamic_content_data", "unmodeled"],
          "workflow": ["workflow", "unmodeled"],
        },
      }],
    },
  },

  // The same endpoint under two verbs, and they behave DIFFERENTLY — which is the sharpest
  // demonstration of why the registry key is (endpoint, action). Measured on sandbox 386:
  // seeded tags A,B; `update` with C gave A,B,C; `set` with D gave D alone.
  "items-tags-set": {
    endpoint: "itembank/items/tags",
    action: "set",
    paged: false,
    async: false,
    writes: true,
    writeSemantics: "replace",
    primaryBankDefault: true,
    article: "26076399449757",
    fields: {
      "organisation-id": ["organisation_id", "number"],
      "items": ["items", "records", {
        maxEntries: 50,
        required: ["reference"],
        schema: {
          "reference": ["reference", "string"],
          "tags": ["tags", "tags"],
        },
      }],
      // Recorded in the audit trail and shown in the Learnosity Author Site history.
      "meta-user-id": ["meta.user.id", "string"],
      "meta-user-firstname": ["meta.user.firstname", "string"],
      "meta-user-lastname": ["meta.user.lastname", "string"],
      "meta-user-email": ["meta.user.email", "string"],
    },
  },

  // ---- the itembank read surface ----
  // Every one is paged or trivially small, and every one was exercised against sandbox
  // 386. `status` reaches a FOURTH distinct meaning here (pools), after Item, job and
  // session statuses — which is why values live on the field and never on the dialect.
  "activities-get": {
    endpoint: "itembank/activities", action: "get",
    paged: true, pagingEnd: "next-absent", async: false,
    primaryBankDefault: true, article: "26076378893725",
    fields: {
      "references": ["references", "strings", { maxEntries: 1000 }],
      "status": ["status", "strings", { values: ["published", "unpublished", "archived"] }],
      "organisation-id": ["organisation_id", "number"],
      "item-pool-id": ["item_pool_id", "string"],
      // Combination search: `all` must all be present, `either` at least one.
      "item-references-all": ["item_references.all", "strings"],
      "item-references-either": ["item_references.either", "strings"],
      "tags": ["tags", "tags"],
      "advanced-tags-all": ["advanced_tags.all", "tags"],
      "advanced-tags-either": ["advanced_tags.either", "tags"],
      "advanced-tags-none": ["advanced_tags.none", "tags"],
      "include-activities": ["include.activities", "strings", {
        values: ["created_by", "dt_created", "dt_updated", "last_updated_by", "metadata", "title"],
      }],
      // Only meaningful alongside include-activities created_by / last_updated_by.
      "populate-userdata": ["populate_userdata", "boolean"],
      "sort": ["sort", "string", { values: ["asc", "desc"] }],
      "sort-field": ["sort_field", "string", { values: ["created", "updated"] }],
      "mintime": ["mintime", "timestamp"],
      "maxtime": ["maxtime", "timestamp"],
      "limit": ["limit", "number"],
      "next": ["next", "string"],
    },
  },
  "questions-get": {
    endpoint: "itembank/questions", action: "get",
    paged: true, pagingEnd: "next-absent", async: false,
    primaryBankDefault: true, article: "26076378985629",
    fields: {
      "references": ["references", "strings", { maxEntries: 1000 }],
      "item-references": ["item_references", "strings", { maxEntries: 1000 }],
      "types": ["types", "strings"],
      "organisation-id": ["organisation_id", "number"],
      "item-pool-id": ["item_pool_id", "string"],
      "include-questions": ["include.questions", "strings", {
        values: ["dt_created", "dt_updated"] }],
      "sort": ["sort", "string", { values: ["asc", "desc"] }],
      "sort-field": ["sort_field", "string", { values: ["created", "updated"] }],
      "mintime": ["mintime", "timestamp"],
      "maxtime": ["maxtime", "timestamp"],
      "limit": ["limit", "number"],
      "next": ["next", "string"],
    },
  },
  "features-get": {
    endpoint: "itembank/features", action: "get",
    paged: true, pagingEnd: "next-absent", async: false,
    primaryBankDefault: true, article: "26076399481501",
    fields: {
      "references": ["references", "strings", { maxEntries: 1000 }],
      "item-references": ["item_references", "strings", { maxEntries: 1000 }],
      "types": ["types", "strings"],
      // Learnosity asks that this be paired with another filter, for performance.
      "content-search": ["content_search", "string"],
      "organisation-id": ["organisation_id", "number"],
      "item-pool-id": ["item_pool_id", "string"],
      "include-features": ["include.features", "strings", {
        values: ["dt_created", "dt_updated"] }],
      "sort": ["sort", "string", { values: ["asc", "desc"] }],
      "sort-field": ["sort_field", "string", { values: ["created", "updated"] }],
      "mintime": ["mintime", "timestamp"],
      "maxtime": ["maxtime", "timestamp"],
      "limit": ["limit", "number"],
      "next": ["next", "string"],
    },
  },
  "pools-get": {
    endpoint: "itembank/pools", action: "get",
    paged: true, pagingEnd: "next-absent", async: false,
    primaryBankDefault: true, article: "26076363663005",
    fields: {
      "references": ["references", "strings"],
      // FOURTH meaning of `status`: pools are published/unpublished/pending/halted.
      "status": ["status", "strings", {
        values: ["published", "unpublished", "pending", "halted"] }],
      "organisation-id": ["organisation_id", "number"],
      "sort": ["sort", "string", { values: ["asc", "desc"] }],
      "sort-field": ["sort_field", "string", { values: ["created", "updated"] }],
      "limit": ["limit", "number", { max: 50 }],
      "next": ["next", "string"],
    },
  },
  "workflows-get": {
    endpoint: "itembank/workflows", action: "get",
    paged: true, pagingEnd: "next-absent", async: false,
    primaryBankDefault: true, article: "26076399599005",
    fields: {
      "references": ["references", "strings", { maxEntries: 1000 }],
      "organisation-id": ["organisation_id", "number"],
      "limit": ["limit", "number", { max: 50 }],
      "next": ["next", "string"],
    },
  },
  "tagging-tags-get": {
    endpoint: "itembank/tagging/tags", action: "get",
    paged: true, pagingEnd: "next-absent", async: false,
    primaryBankDefault: true, article: "26076379042589",
    fields: {
      "names": ["names", "strings"],
      // Required when sort-field is "sort_key".
      "types": ["types", "strings"],
      "organisation-id": ["organisation_id", "number"],
      "item-pool-id": ["item_pool_id", "string"],
      "sort": ["sort", "string", { values: ["asc", "desc"] }],
      "sort-field": ["sort_field", "string", {
        values: ["sort_key", "created", "updated"] }],
      "limit": ["limit", "number", { max: 50 }],
      "next": ["next", "string"],
    },
  },
  "tags-get": {
    endpoint: "itembank/tags", action: "get",
    paged: false, async: false,
    primaryBankDefault: true, article: "26076379042589",
    fields: {
      "tags": ["tags", "strings"],   // NOTE: plain names here, not TagsV2 records
      "types": ["types", "strings"],
      "organisation-id": ["organisation_id", "number"],
      "item-pool-id": ["item_pool_id", "string"],
    },
  },
  "tag-hierarchies-get": {
    endpoint: "itembank/tagging/hierarchies", action: "get",
    paged: false, async: false,
    primaryBankDefault: true, article: "26076373806749",
    fields: {
      "references": ["references", "strings"],
      "organisation-id": ["organisation_id", "number"],
    },
  },
  "tag-hierarchy-nodes-get": {
    endpoint: "itembank/tagging/hierarchies/nodes", action: "get",
    paged: false, async: false,
    primaryBankDefault: true, article: "26076373806749",
    fields: {
      "reference": ["reference", "string"],
      "path": ["path", "tags"],   // an ORDERED list of TagsV2 objects
      "organisation-id": ["organisation_id", "number"],
    },
  },
  "upload-assets-get": {
    endpoint: "itembank/upload/assets", action: "get",
    paged: false, async: false,
    primaryBankDefault: true, article: "26076399578397",
    fields: {
      "subkeys": ["subkeys", "strings"],
      // Media types for files whose type cannot be auto-detected; every key must match
      // an entry in subkeys. A free-form map, so not modelled further.
      "subkey-types": ["subkey_types", "unmodeled"],
      "organisation-id": ["organisation_id", "number"],
    },
  },
  "activity-templates-get": {
    endpoint: "itembank/activities/templates", action: "get",
    paged: false, async: false,
    primaryBankDefault: true, article: "26076390673565",
    fields: { "organisation-id": ["organisation_id", "number"] },
  },
  "player-templates-get": {
    endpoint: "itembank/playertemplates", action: "get",
    paged: false, async: false,
    primaryBankDefault: true, article: "26076390673565",
    fields: { "organisation-id": ["organisation_id", "number"] },
  },

  // Activity tags, the sibling of items-tags-*. VERIFIED on sandbox 386: seeded A,B;
  // `update` with C gave A,B,C; `set` with D gave D alone — the same split as items/tags.
  // Two endpoints agreeing is evidence about the TAGS pattern, not about `update` in
  // general; the blocks below leave their semantics unstated for that reason.
  "activities-tags-set": {
    endpoint: "itembank/activities/tags", action: "set",
    paged: false, async: false, writes: true, writeSemantics: "replace",
    primaryBankDefault: true, article: "26076378932765",
    fields: {
      "organisation-id": ["organisation_id", "number"],
      "activities": ["activities", "records", { maxEntries: 50, required: ["reference"],
        schema: { "reference": ["reference", "string"], "tags": ["tags", "tags"] } }],
    },
  },
  "activities-tags-update": {
    endpoint: "itembank/activities/tags", action: "update",
    paged: false, async: false, writes: true, writeSemantics: "merge",
    primaryBankDefault: true, article: "26076378932765",
    fields: {
      "organisation-id": ["organisation_id", "number"],
      "activities": ["activities", "records", { maxEntries: 50, required: ["reference"],
        schema: { "reference": ["reference", "string"], "tags": ["tags", "tags"] } }],
    },
  },

  // The remaining `update` operations. NONE has its writeSemantics set, and that is the
  // point: merge-vs-replace is measured per (endpoint, action), the two measurements so
  // far are both tag-assignment endpoints, and guessing here destroys data. The compiler
  // says so rather than staying silent.
  "pools-update": {
    endpoint: "itembank/pools", action: "update",
    paged: false, async: true, asyncEnvelope: "array", writes: true,
    primaryBankDefault: true, article: "26076363663005",
    fields: {
      "organisation-id": ["organisation_id", "number"],
      "pools": ["pools", "records", { maxEntries: 50, required: ["reference"],
        schema: {
          "reference": ["reference", "string"],
          "name": ["name", "string"],
          // Pool content selection is a nested structure of its own; not modelled.
          "content": ["content", "unmodeled"],
        } }],
    },
  },
  "session-statuses-update": {
    endpoint: "jobs/sessions/statuses", action: "update",
    paged: false, async: true, asyncEnvelope: "object", writes: true,
    article: "26076335907869",
    fields: {
      "statuses": ["statuses", "records", { maxEntries: 100,
        required: ["session_id", "status"],
        schema: {
          "session-id": ["session_id", "string"],
          // Note: NOT the Item statuses, and not the job statuses either.
          "status": ["status", "string", { values: ["Completed", "Incomplete", "Discarded"] }],
          "user-id": ["user_id", "string"],
        } }],
    },
  },
  "session-item-update": {
    endpoint: "sessions/item", action: "update",
    paged: false, async: true, asyncEnvelope: "object", writes: true,
    article: "26076318688925",
    fields: {
      "session-ids": ["session_ids", "strings", { maxEntries: 100 }],
      "target-item-reference": ["target_item.reference", "string"],
      "target-item-organisation-id": ["target_item.organisation_id", "number"],
      "target-item-pool-id": ["target_item.item_pool_id", "string"],
    },
  },
  "response-feedback-update": {
    endpoint: "sessions/responses/feedback", action: "update",
    paged: false, async: false, writes: true,
    article: "27824043349661",
    fields: {
      "session-id": ["session_id", "string"],
      // The per-response feedback payload nests grader entries; left unmodelled rather
      // than invented, since it is grading content rather than transport structure.
      "items": ["items", "records", { required: ["item_reference"],
        schema: {
          "item-reference": ["item_reference", "string"],
          "responses": ["responses", "unmodeled"],
        } }],
    },
  },
  "response-scores-update": {
    endpoint: "sessions/responses/scores", action: "update",
    paged: false, async: true, asyncEnvelope: "object", writes: true,
    article: "26076278639389",
    fields: {
      "sessions": ["sessions", "records", { maxEntries: 1000,
        required: ["session_id"],
        schema: {
          "session-id": ["session_id", "string"],
          "user-id": ["user_id", "string"],
          "responses": ["responses", "unmodeled"],
        } }],
    },
  },
  "response-grading-update": {
    endpoint: "sessions/responses/scores/grading", action: "update",
    paged: false, async: false, writes: true,
    article: "37621876726813",
    fields: {
      "session-id": ["session_id", "string"],
      "items": ["items", "records", { required: ["item_reference"],
        schema: {
          "item-reference": ["item_reference", "string"],
          "responses": ["responses", "unmodeled"],
        } }],
    },
  },

  // The only `delete` in the API, and the only block capped at ONE entry — every other
  // batch allows 50. That cap is deliberate: Learnosity scopes this endpoint to
  // right-to-be-forgotten requests and small deletions, and directs bulk cleanup to
  // support instead. DOCUMENTED ONLY: firing it destroys a session irreversibly, and the
  // sandbox holds sessions this project did not create.
  "sessions-delete": {
    endpoint: "sessions",
    action: "delete",
    paged: false,
    async: true,
    asyncEnvelope: "array", // [documented] — the article shows the array form
    writes: true,
    destructive: true,
    article: "26076304588445",
    fields: {
      "session-ids": ["session_ids", "strings", { maxEntries: 1 }],
    },
  },

  // DISCRIMINATED OPERATIONS. `sessions` + `set` is documented twice, and the two
  // documents describe genuinely different operations selected by `data_format` (C3).
  // They get a keyword each rather than one keyword plus variant machinery, for three
  // reasons:
  //   - `data` is `array[object]` in one and `array[string]` in the other. A single
  //     `data` keyword meaning two different types is exactly the hazard the per-block
  //     field scoping exists to prevent.
  //   - variant machinery would sit in every block's validation path to serve ONE
  //     documented case — the same objection that kept a third registry axis out (C3).
  //   - the discriminant becomes unmissable and uncontradictable: the block chooses it,
  //     `fixed` emits it, and the author cannot omit it or mismatch it to the payload.
  // Both are UNVERIFIED — they write sessions, and there was no cheap way to exercise
  // one without manufacturing session data. Fields and envelope are documented only.
  "sessions-set-from-template": {
    endpoint: "sessions",
    action: "set",
    paged: false,
    async: true,
    // [documented] — the sessions article shows the object form. NOT measured; the two
    // endpoints that were measured disagree with each other, so this is a real claim
    // rather than a safe default.
    asyncEnvelope: "object",
    writes: true,
    article: "26076278679069",
    fixed: { "data-format": ["data_format", "from_template"] },
    fields: {
      "sessions-data": ["data", "records", {
        maxEntries: 50,
        required: ["activity_id"],
        schema: {
          "user-id": ["user_id", "string"],
          "activity-id": ["activity_id", "string"],
          "session-id": ["session_id", "string"],
          // Response objects vary by question type; only question_id is common across
          // all of them, so the shape is content and passes through unchecked.
          "responses": ["responses", "unmodeled"],
        },
      }],
    },
  },

  "sessions-set-failed-submission": {
    endpoint: "sessions",
    action: "set",
    paged: false,
    async: true,
    asyncEnvelope: "object", // [documented], as above
    writes: true,
    article: "26076336091933",
    fixed: { "data-format": ["data_format", "failed_submission"] },
    fields: {
      // Note the type: base64 STRINGS here, where the from_template variant takes
      // objects under the same Learnosity path. One keyword, typed per block — the same
      // treatment `status` gets. The keyword mirrors the endpoint because a bare `data`
      // would shadow L0000's, which mergeLexicon caught when it was first written.
      "sessions-data": ["data", "strings", { maxEntries: 50 }],
      "ignore-response-revisions": ["ignore_response_revisions", "boolean"],
    },
  },

  "items-tags-update": {
    endpoint: "itembank/items/tags",
    action: "update",
    paged: false,
    async: false,
    writes: true,
    writeSemantics: "merge",
    primaryBankDefault: true,
    article: "26076399449757",
    fields: {
      "organisation-id": ["organisation_id", "number"],
      "items": ["items", "records", {
        maxEntries: 50,
        required: ["reference"],
        schema: {
          "reference": ["reference", "string"],
          "tags": ["tags", "tags"],
        },
      }],
      // Recorded in the audit trail and shown in the Learnosity Author Site history.
      "meta-user-id": ["meta.user.id", "string"],
      "meta-user-firstname": ["meta.user.firstname", "string"],
      "meta-user-lastname": ["meta.user.lastname", "string"],
      "meta-user-email": ["meta.user.email", "string"],
    },
  },
};

// Top-level properties, carried by the head rather than by a block.
//
// `paging` is DESIGN INTENT, not an API field: it has no Learnosity path and is never
// emitted into a request. It exists because the failure this dialect is built to
// prevent is a truncated read — the API returns a valid response and a well-formed
// record set that is silently incomplete, and `meta.records` counts the CURRENT PAGE,
// not the total. Leaving the policy implicit is how that ships. So on a paged block,
// its absence is a hole.
export const TOPLEVEL: Record<string, [string | null, string]> = {
  "paging": [null, "paging"],
};

// Paging policy tags -> the value carried in the output.
export const PAGING_TAGS: Record<string, string> = {
  "EXHAUSTIVE": "exhaustive",
  "SINGLE-PAGE": "single-page",
};

// --- derived: everything the lexicon and compiler need ---

export const ARITY1: string[] = [HEAD];

// Every field keyword across every block, plus the top-level properties. A name that
// appears in two blocks is ONE keyword with one arity; the fold resolves its meaning,
// exactly as L0177 scopes a member's fields by view.
export const PROPERTIES: string[] = [
  ...new Set([
    ...Object.keys(TOPLEVEL),
    ...Object.values(BLOCKS).flatMap((b) => Object.keys(b.fields)),
  ]),
];
