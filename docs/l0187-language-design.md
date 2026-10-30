# L0187 Declarative FigJam Language Design

- Status: proposed language design, ready for implementation planning.
- Date: 2026-10-30.
- Language: `0187`. Proposed published name: **Declarative FigJam boards**.
- Compiler: Rust, using the shared Graffiticode syntax and runtime.

L0187 refines L0186 by making geometry a compiler responsibility. A program
declares content, membership, relationships, and meaningful order. The compiler
measures that content, arranges it, and validates the resulting geometry before
returning an accepted positioned board. Coordinates, dimensions, spacing, and
connector routes are compiled output.

This design specializes the [declarative FigJam proposal](declarative-figjam-language.md).
It follows [typed members and attribute chains](language-style-typed-chains.md)
and the shared validation and diagnostic rules in
[language authoring style](language-authoring-style.md). Documentation and
generated authoring material follow the
[documentation maintenance guidelines](language-documentation-maintenance.md).

## 1. Scope and compatibility

The initial language covers retrospective and kanban boards, workshop pages,
comparisons, process and decision flows, and small system diagrams. All can be
expressed through content and organization without manual placement.

L0187 is selected explicitly. Saved L0186 programs keep L0186 semantics; removing
coordinates from an L0186 program does not change its language identity.
L0186 remains available for explicit drawing. L0187 has no positional escape
hatch and does not compile by invoking the L0186 compiler.

The initial release includes stickies, textboxes, a measured subset of shapes,
sections, invisible layout groups, connectors, and multiple pages. Reaction
stamps, nested visible sections, images, freehand drawing, importing or editing
existing boards, and arbitrary native FigJam objects are outside this release.
Assessments, numerical charts, and spreadsheets retain their existing language
routing.

The statements below specify proposed language behavior. The example programs
are inputs for the future L0187 compiler, not executable L0186 examples.

## 2. Surface syntax

Keep L0186's typed-chain style. There are four regular construct shapes:

| Construct | Arity | Form |
| --- | --- | --- |
| Container | 2 | `section [ members ] settings {}` |
| Typed member | 1 | `sticky id "a" text "A" {}` |
| Property | 2 | `text "A" fill "yellow" {}` |
| Closed-set tag | 0 | `DIAMOND`, `ROW`, `RIGHT` |

**Every member description and every container settings chain ends in `{}`.**
Properties may appear in any order, once each. Repeated properties are errors.
Lists of things contain typed members; lists of scalar IDs contain strings.
Descriptions never use the older attribute-list form.

The program constructs exactly one `board`, ending in `..`. The existing
`save-to-figjam` statement is the one destination statement, described in §10.
Shared base-language expressions and bindings remain available; reuse `set-var`
instead of introducing a new binding word. Evaluated values must satisfy the
same dialect validation as literal values.

```gc
board [
  page [
    sticky id "idea" text "Idea" {}
    sticky id "plan" text "Plan" {}
    connector id "idea-plan" from "idea" to "plan" label "develop" {}
  ] id "planning" name "Planning" layout FLOW direction RIGHT {}
] title "Planning board" layout-profile FIGJAM_V1 {}..
```

## 3. Vocabulary and legal locations

### Containers and members

`section` and `group` are containers that also act as typed children of another
container. Their lists preserve structure rather than merge child records.
The mixed children of a region are a closed union of named member types, as in
L0186's page; anonymous records are not implicit marks or groups.

| Word | Arity | Meaning |
| --- | --- | --- |
| `board` | 2 | Ordered pages and board settings. |
| `page` | 2 | One independently arranged canvas and its settings. |
| `section` | 2 | A visible, named container; its title and border participate in layout. |
| `group` | 2 | An invisible layout region; contributes structure and bounds, with no visible frame or title. |
| `sticky` | 1 | A sticky note containing plain text. |
| `shape` | 1 | A text-bearing diagram shape. |
| `textbox` | 1 | Standalone plain text, measured and wrapped by the compiler. |
| `connector` | 1 | One relationship between two marks on the same page. |
| `save-to-figjam` | 1 | A top-level statement naming the destination file. |

