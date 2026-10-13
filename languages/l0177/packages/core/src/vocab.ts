// SPDX-License-Identifier: MIT
// L0177 vocabulary — single source of truth for the lexicon and the compiler.
//
// Every PROPERTY is a kebab-case arity-2 function (value + continuation); chains
// terminate with `{}`. Members (`item`/`widget`/…) are arity-1 (a property chain).
// Views and sections are arity-2. Everything is optional — smart defaults keep
// programs short.
//
// A property's meaning depends on WHERE it appears: `status` is a boolean under
// `config.item_list.item` but an array of strings under
// `config.item_list.filter.restricted`. So the registry is keyed by view and then
// by member, and each field carries BOTH its Learnosity path and its type. The
// compiler resolves membership and type at the view fold, where that context is
// known — never in the property or member function, which cannot see it.
//
// Field entries are [learnosityPath, type]. The path is relative to its member
// (or section), and is recorded because the kebab name alone is ambiguous about
// its separator: `title-show` is `title.show` but `enable-selection` is
// `enable_selection`. The recipe must name exact paths, so it is never left to
// infer them.

// gc token / dispatch tag = UPPER_SNAKE of the kebab keyword.
export const TOK = (kw: string) => kw.toUpperCase().replace(/-/g, "_");

// Value types a field may declare.
//   boolean | number | string | strings (array of strings) | widgets (widget-type
//   tag list) | tags (Learnosity TagsV2: records of {type, name?}) | records (a list
//   of records validated against a schema) | groups (question-type picker groups, the
//   granularity Learnosity restricts at) | unmodeled (documented, deliberately not
//   modeled — reported as such rather than as a typo)
//
// The optional third element is a per-type CONSTRAINT: the accepted values for
// `string`/`strings`, or the element schema for `records`. Learnosity type-checks
// almost nothing and ignores what it doesn't recognise, so an out-of-range value or a
// misspelt key is exactly the kind of mistake that leaves an editor looking configured
// while doing nothing — worth catching here rather than in a running editor.
export type Fields = Record<string, Field>;
export type Field = [string, string] | [string, string, string[] | Fields];
export type Member = { path: string; fields: Fields };
export type View = {
  mode: string;
  view: Fields; // view-level scalars (config.<mode>.<field>)
  members: Record<string, Member>;
};

// The head. Members are derived from the registry below.
export const HEAD = "author-embed";

