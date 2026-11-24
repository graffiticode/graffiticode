# TypeScript reference compilers for differential testing

Status: proposal. Rust remains the production compiler; retained TypeScript mirrors serve only development and testing. This note proposes policy, not implementation or deployment changes.

## Rationale and scope

An independent implementation can expose semantic regressions that unit tests and frozen snapshots miss. TypeScript and Rust differ in coercion, numbers, missing values, iteration and error handling, making their disagreements useful evidence. Agents reduce the cost of maintaining both, but review, dependencies and CI still cost time.

Keep a small, readable TypeScript compiler core for each participating language, without maintaining a second production service. This does not retire shared TypeScript views or tooling. Existing conformance generators, such as [L0000's](../languages/l0000/crates/core/tests/conformance/generate.mjs), already record TypeScript results for Rust tests. Some dialects, including [L0184](../languages/l0184/crates/core/tests/conformance/PROVENANCE.md), instead retain frozen fixtures after removing TypeScript. Start with existing mirrors; restoring removed compilers requires a separate decision. Historical service pins remain outside this proposal.

## Authority and conformance

The versioned language specification and reviewed conformance suite define correctness. Neither compiler is the oracle, and agreement alone does not prove correctness. Resolve ambiguities in the specification before changing either implementation.

Each semantic change includes a specification update where needed, independently justified expected results, and valid, invalid and boundary cases. Keep historical fixture provenance. Compiler-generated snapshots are evidence to review, never automatically accepted truth; do not regenerate expectations merely to make a failure pass. A mismatch becomes a minimized regression case and a fix to whichever implementation violates the contract, possibly both.

## Comparison contract

Run both compilers on identical programs, upstream data, schemas and configuration. Compare canonical semantic models, including defaults, references and contractually observable diagnostics. Normalize only explicitly unordered object keys and declared nonsemantic metadata; preserve array order, types, tags, missing/null/undefined distinctions and numeric semantics. Any numeric tolerance must come from the specification.

For interpreter languages, compare evaluated models with direct compilation using identical input, and compare model structure wherever it is contractual. Check dynamic metadata separately. Retain exact serialization, digest, signature and protocol assertions where bytes matter; semantic comparison supplements existing byte-level conformance tests. Timeouts, crashes and unexpected errors fail independently, even when both implementations fail alike.

## Deterministic, side-effect-free execution

Prefer in-process compiler cores with no credentials or live network. Inject fixed clocks, seeded randomness, deterministic IDs and fixture-backed schema, fetch, storage and broker adapters. Record and compare intended operations without executing writes. Keep live integration tests separate.

Use specification examples, reviewed regressions, edge cases, seeded property-based generation and metamorphic properties. Save seeds, inputs, revisions and model diffs; minimize failures for replay. Shared ASTs isolate evaluator differences but leave parser bugs shared, so retain source-to-model and parser conformance checks too.

## Agent-assisted maintenance and independence

Implement each language change from the same specification and acceptance cases in both cores. Agents may maintain vocabulary, adapters and tests, but must not mechanically translate one evaluator into the other or copy its outputs into expectations. Share declarative contracts and test inputs, not semantic evaluation code. Review reasoning and expected outcomes independently; a separate agent run alone does not establish independence. Keep TypeScript simple rather than matching Rust's optimizations or internal architecture.

## Proposed CI policy

- Required on relevant pull requests: both cores' unit/conformance suites, reviewed fixtures and a bounded deterministic differential corpus. Base-kernel changes cover all participating dialects; dialect changes cover that dialect and affected dependencies. Add explicit language jobs because languages have separate builds outside the root workspaces.
- Run a larger seeded corpus nightly; retain reproducible failure artifacts and add minimized cases to the required suite. Nightly failures require triage before releasing affected semantics.
- Fail on unexplained mismatches, unexpected skips or stale mirrors. Intentional divergences require a narrow case/path allowlist with specification rationale, owner and review/removal condition. Never blanket-ignore fields or refresh snapshots automatically.

## Risks, pilot and success criteria

Risks include correlated agent mistakes, shared-parser blind spots, over-normalization, stale references and dependency/CI overhead. Independent expected results, preserved byte checks, bounded corpora and measured review effort mitigate these; Rust integration and production checks remain necessary.

Pilot L0000 and L0003's pure compiler paths for two weeks. Record mismatch classifications, seeded defects detected, CI duration, flaky runs and human review time. Proposed acceptance targets: zero unexplained mismatches or flaky runs; detect at least one deliberately seeded semantic defect in each implementation; added warm CI time below five minutes; and human maintenance below 30 minutes per language per week. Expand only if the evidence meets these targets. Otherwise narrow or retire the mirrors while preserving reviewed conformance cases and provenance.