| Container | Allowed children |
| --- | --- |
| `board` | `page` |
| `page` | `sticky`, `shape`, `textbox`, `section`, `group`, `connector` |
| `section` | `sticky`, `shape`, `textbox`, `group` |
| `group` | `sticky`, `shape`, `textbox`, `section`, `group` |

Connectors are declared directly in the page, including those between marks
deep inside its groups and sections. A section cannot have another section
anywhere beneath it, including through a group. Groups may nest within groups
and sections. This gives compositional layout while retaining one tier of
visible sections for the initial adapter.

### Property words

All property words have arity 2: a value followed by a continuation record.
Their source spellings map directly to semantic fields: `font-size` emits
`fontSize`, `layout-profile` emits `layoutProfile`, and so on. Native-target
translations such as `kind` to `shapeType` happen during lowering.

| Word | Value | Meaning |
| --- | --- | --- |
| `id` | Nonempty string | Explicit semantic identity. |
| `text` | String, including empty | Full plain-text content of a mark. |
| `name` | Nonempty string | Display name of a page or section. |
| `title` | Nonempty string | Board title metadata. |
| `kind` | Shape tag | Shape outline; default `SQUARE`. |
| `layout` | Layout tag | Structural arrangement of a region's direct placeable children. |
| `direction` | Direction tag | Preferred progression axis of an explicit `FLOW`. |
| `columns` | Positive integer | Structural column count of a `GRID`. |
| `before` | Nonempty list of ID strings | Strict precedence over named siblings in an explicit `FLOW`. |
| `from`, `to` | One ID string each | Source and target mark of a connector. |
| `label` | String, including empty | Full connector label. |
| `fill` | Color string | Sticky, shape, or section fill. |
| `stroke` | Color string | Shape outline or connector stroke. |
| `color` | Color string | Textbox text color. |
| `background` | Color string | Page background. |
| `opacity` | Number from 0 to 100 | Presentation opacity; does not remove an object from layout. |
| `font-size` | Font-size tag | Requested text size; no numeric override. |
| `stroke-width` | Stroke-width tag | Stroke weight; no numeric override. |
| `line-style` | Line-style tag | Solid or dashed connector presentation. |
| `from-cap`, `to-cap` | Cap tag | Endpoint decoration, retaining the L0186 vocabulary. |
| `show-page-tabs`, `show-page-menu` | Boolean | Page navigation in the preview. |
| `layout-profile` | Profile tag | Immutable measurement, layout, and validation policy bundle. |

The following are complete allowed-property sets. Conditional rules such as
`columns` requiring `GRID` are additional checks, not silently ignored fields.

| Description | Allowed properties |
| --- | --- |
| `sticky` | `id`, `text`, `fill`, `opacity`, `font-size`, `before` |
| `shape` | `id`, `text`, `kind`, `fill`, `stroke`, `stroke-width`, `opacity`, `font-size`, `before` |
| `textbox` | `id`, `text`, `color`, `opacity`, `font-size`, `before` |
| `connector` | `id`, `from`, `to`, `label`, `stroke`, `stroke-width`, `opacity`, `font-size`, `line-style`, `from-cap`, `to-cap` |

| Container settings | Allowed properties |
| --- | --- |
| `board` | `title`, `show-page-tabs`, `show-page-menu`, `layout-profile` |
| `page` | `id`, `name`, `background`, `layout`, `direction`, `columns` |
| `section` | `id`, `name`, `fill`, `opacity`, `layout`, `direction`, `columns`, `before` |
| `group` | `id`, `layout`, `direction`, `columns`, `before` |

`id` is required on every page, section, group, mark, and connector. `text` is
required on stickies, shapes, and textboxes. `name` is required on pages and
sections. `from` and `to` are required on connectors. A board requires at least
one page; pages and regions may be empty so workshop templates are representable.

