# Declarative FigJam Diagram Language

- **Status:** Proposed language description
- **Date:** 2026-10-30
- **Language identifier:** Unassigned
- **Compiler implementation:** Rust
- **Initial output target:** FigJam-compatible board model

## 1. Purpose

This language lets an agent describe a diagram's content and organization while
the compiler computes its drawing. Programs declare marks, text, connections,
groups, order, and layout intent. The compiler measures the marks, determines
their sizes and positions, validates the resulting geometry, and produces a
positioned board model.

The motivating failures are overlapping marks and poor spacing between marks
in generated FigJam boards. The language must also account for text fit and
container boundaries. It makes geometry a compiler responsibility so the code
generator does not have to estimate coordinates or repair them through repeated
guesses.

The central contract is:

> The program determines the diagram's content and semantic organization. The
> Rust compiler determines its geometry and checks that geometry before
> reporting a successful layout.

A successful layout preserves the declared content and relationships and
satisfies the required geometric checks within an explicitly reported
measurement and rendering scope.

## 2. Relationship to L0186

This is a new dialect, distinct from the existing positional L0186 dialect.
Changing who determines positions changes the language's semantics; it is more
than replacing a layout library or removing a few generator instructions.

L0186 can continue to express explicit placement. Its positioning functions
retain their documented meanings, and a geometry validator can diagnose
problems in the resulting drawing.

The new dialect does not expose raw coordinate placement. Its compiler computes
positions as a consequence of content, structure, and layout intent. It never
needs to decide whether a generated coordinate is an instruction or a hint.

The two dialects can share a positioned board model, geometry validator, preview
implementation, and FigJam adapter. Their paths to that model differ:

- L0186 resolves its positioning expressions.
- The new dialect measures content and performs automatic layout.

The new compiler can lower directly to the shared board model. Generating
L0186 source as an intermediate representation is optional and is not required
by this design.

Existing saved L0186 programs remain associated with their existing language
semantics. The new dialect must be selected explicitly. Its language ID and
published name are separate decisions; this document assigns neither.

## 3. Intended use

Initial applications include:

- Retrospective, brainstorming, and kanban boards with grouped notes.
- Agendas and workshop boards organized into sections or pages.
- Process and decision flowcharts, including return paths and loops.
- Small system and dependency diagrams with labeled nodes and connections.
- Comparisons organized into rows, columns, or grids.

These applications share a useful property: their organization can be described
without specifying the exact coordinates of every mark.

The initial language does not offer arbitrary freehand drawing, raw coordinate
editing, manual connector routes, or an escape hatch into positional L0186
source. Reading and rearranging an existing FigJam board is a separate
capability and is not assumed by this description.

## 4. Language concepts and authoring boundary

The dialect uses Graffiticode's shared syntax with a distinct lexicon. Concrete
function names and arities are to be specified during implementation. The
concepts below define the intended semantics, not a finalized grammar.

### Board and page

A board contains one or more named pages. Each page has its own arrangement of
marks and sections. Page order is explicit. Connectors remain within one page
in the initial language; references to endpoints on different pages are
diagnosed.

### Mark

A mark has a stable semantic ID, a kind, content, and supported presentation
attributes. Initial kinds cover text, notes, and text-bearing diagram shapes.
A decision can be represented as a semantic role with an appropriate shape.

Mark IDs identify content across connections, diagnostics, and revisions. They
are independent of generated coordinates and native FigJam node IDs. Semantic
IDs use one board-wide namespace across pages, sections, marks, and connections.
Duplicate IDs and unresolved references are source errors.

The compiler derives dimensions from content, presentation attributes, and the
native mark's sizing rules. It must not delete text, truncate it, or silently
reduce it below the configured readability threshold to satisfy layout.

### Section and membership

A section groups related marks or other supported sections. Membership carries
meaning and must survive layout. A section's title, content region, padding,
and outer extent participate in measurement.

