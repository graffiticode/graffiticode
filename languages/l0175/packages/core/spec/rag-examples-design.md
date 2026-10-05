<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0175 RAG anchor set — design

_Status: DESIGN (authoring of the golden pairs is a follow-up). Revised 2026-06-30._

## Why this exists

The reported failure: asked for **c1-t9, Task Model 3 (two-part EBSR)**, the generator drifts to
TM4 (hot-text) / TM5 (short-text). The instruction-side fixes (the served collision warning, the
generated per-target task-model table, and the compiler's `task-model` guard) make the rule
explicit and enforceable. RAG adds the third leg: a **positive worked example** of the exact shape
the request wants, so retrieval biases generation toward it instead of toward the more salient
T4/T11 numbering.

The drift is between **siblings within one target** (t9 EBSR vs hot-text vs short-text). An abstract
per-target renumbering rule is exactly what an LLM under-weights; a retrieved exemplar of
"c1-t9, TM3, two-part EBSR" is the strongest available anchor. The embedding infra already supports
this — `src/embedding.ts` emits `target:c1-t9`, `item:ebsr`, `shape:two-part`, and now
`task-model:3`; `extractQueryFacets` pulls target + item type + an explicit/derived task-model
number from the query. The corpus just lacks positive output-side exemplars.

## What the set should be

1. **Paired golden examples (prompt → canonical L0175 program), not prompt-only.** `examples.md` is
   prompt-only; disambiguating siblings needs the *output* shape. Store paired examples the console
   RAG can index via `buildEmbeddingArtifacts({ prompt, code })` — e.g. a `spec/examples/` directory
   of `<id>.gc` programs each with a sibling `<id>.prompt.md`, or an L0175 `training_examples.json`
   array of `{ prompt, code }`.

2. **Contrastive siblings — same passage, vary only the task model — for every target** (parity, not
   t9-only). Holding the passage + dimension fixed and changing only the task model makes the
   vectors/facets separate cleanly on item type / shape, so retrieval discriminates instead of
   blurring:

   | Target | Task models to anchor (item type) |
   |--------|-----------------------------------|
   | `c1-t9` (validate first — the observed failure) | tm3 ebsr · tm4 hot-text · tm5 short-text · tm1 multiple-choice · tm2 multi-select |
   | `c1-t1`, `c1-t8`, `c1-t10` | tm1 multiple-choice · tm2 multi-select · tm3 hot-text |
   | `c1-t4`, `c1-t11` | tm1 ebsr · tm2 hot-text · tm3 short-text |

   Every target × task-model cell gets ≥1 anchor. No target ships without anchors. (Source of truth
   for which cells exist: `spec/targets.json` → `targets.<id>.taskModels`.)

3. **Tagged with the design signature `embedding.ts` emits** — `target:<t>`, `item:<type>`,
   `shape:two-part|single-part`, `dimension:<d>`, `standard:<s>`, `dok:<d>`, and **`task-model:<n>`**
   (derived from target + item type via `targets.json`). The console filters/boosts on these facets;
   `target:c1-t9` + `task-model:3` together select the EBSR exemplar over its siblings.

4. **Each prompt phrased both ways** — by number ("task model 3", "TM3") **and** by item type
   ("two-part EBSR") — so the query embedding and `extractQueryFacets` match however the client
   phrases it. `extractQueryFacets` already extracts an explicit number and derives one from
   target + item type; the paired prompts should exercise both spellings.

## The store and the verification gate (implemented)

The paired store and the gate now exist:

- **Store:** `spec/examples/<id>.gc` (the program, authored with `task-model tmN`) + `<id>.expect.json`
  (`{ prompt, expect: { target, taskModel/itemType, dimension, standard } }`). First anchor in:
  `c1-t9-tm3-ebsr` (the exact drift case). This is the human-refined artifact — author/edit the `.gc`.
- **Gate:** `verifyExample({ errors, data, code, expect })` (exported from `@graffiticode/l0175`) —
  BLOCKING checks (compiles clean; composed `target`/item type/`task-model:<n>`/dimension/standard
  match the declared intent, read from `targets.ts` NOT `instructions.md`) + ADVISORY (compiler
  warnings surfaced, not fatal). It never maps prompt→code; it validates whatever code exists, so it
  guards **both** bootstrapped and hand-refined examples. Run it in the console capture step and after
  any refinement.
- **Corpus check:** `test/corpus.spec.ts` runs the gate over every `spec/examples/*.gc` on each test
  run; `test/verify-example.spec.ts` proves the gate rejects a mislabeled example that compiles clean.

**Coverage: 17 of 17 matrix cells — the full matrix.** Every `targets.<id>.taskModels` cell has a
gated golden pair (all advisory-free): the c1-t4 / c1-t11 R&E trios, the c1-t1 / c1-t8 / c1-t10 trios, the c1-t2 five, and
the complete c1-t9 five-item set (tm1 MC, tm2 multi-select, tm3 ebsr, tm4 hot-text, tm5 short-text).
Each is a contrastive sibling set (same passage per target, varying only the task model). Any new or
edited anchor is re-validated by the gate (`test/corpus.spec.ts`).