Pages retain their declared order. Tabs default to visible with multiple pages
and hidden with one; the page menu defaults to hidden. A multiple-page board
cannot hide both navigation controls. The board title is metadata, while page
names and section names supply their existing visible labels. An in-canvas
heading is an explicit `textbox` that participates in layout.

### Closed sets and presentation defaults

| Property | Initial tags |
| --- | --- |
| `layout` | `AUTO`, `ROW`, `COLUMN`, `GRID`, `FLOW` |
| `direction` | `RIGHT`, `LEFT`, `DOWN`, `UP` |
| `kind` | `SQUARE`, `ROUNDED_RECTANGLE`, `ELLIPSE`, `DIAMOND`, `PARALLELOGRAM_RIGHT`, `PREDEFINED_PROCESS`, `DOCUMENT_SINGLE`, `ENG_DATABASE` |
| `font-size` | `SMALL`, `MEDIUM`, `LARGE`, `EXTRA_LARGE`, `HUGE` |
| `stroke-width` | `THIN`, `THICK` |
| `line-style` | `SOLID`, `DASHED` |
| `from-cap`, `to-cap` | `NONE`, `ARROW_LINES`, `ARROW_EQUILATERAL`, `TRIANGLE_FILLED`, `CIRCLE_FILLED`, `DIAMOND_FILLED` |
| `layout-profile` | `FIGJAM_V1` |

Tags are bare and uppercase. The initial shape set requires measurement support
for every listed kind; the remaining L0186 shapes are not automatically included.
Shape outlines do not create graph semantics: a `DIAMOND` is not required to have
two outgoing connections, and an `ENG_DATABASE` does not imply persistence.

Colors retain L0186's three- or six-digit hex strings and named colors:
`"red"`, `"blue"`, `"green"`, `"yellow"`, `"purple"`, `"orange"`, `"pink"`,
`"white"`, `"black"`, and `"gray"`.

`FIGJAM_V1` retains the font presets 16, 24, 40, 64, and 96 pixels and stroke
presets 4 and 8 pixels. Marks default to `MEDIUM`; connector labels default to
`SMALL`. A requested preset is preserved. The compiler does not shrink text to
fit. Opacity defaults to 100, line style to `SOLID`, stroke width to `THIN`,
start cap to `NONE`, and end cap to `ARROW_LINES`. Omitted colors, section-title
styling, and mark-specific wrapping policies are fixed by the profile.

## 4. Identity, membership, and references

There is one board-wide namespace across pages, sections, groups, marks, and
connectors. IDs are case-sensitive strings, compared exactly, with no implicit
conversion from numbers or display text. Whitespace-only IDs are invalid;
surrounding whitespace is rejected rather than silently trimmed. `"*"` is
reserved and invalid as an ID or reference in this release.

Changing text, a page name, a section name, or geometry does not change identity.
Duplicate display text and display names are allowed; references always use
IDs. Native FigJam node IDs are a separate mapping. Explicit IDs support stable
references and diagnostics; they do not by themselves promise an existing-board
update or upsert capability.

Each placeable object has exactly one structural parent. A group is a layout
boundary, and a section is both a layout boundary and visible membership. A mark
inside a group inside a section remains a member of that section. Empty regions
have profile-defined minimum extents; they do not need placeholder marks.

Connector endpoints resolve only to `sticky`, `shape`, and `textbox` IDs on the
same page, including descendants of any region. Forward references are valid.
Pages, sections, groups, and connectors cannot be endpoints in this release.
There is one connector per declaration: endpoint lists, text fallback, and
wildcards from L0186 are removed. Parallel connectors and self-loops are valid
and retain distinct IDs and labels.

## 5. Layout and order

Every page, section, and group is a layout region. Its placeable children are
its direct marks, sections, and groups. Page-level connectors do not occupy
sequence slots. A child's internal layout is composed with its parent's layout;
the parent places the child's measured extent as one region.

### Layout modes