// Views (arity-2, [members]) — exactly one per program selects the Learnosity mode.
// All four Author API views are modeled: a member or field a view doesn't define is
// dropped with a warning, never passed through.
export const VIEWS: Record<string, View> = {
  "item-edit": {
    mode: "item_edit",
    view: {
      "tags-on-create": ["tags_on_create", "tags"],
    },
    members: {
      item: {
        path: "item",
        fields: {
          // flat scalars
          "answers": ["answers", "boolean"],
          "back": ["back", "boolean"],
          "columns": ["columns", "boolean"],
          "dynamic-content": ["dynamic_content", "boolean"],
          "dynamic-image-tag": ["dynamic_image_tag", "boolean"],
          "enable-audio-recording": ["enable_audio_recording", "boolean"],
          "scoring": ["scoring", "boolean"],
          "shared-passage": ["shared_passage", "boolean"],
          "status": ["status", "boolean"],
          "tabs": ["tabs", "boolean"],
          // item.actions
          "actions-show": ["actions.show", "boolean"],
          // item.details — each metadata field has an independent show/edit pair
          "details-acknowledgements-show": ["details.acknowledgements.show", "boolean"],
          "details-acknowledgements-edit": ["details.acknowledgements.edit", "boolean"],
          "details-description-show": ["details.description.show", "boolean"],
          "details-description-edit": ["details.description.edit", "boolean"],
          "details-difficulty-show": ["details.difficulty.show", "boolean"],
          "details-difficulty-edit": ["details.difficulty.edit", "boolean"],
          "details-note-show": ["details.note.show", "boolean"],
          "details-note-edit": ["details.note.edit", "boolean"],
          "details-scoring-type-show": ["details.scoring_type.show", "boolean"],
          "details-scoring-type-edit": ["details.scoring_type.edit", "boolean"],
          "details-source-show": ["details.source.show", "boolean"],
          "details-source-edit": ["details.source.edit", "boolean"],
          "details-status-show": ["details.status.show", "boolean"],
          "details-status-edit": ["details.status.edit", "boolean"],
          // item.duplicate
          "duplicate-show": ["duplicate.show", "boolean"],
          "duplicate-shared-passages": ["duplicate.duplicate_shared_passages", "boolean"],
          // item.math_hints_generation (v2025.2.LTS and later)
          "math-hints-generation-enable": ["math_hints_generation.enable", "boolean"],
          // item.mode — which editor mode opens by default, and whether the toggle shows
          "mode-default": ["mode.default", "string", ["edit", "preview"]],
          "mode-show": ["mode.show", "boolean"],
          // item.popup_content
          "popup-content-enable": ["popup_content.enable", "boolean"],
          // item.reference
          "reference-show": ["reference.show", "boolean"],
          "reference-edit": ["reference.edit", "boolean"],
          "reference-prefix": ["reference.prefix", "string"],
          // item.save
          "save-show": ["save.show", "boolean"],
          "save-persist": ["save.persist", "boolean"],
          // save.restricted_tags — block saving items carrying these tags. `allow-save`
          // only bites when one of the two lists is set, so it belongs with them.
          "save-restricted-tags-all": ["save.restricted_tags.all", "tags"],
          "save-restricted-tags-either": ["save.restricted_tags.either", "tags"],
          "save-restricted-tags-allow-save": ["save.restricted_tags.allow_save", "boolean"],
          // item.tags
          "tags-show": ["tags.show", "boolean"],
          "tags-edit": ["tags.edit", "boolean"],
          // item.title
          "title-show": ["title.show", "boolean"],
          "title-edit": ["title.edit", "boolean"],
          "title-mandatory": ["title.mandatory", "boolean"],
        },
      },
      widget: {
        path: "widget",
        fields: {
          "edit": ["edit", "boolean"],
          "delete": ["delete", "boolean"],
        },
      },
      settings: {
        path: "settings",
        fields: {
          "show": ["show", "boolean"],
          "full-height": ["full_height", "boolean"],
        },
      },
    },
  },

  "item-list": {
    mode: "item_list",
    view: {
      "limit": ["limit", "number"],
    },
    members: {
      // NOTE: config.item_list.item is a DIFFERENT node from config.item_edit.item.
      // They share exactly one field name (`status`). Attaching item-edit's fields
      // here is the bug this registry shape exists to make impossible.
      item: {
        path: "item",
        fields: {
          "url": ["url", "string"],
          "enable-selection": ["enable_selection", "boolean"],
          "status": ["status", "boolean"],
          "title-show": ["title.show", "boolean"],
          "title-show-reference": ["title.show_reference", "boolean"],
        },
      },
      // `filter-restricted`, not `filter`: a bare `filter` would shadow L0000's
      // list `filter`. The name mirrors more of the Learnosity path instead of
      // inventing a term. Every documented leaf under `filter` is under
      // `.restricted`, so nothing is lost.
      "filter-restricted": {
        path: "filter.restricted",
        fields: {
          "current-user": ["current_user", "boolean"],
          "created-by": ["created_by", "strings"],
          "status": ["status", "strings", ["published", "unpublished", "archived"]],
          "tags-all": ["tags.all", "tags"],
          "tags-either": ["tags.either", "tags"],
          "tags-none": ["tags.none", "tags"],
          "allow-filtered-tags-overwrite": ["tags.allow_filtered_tags_overwrite", "boolean"],
        },
      },
      toolbar: {
        path: "toolbar",
        fields: {
          // `toolbar-add`, not `add`: a bare `add` would shadow L0000's arithmetic
          // `add`. Same mirroring rule as `filter-restricted`.
          "toolbar-add": ["add", "boolean"],
          "search-show": ["search.show", "boolean"],
          "search-status": ["search.status", "boolean"],
          "search-tags-show": ["search.tags.show", "boolean"],
          "search-widget-type": ["search.widget_type", "boolean"],
          "search-controls": ["search.controls", "strings", ["reference", "content", "title"]],
        },
      },
    },
  },

  // The activity editor. Its config tree runs deeper than the item editor's (to five
  // segments), so members are cut where Learnosity itself panes the UI: a depth-1 node
  // with more than two leaves becomes a member named for its path, and a member with
  // more than ten leaves splits at depth 2 — which only `player` reaches. Smaller nodes
  // and depth-1 leaves stay view-level, since a member holding one property earns
  // nothing. Deeper segments flatten into the property name, as everywhere else.
  //
  // `activity-edit-save` and `activity-edit-settings` mirror the view segment because
  // the bare names collide: `save` is already a widget-templates property and `settings`
  // is already an item-edit member. Member and property keywords share ONE namespace
  // with one arity each — see the assertion in lexicon.ts.
  //
  // Two options are left out for different reasons, and the difference matters:
  //
  //   item_search.item_banks is modeled, minus its nested `filter` (shaped like
  //   item_search.filter, two levels deeper than a record schema reaches). That key
  //   reports itself as deferred rather than as a typo.
  //
  //   player_templates (array[PlayerTemplateObject]) is OUT OF SCOPE, not deferred. Past
  //   `name` and `reference` it is Assess API configuration (labelBundle, regions,
  //   navigation) ferried through the Author API, so modeling it means modeling Assess API.
  //   Designs pick a template by reference via default-player-template /
  //   enabled-player-templates. See spec/scope.json.
  //
  // item_title is skipped as deprecated — the reference directs callers to
  // activity_edit.item.title instead.
  "activity-edit": {
    mode: "activity_edit",
    view: {
      "activity-preview-item-reference-show": ["activity_preview.item.reference.show", "boolean"],
      "adaptive-fields-show": ["adaptive_fields.show", "boolean"],
      "tags-on-create": ["tags_on_create", "tags"],
      "annotations-enable": ["annotations.enable", "boolean"],
      "back": ["back", "boolean"],
      "customize-presets-enable": ["customize_presets.enable", "boolean"],
      "default-player-template": ["default_player_template", "string"],
      "description-edit": ["description.edit", "boolean"],
      "description-show": ["description.show", "boolean"],
      "details": ["details", "boolean"],
      "difficulty-edit": ["difficulty.edit", "boolean"],
      "difficulty-show": ["difficulty.show", "boolean"],
      "enabled-player-templates": ["enabled_player_templates", "strings"],
      "intro-item-default-checked": ["intro_item.default_checked", "boolean"],
      "mode-default": ["mode.default", "string", ["edit", "preview"]],
      "mode-show": ["mode.show", "boolean"],
      "outro-item-default-checked": ["outro_item.default_checked", "boolean"],
      "override-labels-enable": ["override_labels.enable", "boolean"],
      "player-template-builder-show": ["player_template_builder.show", "boolean"],
      "reference-edit": ["reference.edit", "boolean"],
      "reference-show": ["reference.show", "boolean"],
      "reporting-enable": ["reporting.enable", "boolean"],
      "resource-item-show": ["resource_item.show", "boolean"],
      "activity-edit-settings": ["settings", "boolean"],
      "source": ["source", "boolean"],
      "status-show": ["status.show", "boolean"],
      "tags-edit": ["tags.edit", "boolean"],
      "tags-show": ["tags.show", "boolean"],
    },
    members: {
      "player-playback": { path: "player.playback", fields: {
        "distractor-rationale-edit": ["distractor_rationale.edit", "boolean"],
        "distractor-rationale-response-level-edit": ["distractor_rationale_response_level.edit", "boolean"],
        "distractor-rationale-response-level-show": ["distractor_rationale_response_level.show", "boolean"],
        "distractor-rationale-show": ["distractor_rationale.show", "boolean"],
        "scroll-to-top-edit": ["scroll_to_top.edit", "boolean"],
        "scroll-to-top-show": ["scroll_to_top.show", "boolean"],
        "scrolling-indicator-edit": ["scrolling_indicator.edit", "boolean"],
        "scrolling-indicator-show": ["scrolling_indicator.show", "boolean"],
        "show": ["show", "boolean"],
        "show-acknowledgements-edit": ["show_acknowledgements.edit", "boolean"],
        "show-acknowledgements-show": ["show_acknowledgements.show", "boolean"],
        "shuffle-items-edit": ["shuffle_items.edit", "boolean"],
        "shuffle-items-show": ["shuffle_items.show", "boolean"],
        "skip-submit-confirmation-edit": ["skip_submit_confirmation.edit", "boolean"],
        "skip-submit-confirmation-show": ["skip_submit_confirmation.show", "boolean"],
        "submit-criteria-edit": ["submit_criteria.edit", "boolean"],
        "submit-criteria-show": ["submit_criteria.show", "boolean"],
        "warning-on-change-edit": ["warning_on_change.edit", "boolean"],
        "warning-on-change-show": ["warning_on_change.show", "boolean"],
      } },
      "item-search": { path: "item_search", fields: {
        "back": ["back", "boolean"],
        "filter-restricted-created-by": ["filter.restricted.created_by", "strings"],
        // Multiple item-bank sources. Record keys mirror Learnosity's payload verbatim,
        // as tag records do. `filter` is documented (same shape as item_search.filter)
        // but not modeled — it nests two levels deeper than a record schema reaches, so
        // it reports itself as deferred rather than as an unknown key.
        "item-banks": ["item_banks", "records", {
          "organisation_id": ["organisation_id", "number"],
          "item_bank_name": ["item_bank_name", "string"],
          "item_pool_id": ["item_pool_id", "string"],
          "filter": ["filter", "unmodeled"],
        }],
        "filter-restricted-tags-all": ["filter.restricted.tags.all", "tags"],
        "filter-restricted-tags-either": ["filter.restricted.tags.either", "tags"],
        "filter-restricted-tags-none": ["filter.restricted.tags.none", "tags"],
        "filter-restricted-current-user": ["filter.restricted.current_user", "boolean"],
        "limit": ["limit", "number"],
        "show": ["show", "boolean"],
        "sort": ["sort", "boolean"],
        "title-show": ["title.show", "boolean"],
        "title-show-reference": ["title.show_reference", "boolean"],
        "toolbar-search-controls": ["toolbar.search.controls", "strings", ["reference", "content", "title"]],
        "toolbar-search-show": ["toolbar.search.show", "boolean"],
      } },
      "player-time": { path: "player.time", fields: {
        "auto-save-edit": ["auto_save.edit", "boolean"],
        "auto-save-show": ["auto_save.show", "boolean"],
        "idle-timeout-edit": ["idle_timeout.edit", "boolean"],
        "idle-timeout-show": ["idle_timeout.show", "boolean"],
        "limit-type-edit": ["limit_type.edit", "boolean"],
        "limit-type-show": ["limit_type.show", "boolean"],
        "reading-mode-goto-first-item-on-reading-time-completion-show": ["reading_mode.goto_first_item_on_reading_time_completion.show", "boolean"],
        "show": ["show", "boolean"],
        "warning-time-edit": ["warning_time.edit", "boolean"],
        "warning-time-show": ["warning_time.show", "boolean"],
      } },
      "item": { path: "item", fields: {
        "add-show": ["add.show", "boolean"],
        "custom-points-toggle-default-checked": ["custom_points.toggle.default_checked", "boolean"],
        "custom-points-toggle-show": ["custom_points.toggle.show", "boolean"],
        "edit-allow": ["edit.allow", "boolean"],
        "status-show": ["status.show", "boolean"],
        "title-show": ["title.show", "boolean"],
        "title-show-reference": ["title.show_reference", "boolean"],
      } },
      "player-administration": { path: "player.administration", fields: {
        "show": ["show", "boolean"],
        "show-exit-edit": ["show_exit.edit", "boolean"],
        "show-exit-show": ["show_exit.show", "boolean"],
        "show-extend-edit": ["show_extend.edit", "boolean"],
        "show-extend-show": ["show_extend.show", "boolean"],
        "show-save-edit": ["show_save.edit", "boolean"],
        "show-save-show": ["show_save.show", "boolean"],
      } },
      "duplicate": { path: "duplicate", fields: {
        "deep-copy": ["deep_copy", "boolean"],
        "duplicate-shared-passages": ["duplicate_shared_passages", "boolean"],
        "show": ["show", "boolean"],
      } },
      "player-scoring": { path: "player.scoring", fields: {
        "client-side-scoring-edit": ["client_side_scoring.edit", "boolean"],
        "client-side-scoring-show": ["client_side_scoring.show", "boolean"],
        "show": ["show", "boolean"],
      } },
      "player-text": { path: "player.text", fields: {
        "font-size-edit": ["font_size.edit", "boolean"],
        "font-size-show": ["font_size.show", "boolean"],
        "show": ["show", "boolean"],
      } },
      "activity-edit-save": { path: "save", fields: {
        "persist": ["persist", "boolean"],
        "restricted-tags-all": ["restricted_tags.all", "tags"],
        "restricted-tags-either": ["restricted_tags.either", "tags"],
        "restricted-tags-allow-save": ["restricted_tags.allow_save", "boolean"],
        "show": ["show", "boolean"],
      } },
      "title": { path: "title", fields: {
        "edit": ["edit", "boolean"],
        "mandatory": ["mandatory", "boolean"],
        "show": ["show", "boolean"],
      } },
    },
  },

  // The activity browser. Shallow enough that only `filter.restricted` and `toolbar`
  // earn members — and both keywords already exist from item-list, so this view adds
  // no new member vocabulary at all, just fields scoped to it.
  //
  // Note `status` appears twice with different types: a boolean at view level (show the
  // status column) and a list of states under filter-restricted (which states to list).
  // Same word, same view, different node — exactly what the view/member-scoped registry
  // exists to keep straight.
  //
  "activity-list": {
    mode: "activity_list",
    view: {
      "full-activity-json": ["full_activity_json", "boolean"],
      "limit": ["limit", "number"],
      "status": ["status", "boolean"],
      "title-show": ["title.show", "boolean"],
      "title-show-reference": ["title.show_reference", "boolean"],
    },
    members: {
      "filter-restricted": {
        path: "filter.restricted",
        fields: {
          "current-user": ["current_user", "boolean"],
          "created-by": ["created_by", "strings"],
          "status": ["status", "strings", ["published", "unpublished", "archived"]],
          "tags-all": ["tags.all", "tags"],
          "tags-either": ["tags.either", "tags"],
          "tags-none": ["tags.none", "tags"],
        },
      },
      toolbar: {
        path: "toolbar",
        fields: {
          // `toolbar-add` elides less because a bare `add` would shadow L0000's
          // arithmetic function; its siblings need no such treatment.
          "toolbar-add": ["add", "boolean"],
          "add-adaptive": ["add_adaptive", "boolean"],
          "add-branching": ["add_branching", "boolean"],
          "add-random": ["add_random", "boolean"],
          "search": ["search", "boolean"],
        },
      },
    },
  },
};