Sections normally grow to accommodate their contents. The compiler may move a
whole section while preserving its membership and internal relationships.
Connections between sections must also influence the outer arrangement; laying
out every section independently is insufficient for a board with many such
connections.

### Connection

A connection identifies its source and target marks and may include a label,
direction, and supported presentation attributes. The compiler preserves
endpoints, direction, and label content.

Connection direction is not an implicit strict ordering constraint. A
flowchart loop such as A to B to A is valid content. A layout may represent a
return edge against the main flow direction without changing the graph.

### Order

Explicit sequences, stage order, and column order are semantic requirements.
The compiler preserves them.

An unordered collection does not acquire semantic order merely because its
members appear in a particular source sequence. Source order or stable IDs may
be used as deterministic layout tie-breakers.

An explicit strict order that contradicts itself is a source error. This is
different from a cycle in the connection graph.

### Layout intent

A small structural vocabulary supplies the information needed to choose an
arrangement:

- Row: arrange members along a horizontal sequence.
- Column: arrange members along a vertical sequence.
- Grid: arrange members in a declared structural grid.
- Flow: emphasize the direction of connections.
- Direction: specify the preferred reading direction of a flow.

Board and section kinds may provide these defaults without an explicit layout
declaration. For example, a kanban board implies ordered columns.

Layout intent can be nested: an outer row of sections can contain columns of
notes and a section containing a flowchart. A flow direction guides placement;
it does not require every edge in a cyclic graph to point that way.

### Excluded geometry

The initial authoring vocabulary excludes:

- Absolute x/y coordinates and numeric translation offsets.
- Preferred coordinates, fixed positions, and pinning.
- Manually specified connector bend points.
- Arbitrary numeric gaps and padding used to arrange marks.
- Arbitrary width and height overrides used to make content fit.
- Raw positioned-model injection or positional-source passthrough.

These values belong to compiler policy and compiled output. A grid's column
count or an ordered sequence remains a structural declaration rather than a
coordinate.

If precise user-controlled geometry becomes necessary, it should be designed
as a separate extension or handled by the positional dialect. It is not an
implicit exception to this language's initial contract.

The effective published lexicon, generator examples, and compiler validation
must agree on this boundary. Unsupported placement forms produce a clear
diagnostic rather than being silently ignored.

## 5. Semantic examples

The following examples describe the language's meaning. They are not executable
programs in L0186 or finalized syntax for the new dialect.

### Retrospective

Describe a page with three ordered sections: Went well, To improve, and Action
items. Each section contains a sequence of notes.

The compiler measures the notes, stacks each sequence, sizes each section,
aligns the sections, and supplies consistent internal and external spacing.
Adding a longer note causes the necessary geometry to be recomputed without
adding positioning expressions to the source.

### Decision flow

Describe Fetch data, a Valid? decision, Save result, and Report error. Connect
Fetch data to Valid?, then connect the decision to Save result with a Yes label
and to Report error with a No label. Request a left-to-right flow.

The compiler selects sizes and positions that preserve the graph and branch
labels. It reserves space for labels and chooses connector behavior supported
by the FigJam adapter.

A possible normalized semantic representation is:

```json
{
  "id": "processing",
  "layout": { "kind": "flow", "direction": "right" },
  "marks": [
    { "id": "fetch", "kind": "process", "text": "Fetch data" },
    { "id": "valid", "kind": "decision", "text": "Valid?" },
    { "id": "save", "kind": "process", "text": "Save result" },
    { "id": "error", "kind": "process", "text": "Report error" }
  ],
  "connections": [
    { "id": "f-v", "from": "fetch", "to": "valid" },
    { "id": "v-s", "from": "valid", "to": "save", "label": "Yes" },
    { "id": "v-e", "from": "valid", "to": "error", "label": "No" }
  ]
}
```

This JSON illustrates an internal semantic model. It does not prescribe JSON
as the source language or establish a public wire schema.

### Revisions