| Mode | Required meaning |
| --- | --- |
| `AUTO` | Unordered collection. Choose an arrangement using containment and connections; source order is only a deterministic tie-breaker. |
| `ROW` | Preserve the placeable-child sequence from left to right, without wrapping. |
| `COLUMN` | Preserve the placeable-child sequence from top to bottom, without wrapping. |
| `GRID` | Preserve the placeable-child sequence in row-major order using exactly `columns` structural tracks. |
| `FLOW` | Use connections to prefer progression in `direction`; preserve strict `before` constraints. Child declaration order is only a tie-breaker. |

`layout` defaults to `AUTO` independently in each region; layout settings do not
inherit. `FLOW` defaults to `direction RIGHT`. `GRID` requires `columns`; a
fractional, zero, or negative count is invalid. `columns` is legal only with
`GRID`, and `direction` only with `FLOW`. A grid's final row may be incomplete;
an unused cell is not an implicit mark. There are no explicit cell addresses,
spans, or row-height settings.

Row and column sequences are hard order, with profile-defined clearance between
successive child bounds. Grid order fixes track membership; track widths and row
heights grow to accommodate measured children. Reading order and containment
must survive sizing and composition. Pixel alignment, equalizing track widths,
and the sizes of gutters remain compiler policy.

`AUTO` can use connection-aware placement or packing without inventing semantic
order. Reordering declarations in an unordered region may change deterministic
tie-breaking, but does not assert a new dependency or stage sequence.

### Flow direction and strict precedence

`from` and `to` preserve a connector's oriented source/target relationship.
Endpoint caps control decoration and do not reverse, duplicate, or delete that
relationship. `FLOW` uses these relationships as preferred progression, never
as an implicit acyclicity requirement. A return edge, a directed cycle, and a
self-loop are valid. The compiler may draw an edge against the preferred flow.

`before ["b" "c"]` explicitly requires the declaring child to precede siblings
`b` and `c` along its parent's flow direction. Precedence means disjoint ordered
bounds on that axis, separated by the profile's required clearance. It does not
require adjacency, create a connector, or position the child on the cross axis.

`before` is legal only on a direct placeable child of an explicit `FLOW` region.
Every referenced object must be another direct placeable child of that same
region. A section or group can therefore be a flow stage. References into a
descendant, a different parent, or a different page are errors. Duplicate IDs in
one `before` list, self-precedence, and cycles in the strict-precedence graph are
source errors. Redundant transitive requirements are valid.

This keeps two graphs distinct: connections may cycle; strict precedence may
not. `before` in `AUTO`, `ROW`, `COLUMN`, or `GRID` is an error with guidance to
use the existing sequence or choose `FLOW`.

### Connections across regions

An edge between descendants of different groups or sections influences their
common ancestor's arrangement. Within a `FLOW` or `AUTO` region, the compiler
accounts for those edges when arranging the direct child regions that contain
their endpoints. Internal edges also influence the relevant inner layouts.

In a `ROW`, `COLUMN`, or `GRID`, connection-aware layout must preserve the
declared order while allocating room for routing and labels. A connector may
cross a section boundary to reach its endpoint. It must not be treated as an
obstacle collision merely because it passes through the containing section's
boundary. Crossing unrelated marks remains subject to the validation scope.

## 6. Compiler-owned geometry

The authoring vocabulary excludes `x`, `y`, `width`, `height`, `from-side`,
`to-side`, `line-type`, `waypoints`, and `waypoint`. It also excludes numeric
offsets, pinning, rotation, manual ports, gaps, padding, bounding boxes, and raw
positioned-model injection. `line-style` and caps remain presentation; the
compiler chooses the route and attachment geometry.

The numeric values that remain describe structure or presentation: `columns`
and `opacity`. Font and stroke presets are presentation requests that participate
in measurement. None lets an author repair overlap by changing coordinates.

Forbidden or misplaced fields are rejected even when supplied through a record,
a binding, shared-language evaluation, or pipeline input. Neither a native
object record nor an L0186 source string can stand in for a valid L0187 board.
Removed words are absent from the authoring lexicon; parser tooling should add
a specific L0187 placement hint where it can identify an obsolete spelling.
Compiler validation also rejects equivalent fields in evaluated records or ASTs.