// Sections (arity-2, a property sub-chain) at the top level of author-embed.
export const SECTIONS: Record<string, Member> = {
  "container": {
    path: "container",
    fields: {
      "height": ["height", "number"],
      "fixed-footer-height": ["fixed_footer_height", "number"],
      "scroll-into-view-selector": ["scroll_into_view_selector", "string"],
    },
  },
  "widget-templates": {
    path: "widget_templates",
    fields: {
      "back": ["back", "boolean"],
      "save": ["save", "boolean"],
      "require-validation": ["require_validation", "boolean"],
    },
  },
  "global": {
    path: "global",
    fields: {
      "disable-onbeforeunload": ["disable_onbeforeunload", "boolean"],
    },
  },
};

// Top-level properties in the author-embed chain -> [request path, type].
// `allow-widgets` has NO confirmed Learnosity binding (the documented widget-type
// restriction path was tested against the live API and restricts nothing), so its
// path is null: the recipe must carry it as intent plus a verification step, never
// as a config key. See spec/instructions.md.
export const TOPLEVEL: Record<string, [string | null, string]> = {
  "domain": ["domain", "string"],
  "user-id": ["user.id", "string"],
  "user-email": ["user.email", "string"],
  "user-firstname": ["user.firstname", "string"],
  "user-lastname": ["user.lastname", "string"],
  "reference": ["reference", "string"],
  "organisation-id": ["organisation_id", "number"],
  "allow-widgets": [null, "widgets"],
  // The one restriction Learnosity actually enforces, and the only top-level property
  // with a config (rather than request) path.
  "question-type-groups": [
    "config.dependencies.question_editor_api.init_options.question_type_groups", "groups",
  ],
};