If a label changes or another note is added, the compiler recomputes the
necessary geometry while retaining stable semantic IDs. Limited movement of
unaffected marks is a quality objective, not permission to violate required
spacing or ordering.

Any previous layout used to improve stability must be an explicit compilation
input or a deterministically available artifact under the platform's compilation
contract. Hidden editor state must not change the meaning of identical input.

## 6. Geometry contract

### Measurement

Each supported mark has a measurement implementation that accounts for its
content, font configuration, wrapping, padding, shape, and native sizing rules.
The implementation distinguishes:

- Layout bounds: the space allocated while arranging marks.
- Visual bounds: the extent of the visible mark, including relevant decoration.
- Content bounds: the usable region for text or children.

The compiler uses an explicit, versioned font and measurement profile rather
than uncontrolled server font defaults. Measurements record whether they are
modeled or based on available native observations.

Text width, wrapping, height, and container size can depend on one another.
Measurement and layout therefore use a bounded refinement process. Failure to
stabilize is reported as a measurement or layout failure.

### Required checks

Before accepting a layout, the compiler checks:

- Finite, valid sizes and positions in a common coordinate system.
- No forbidden intersection between unrelated peer marks.
- Minimum clearances defined by the layout profile.
- Text fit within the applicable measured content region.
- Child containment within the section's content region.
- Preservation of declared membership, order, and connection endpoints.
- Connector and connector-label clearance where the required route geometry
  is available.

Validation applies to final coordinates after transforms, snapping, and
rounding. It is independent of whether the layout backend returned successfully.

Required clearances use a documented geometric rule. For rectangular peers, an
initial implementation may require separation by the configured gutter on at
least one axis. This is a deliberate rectangular-clearance policy, not a claim
about exact Euclidean distance between arbitrary shapes.

### Intentional intersections

Ownership and attachment determine which intersections are meaningful: text
inside its shape, children inside a section, and a connector meeting its own
endpoint are normal. Such relationships are represented explicitly rather than
suppressed through a general allow-overlap switch.

A connector's full bounding rectangle is not its occupied path. Collision
checks use its segments or curves, stroke, and labels when available.
Conservative bounds for irregular or rotated marks must be identified as such;
they can produce false positives.

### Quality objectives

Among acceptable layouts, the compiler should prefer consistent spacing,
aligned peers, stronger separation between groups than within groups, readable
connector paths, fewer crossings, reasonable board proportions, and stability
across revisions.

Hard validity and visual quality are separate results. A scalar quality score
must not conceal a required constraint violation. Crossing-free output is not
required for every connection graph.

## 7. Compilation in Rust

The compilation pipeline has the following responsibilities:

1. Analyze source and resolve semantic IDs, membership, connections, and order.
2. Build a semantic board representation retaining source references.
3. Measure marks and labels using the rendering profile.
4. Select and run layout algorithms appropriate to each region.
5. Compose regions and resolve connector and label geometry supported by the
   target adapter.
6. Independently validate the final positioned model.
7. Return the accepted board model and diagnostics, or a classified failure.

Measurement, composition, geometry validation, and diagnostics live in Rust.
The new implementation does not depend on the TypeScript compiler.

The layout backend is replaceable behind a Rust interface. Rows, columns, and
grids can be implemented directly. A graph-layout backend supplies candidate
positions for connected diagrams; its output is subject to the same validator.
The compiler owns its time budget, retry policy, and deterministic fallback
strategies. No fallback may change the declared content or relationships.

The output includes resolved positions and dimensions, even though the source
does not. Preview and FigJam rendering consume that positioned model instead of
independently choosing unrelated layouts.

### Execution boundary

This proposal preserves Graffiticode's compilation boundary for external side
effects. Analysis, measurement, layout, and applicable preflight validation
precede any authorized effectful compiler work. Candidates rejected during
preflight must not trigger the intended external write.

The description does not introduce a separate post-compilation execute or
commit phase. Preview-only requests remain free of destination-board writes.