Measurement accounts for full text, explicit line breaks, wrapping, font metrics,
shape-specific content areas, borders, section titles, and minimum native sizes.
The compiler may wrap text and grow regions. It preserves chosen font size,
shape kind, and content; it does not truncate, summarize, split one mark into
several marks, or substitute another kind to make the layout pass.

When a native mark's supported sizing rules cannot accommodate its content at
the requested readability, report a content/target limitation with the mark ID.
A repair may suggest an explicit author choice, such as using a textbox or
shortening content. Otherwise-valid content that defeats a layout heuristic is
a compiler layout failure, not a request for positional source edits.

## 7. Examples

### Ordered retrospective with independently arranged sections

```gc
board [
  page [
    section [
      sticky id "shipped" text "Shipped on time" fill "green" {}
      sticky id "pairing" text "Pairing helped us resolve the integration issues" fill "green" {}
    ] id "went-well" name "Went well" layout COLUMN {}
    section [
      sticky id "flaky" text "Flaky tests delayed release verification" fill "pink" {}
    ] id "improve" name "To improve" layout COLUMN {}
    section [
      sticky id "quarantine" text "Quarantine flaky tests and assign owners" fill "blue" {}
    ] id "actions" name "Action items" layout COLUMN {}
  ] id "retro" name "Sprint retrospective" layout ROW {}
] title "Sprint retrospective" layout-profile FIGJAM_V1 {}..
```

The three sections retain their left-to-right order. Notes retain their vertical
order. Longer content changes measurement and spacing without source geometry.

### Invisible composition and a structural grid

```gc
board [
  page [
    textbox id "heading" text "Workshop agenda" font-size LARGE {}
    group [
      section [
        textbox id "goal" text "Agree on the release scope" {}
      ] id "goals" name "Goals" {}
      section [
        sticky id "scope" text "Discuss scope" {}
        sticky id "risk" text "Review risks" {}
        sticky id "owner" text "Assign owners" {}
      ] id "topics" name "Topics" layout GRID columns 2 {}
    ] id "agenda-panels" layout ROW {}
  ] id "agenda" name "Agenda" layout COLUMN {}
] layout-profile FIGJAM_V1 {}..
```

The heading precedes the panel group. The group has no visible frame. The Topics
grid places Scope and Risk on its first row and Owner on its second row.

### Flow with a valid return edge

```gc
board [
  page [
    shape id "fetch" text "Fetch data" kind ROUNDED_RECTANGLE before ["valid"] {}
    shape id "valid" text "Valid?" kind DIAMOND before ["save" "error"] {}
    shape id "save" text "Save result" kind ROUNDED_RECTANGLE {}
    shape id "error" text "Report error" kind ROUNDED_RECTANGLE {}
    connector id "fetch-valid" from "fetch" to "valid" {}
    connector id "valid-save" from "valid" to "save" label "Yes" {}
    connector id "valid-error" from "valid" to "error" label "No" {}
    connector id "retry" from "error" to "fetch" label "Retry" line-style DASHED {}
  ] id "processing" name "Processing" layout FLOW direction RIGHT {}
] layout-profile FIGJAM_V1 {}..
```

Fetch must precede Valid, and Valid must precede both outcomes. Save and Error
have no relative order. Retry preserves a cycle in the connection graph without
adding an Error-before-Fetch requirement.

### Rejected strict order cycle

The following is deliberately invalid source, for a negative conformance case:

```gc
board [
  page [
    shape id "a" text "A" before ["b"] {}
    shape id "b" text "B" before ["a"] {}
  ] id "cycle" name "Invalid order" layout FLOW {}
] layout-profile FIGJAM_V1 {}..
```

The error identifies the strict cycle `a -> b -> a` and the two `before`
properties. Replacing those properties with two connectors would be valid.

## 8. Compilation and acceptance semantics

The Rust compiler has seven responsibilities, independent of backend selection:

1. Evaluate and validate source forms, legal properties, required fields, and
   member types; retain source references.