// --- derived: everything the lexicon and compiler need ---

// Member keywords across all views (arity-1, alongside the head).
export const MEMBERS: string[] = [
  ...new Set(Object.values(VIEWS).flatMap((v) => Object.keys(v.members))),
];
export const ARITY1: string[] = [HEAD, ...MEMBERS];

// Every property keyword (arity-2), from every context it can appear in.
export const PROPERTIES: string[] = [
  ...new Set([
    ...Object.keys(TOPLEVEL),
    ...Object.values(SECTIONS).flatMap((s) => Object.keys(s.fields)),
    ...Object.values(VIEWS).flatMap((v) => [
      ...Object.keys(v.view),
      ...Object.values(v.members).flatMap((m) => Object.keys(m.fields)),
    ]),
  ]),
];

// Question-type GROUPS — the ten panes of the editor's widget picker, and the only
// granularity at which Learnosity actually restricts what an author may add. Verified
// differentially against the live Author API (see instructions.md): overriding a group
// reference with an empty `template_references` removes that group, and overriding it
// with the key omitted leaves it whole. Restricting therefore means overriding all ten.
export const GROUP_TAGS: Record<string, string> = {
  "MCQ": "mcq",
  "CLOZE": "cloze",
  "MATCH": "match",
  "WRITE-SPEAK": "writespeak",
  "HIGHLIGHT": "highlight",
  "MATH": "math",
  "GRAPH": "graph",
  "CHART": "chart",
  "CHEMISTRY": "chemistry",
  "OTHER": "other",
};