Verification against newly materialized native objects may itself require
renderer interaction. It must use the established authorized execution path
and must not be represented as a purely local, write-free preflight guarantee.
If native verification fails after an authorized write, report the effects
already performed and use the established recovery and idempotency handling.
Do not describe such an operation as write-free.

### Reproducibility and caching

Record the compiler semantics, measurement/font profile, layout profile, and
backend version used to produce geometry. Control any randomness and resolve
equivalent choices deterministically.

Changes to those inputs must follow the platform's existing language identity,
versioning, and cache contract. Adding version metadata to an output is not
enough if the same cached task identity can otherwise return a different model.
The implementation must choose an explicit strategy before deployment.

## 8. Diagnostics and repair responsibility

Diagnostics identify the affected semantic IDs, source locations or properties,
measured values, violated requirement, and any repair that is expressible in
the dialect. The precise serialization follows the compiler response contract;
this document does not introduce a new endpoint or response envelope.

### Source problems

Examples include duplicate IDs, missing endpoints, unsupported source forms,
cross-page connections, and contradictory explicit ordering requirements.
The generator can revise the corresponding source.

If content cannot be represented under the supported native mark and
readability rules, feedback may suggest a different mark kind or an explicit
content revision. The compiler must not silently shorten content.

### Layout failures

If otherwise supported source produces overlapping automatically positioned
marks, that is a failure of the compiler's layout process. A coordinate
adjustment is not a useful generator repair because coordinates are not
authorable in this dialect.

The compiler may retry with an allowed strategy or report that no acceptable
layout was found within the budget. Search failure is distinct from a proven
constraint conflict. The compiler must not describe a failed heuristic as proof
that no valid layout exists.

### Measurement and rendering limitations

Missing font information, unsupported native sizing behavior, or unavailable
connector-path geometry receive their own diagnostics. They must not be
misclassified as bad source syntax.

The result records the validation scope and any checks that remain unverified.
An unperformed check is not reported as a passed check.
The validation profile declares which checks are required and which are
optional. An unavailable required check prevents acceptance; an unavailable
optional check is reported as unverified.

### Severity and feedback

Errors prevent an accepted result when source validity or required geometry
cannot be established under the declared profile. Warnings describe supported
but unresolved quality or rendering limitations. Ordinary automatic placement
does not require a warning simply because the compiler chose coordinates.

The specialized generator receives actionable source diagnostics. The client
agent receives a concise explanation and the same underlying structured
report, particularly when content or organization needs a decision.

Prefer the underlying cause over a cascade of symptoms. For example, one
unsupported size restriction should not be presented as dozens of unrelated
pairwise overlaps. Retry loops are bounded and do not repeatedly rewrite valid
content in response to compiler-owned positioning failures.

## 9. FigJam adapter and validation scope

The native adapter must respect mark-specific capabilities. The reviewed Figma
API distinguishes resizable shapes from more restricted sticky-note sizing;
text sublayers do not expose all standalone text-node sizing operations.
Ordinary bounding boxes exclude some rendered extents, and geometry properties
vary by node type. Native connectors expose endpoints and line styles, but no
arbitrary list of routing bend points. See the
[official Figma Plugin API definitions][figma-api].

Consequently, a route calculated by a graph-layout backend cannot automatically
be assumed to be the route drawn by a native connector. The adapter must choose
a supported representation and identify the checks possible for that
representation. A custom path representation would need an explicit product
decision about editability and attachment behavior.

Validation distinguishes the generated model, available native mark geometry,
and any unverified native text or connector behavior. It does not claim exact
native rendering from estimates alone.

For insertion into a populated board, the adapter needs observed existing
obstacles or an independently established empty insertion region to verify
clearance from existing content. Without that information, the guarantee is
limited to the generated diagram. The initial language does not assume an
existing-board reader.

## 10. Rust implementation direction

The engine choice is an implementation decision rather than part of the
language's meaning. Evaluate candidates against representative L0186 failures
and the new dialect's required structures.