2. Resolve IDs, the membership tree, connector endpoints, and strict precedence.
3. Build a semantic board without coordinates; select the immutable profile.
4. Measure text and mark extents, then compose regions with connection awareness.
5. Derive supported attachment, connector, and label geometry through bounded
   refinement. Retry and fallback preserve all declared semantics.
6. Validate the final positioned model independently of layout-backend success,
   after transforms, snapping, and rounding.
7. Return an accepted model and its validation report, or a classified failure
   through the existing compiler response contract.

The semantic board and the positioned board are distinct representations.
The former retains layout regions and order requirements. The latter resolves
geometry, preserves semantic IDs and visible membership, and supplies the
model consumed by preview and the target adapter. Invisible groups may be
lowered away while their identity and source mapping remain available to
diagnostics. L0187 needs an explicit positioned schema; the current L0186 model
leaves sizes and positions optional and is not sufficient unchanged.

Required checks under `FIGJAM_V1` cover finite geometry, valid sizes, modeled text
fit, peer nonintersection and minimum clearance, section containment including
title space, declared order, membership, and endpoint preservation. Rectangular
peer clearance means separation by the profile gutter on at least one axis.
Layout bounds, visual bounds, and content bounds have distinct meanings.

Ownership makes child-in-section, text-in-shape, and connector-at-endpoint
intersections intentional. A region's bounding rectangle is not an additional
solid obstacle over its children. Connectors use occupied path geometry when
available, rather than their full bounding rectangles.

The report distinguishes modeled measurements from native observations.
Native text fit and native connector-path/label clearances are optional,
explicitly unverified checks in the initial profile when observation is
unavailable. Modeled mark and container checks and endpoint preservation remain
required. Modeled connector-path and label clearances are required wherever
the compiler emits that geometry; backend-only routes that the adapter cannot
honor must not be presented as native verification. If a connector representation
exposes its actual path or label geometry, validate it and report the scope.
An unavailable required check blocks acceptance; no unperformed check is
reported as passed.

Preview uses the compiler's positioned marks and modeled connector geometry;
it does not run its own layout. The adapter consumes the same mark geometry and
attachment requests. A native route that the adapter cannot control or observe
may differ from the modeled preview route, and the report must expose that
limit. The initial guarantee covers the generated diagram; clearance from
existing destination content requires observed obstacles or an established
empty insertion region.

Among valid candidates, prefer consistent spacing, aligned peers, stronger
separation between groups, readable paths and labels, fewer crossings, reasonable
proportions, and limited movement after edits. These are quality objectives.
They do not justify changing content, breaking order, or reporting failed hard
checks as a low quality score. A failed heuristic is not proof of infeasibility.

## 9. Profiles, determinism, and cache identity

`layout-profile FIGJAM_V1` selects an immutable bundle covering measurement and
font assets, wrapping and sizing policy, spacing, layout selection and backend
versions, deterministic tie-breaking, numeric rounding, target assumptions,
required checks, and bounded refinement policy. The implementation plan must
assign concrete values and pinned dependencies to this bundle before release.

Omitting the property permanently means `FIGJAM_V1`; it never means latest.
Effective inputs and profile determine positioned geometry deterministically.
Native observations are separate evidence and must not silently mutate the
pure compile result. Revision-stability support initially uses deterministic
IDs and tie-breaking, with no hidden editor state or previous-layout input.
Candidate selection and fallback use deterministic work limits; an external
wall-clock timeout may fail compilation but must not select a different accepted
layout depending on machine load.

A geometry-affecting change requires a new profile tag selected in source,
changing the AST and therefore the platform's `{lang, code}` task identity.
Do not overwrite a released profile to upgrade a backend or repair geometry.
The positioned result records its profile, font/measurement revision, backend,
and compiler revision. Metadata alone is not cache invalidation; deployment
must preserve old profile behavior and reconcile existing result caches if a
previously served profile violated this contract.

## 10. Destination and execution boundary

Retain the current L0186 meaning of `save-to-figjam`: destination metadata for
the existing FigJam integration, not a new compiler-side board write. It takes
one supplied file key or supported Figma file link, appears at most once before
the board, and is never a property or child member. Without it, output is a
preview. It does not authorize reading or clearing existing content.