// Enum values are UPPERCASE-kebab TAG tokens (never collide with lowercase-kebab
// functions). Widget-type tags map to Learnosity's widget-type strings.
export const WIDGET_TAGS: Record<string, string> = {
  "MCQ": "mcq", "SHORT-TEXT": "shorttext", "LONG-TEXT": "longtext", "PLAIN-TEXT": "plaintext",
  "CLOZE-TEXT": "clozetext", "CLOZE-ASSOCIATION": "clozeassociation", "CLOZE-DROPDOWN": "clozedropdown",
  "CLOZE-FORMULA": "clozeformula", "CLOZE-INLINE-TEXT": "clozeinlinetext", "CHOICE-MATRIX": "choicematrix",
  "CLASSIFICATION": "classification", "ORDER-LIST": "orderlist", "SORT-LIST": "sortlist", "FORMULA": "formula",
  "GRAPH-PLOTTING": "graphplotting", "HIGHLIGHT-TEXT": "highlighttext", "HOTSPOT": "hotspot",
  "TOKEN-HIGHLIGHT": "tokenhighlight", "NUMBER-LINE": "numberline", "ASSOCIATION": "association",
  "FILL-IN-THE-BLANKS": "fillintheblanks", "IMAGE-CLOZE-ASSOCIATION": "imageclozeassociation",
  "IMAGE-CLOZE-TEXT": "imageclozetext",
};