- Native Rust composition and validation are the initial foundation.
- [rust-sugiyama][rust-sugiyama] is a placement candidate whose documented API
  accepts sized vertices and directed edges. Richer grouping, labels, routing,
  and validation remain responsibilities to evaluate or supply around it.
- [layout-rs][layout-rs] offers explicitly sized graph nodes and labeled edges;
  its documented lack of nested graphs is relevant to section support.
- [Graphviz][graphviz-dot] is an alternative native dependency callable from
  Rust. It is not a pure Rust backend. If selected, normalize its units and
  coordinate conventions and consume an output format containing calculated
  geometry, such as [JSON or JSON0][graphviz-json]. Its
  [orthogonal routing limitations][graphviz-splines] also require evaluation.
- [COSMIC Text][cosmic-text] is a candidate for Rust text shaping and multiline
  layout. Its measurements still need calibration to the FigJam profile.

No candidate is assumed to provide complete native FigJam fidelity or all
desired group and connector behavior.

## 11. Initial delivery and acceptance

The first implementation should establish:

1. A distinct lexicon and explicit selection of the new dialect.
2. Stable semantic IDs, sections, membership, connections, and declared order.
3. Content-driven measurement and a versioned spacing/readability profile.
4. Native row, column, and grid composition plus a selected flow-layout path.
5. A shared positioned model and independent geometry validator.
6. Classified diagnostics and a reported validation scope.
7. Preservation of existing L0186 semantics and saved programs.

Acceptance examples should include:

- A three-column retrospective whose notes have different text lengths.
- A branching flowchart with labeled branches.
- A valid flowchart loop and a separately invalid strict ordering cycle.
- Sections with connections crossing their boundaries.
- A text edit that changes wrapping and requires recomputed spacing.
- Intentional containment that must not be flagged as an overlap.
- Duplicate IDs, missing endpoints, and rejected positioning expressions.
- A modeled layout that passes node checks while reporting unavailable native
  connector checks.
- A compiler-generated candidate that fails validation and is not emitted as
  an accepted board.
- Repeated compilation with the same effective inputs and profiles producing
  the same positioned model.

Use geometric assertions for the properties the compiler promises and rendered
examples for readability and adapter fidelity. This document specifies those
acceptance cases; it does not claim they have been implemented or run.

## 12. Decisions remaining

Before implementation is finalized, choose:

- The language identifier and published name.
- Concrete lexicon entries, arities, and examples in shared Graffiticode syntax.
- The initial mark kinds and section-nesting behavior.
- Layout defaults, readability thresholds, and supported fonts.
- The Rust graph-layout backend and whether a native executable dependency is
  acceptable for the deployment target.
- The initial connector representation and its verifiable geometry.
- The versioning/cache strategy for changes to layout and measurement behavior.

These decisions refine the implementation. The established language boundary is
that the generator authors content and semantic structure, and the Rust
compiler owns geometry.

## References

- [Graffiticode language and task model](../README.md)
- [Figma Plugin API definitions][figma-api]
- [rust-sugiyama crate documentation][rust-sugiyama]
- [layout-rs crate documentation][layout-rs]
- [Graphviz directed graph layout][graphviz-dot]
- [Graphviz JSON output][graphviz-json]
- [Graphviz connector-routing options][graphviz-splines]
- [COSMIC Text][cosmic-text]

[figma-api]: https://github.com/figma/plugin-typings/blob/d0af2ef5fbb1f9ee9c7fe20641e06f14a34e5105/plugin-api.d.ts
[rust-sugiyama]: https://docs.rs/rust-sugiyama/latest/rust_sugiyama/
[layout-rs]: https://docs.rs/layout-rs/latest/layout/
[graphviz-dot]: https://graphviz.org/docs/layouts/dot/
[graphviz-json]: https://graphviz.org/docs/outputs/json/
[graphviz-splines]: https://graphviz.org/docs/attrs/splines/
[cosmic-text]: https://github.com/pop-os/cosmic-text