Only an accepted positioned model is eligible for the existing authorized
materialization path. Compilation does not introduce an execute/commit word or
an additional approval phase. Any future effectful compiler integration remains
subject to the established preflight, authorization, idempotency, and recovery
contract. Verification requiring native writes cannot be represented as local,
write-free validation; partial effects must remain visible if it fails.

## 11. Diagnostics and author repair

Diagnostics carry affected IDs, source locations or property paths, the violated
rule, observed values where relevant, and a repair expressible in L0187. They
separate source errors, content/target limitations, measurement failures, layout
failures, resource limits, and unavailable native verification.

Examples of the required feedback:

- Missing ID: identify the member and show `sticky id "idea" text "Idea" {}`.
- Misplaced `columns`: name the legal settings and show
  `group [ ... ] id "cards" layout GRID columns 3 {}`.
- Cross-page endpoint: name the connector and both pages; request same-page
  content or a source revision instead of moving a node silently.
- Strict cycle: show its IDs and offending `before` properties; explain that
  connectors can represent a return path without strict precedence.
- Removed geometry: explain that L0187 computes placement and show an applicable
  structural layout form; never suggest a replacement coordinate.
- Layout failure on valid source: report the failed requirement and bounded
  attempts as a compiler failure. Do not repeatedly ask the generator to rewrite
  valid text or organization to repair compiler-owned overlap.

Unknown properties must never disappear into open records. Validate each member
and its properties before proceeding to the next member, so a misplaced word
receives the useful error instead of a downstream stray-`{}` error. Missing
chain terminators remain parser errors; authoring instructions must teach them
prominently. Diagnostics state the legal set and the likely correct location.

## 12. Handoff to implementation planning

The design fixes the language boundary, source forms, initial vocabulary,
legal locations, IDs, layout semantics, strict order, and initial validation
scope. The implementation plan should choose mechanisms and quantify policy:

- Define Rust-owned vocabulary metadata for properties, members, containers,
  tags, allowed locations, conditional rules, and source spelling. Generate
  lexicon and evaluation handlers from it, retaining complete value validation
  during evaluation rather than relying on a checker that may skip list members.
- Specify the semantic IR, positioned schema, source map, validation report,
  and versioned adapter boundary. Share positioned-model utilities with L0186
  only through an explicit compatibility contract.
- Quantify `FIGJAM_V1` sizing, title space, clearances, font assets, resource
  budgets, and rounding. Select and pin text measurement and graph placement
  dependencies; engine selection does not change the language's meaning.
- Confirm the initial native shape sizing and section/connector representations,
  and calibrate modeled measurements to the target. Preserve the stated optional
  native checks unless a stronger profile can establish them.
- Publish canonical `spec.md`, `instructions.md`, `usage-guide.md`, starter
  template, schema, language metadata, and natural-language example prompts.
  Generate served assets through the existing pipeline and rebuild the L0187
  retrieval corpus without copying L0186's positional examples or old vectors.
  Scope metadata must distinguish declarative boards from positional L0186 and
  from the sibling assessment, chart, and spreadsheet languages.
- Turn positive programs in this design into compilation and schema tests;
  retain the strict-cycle example as an explicitly negative case. Keep documented
  words, signatures, tags, and legality tables equal to generated vocabulary.

Acceptance must include mixed-length retro notes, the nested group/grid example,
branch labels and a return edge, self-loops and parallel connectors, a rejected
strict cycle, cross-section connections that affect outer placement, empty
templates, multiple ordered pages, text edits requiring remeasurement, duplicate
IDs, cross-page references, forbidden fields arriving through evaluated records,
and a backend candidate rejected by independent geometry validation. Check
repeatability with identical effective inputs and the same immutable profile.
Use geometric assertions for hard guarantees and rendered examples to assess
readability and target fidelity.

No backend, deployment, or compiler implementation is selected by this design.
Those decisions can now be planned against an explicit language contract.
