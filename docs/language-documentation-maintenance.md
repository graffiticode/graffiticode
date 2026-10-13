# Language documentation maintenance checklist

## Review summary

Reviewed all **15 languages under `languages/`**, comparing READMEs, specs, authoring guides, metadata, generated assets, and relevant implementation/tests.

Eight documentation test suites passed: **172 tests passed, one optional URL check skipped**. Passing tests do not catch all prose contradictions. Generated-asset findings below refer to local files; deployed versions were not checked.

## Priority 1 — Correct misleading documentation

- [ ] **L0180 — assessments:** Expand the README beyond choice questions to cover all implemented interactions, multipart items, and activities. Fix the usage guide’s contradictory claims that ordering, matching, classification, dropdowns, numeric matching, and multi-question navigation are unsupported. Correct “options keep their authored order” to match the implemented shuffle default.
- [ ] **L0010 — composition planner:** Update the README, spec, instructions, examples, and metadata to use current providers: L0176 for Learnosity items, L0179 for spreadsheets, L0181 for flashcards, L0183 for concept webs, and L0184 for charts. Distinguish general assessments through L0180 from Learnosity requests. Only show composition examples supported by the consuming language.
- [ ] **L0013 — snapshots:** Replace the greeting-language README and `spec/docs.md` with snapshot documentation covering `snap`, item resolution, cropping, sizing, returned `{url, item}`, authentication, browser requirements, and storage configuration.
- [ ] **L0174 — forms:** Replace the greeting-language README with the actual forms vocabulary and submission/configuration contract. Update the usage guide’s spreadsheet and chart referrals to L0179 and L0184.
- [ ] **L0179 — spreadsheets:** Add the missing README covering sheets, formulas, assessment, parameters, development, and Learnosity integration. Correct `CLAUDE.md`, which still labels removal of the L0166 dependency as open although the migration document says DONE and the renderer is in-tree.
- [ ] **L0176 — Learnosity items:** Remove the blanket “byte-compatible port” claim from the README and developer guidance; the audit records intentional vocabulary and output changes. Replace the obsolete `npm run gcp:build` command in the rendering setup guide with the repository deployment command.

## Priority 2 — Complete references and refresh generated docs

- [ ] **L0000 — base language:** Reconcile the spec’s claim that consumers inline schemas at write time with the implemented compile-time `use` schema fetch. Document the exported protected-operation/`ExecContext` extension contract in developer documentation. Refresh outdated dialect examples and regenerate assets missing `format-number`.
- [ ] **L0003 — starter UI:** Update `spec/docs.md`’s obsolete vocabulary, including `val` and old `concat`/`data` signatures. Correct the “base dialect” description and outdated assessment/spreadsheet referrals.
- [ ] **L0014 — TransLaTeX:** Document implemented options missing from the reference: `parsing-integral-expr`, `rhs`, `no-parens`, and `end-root`. Add installation, build, test, and usage instructions to the short README.
- [ ] **L0177 — Author API recipes:** Repair the core-spec link. Retain the distinction between modeled configuration and empirically verified behavior; use the existing vocabulary and recipe tests to validate documented coverage counts.
- [ ] **L0178 — Data API recipes:** Repair the core-spec link. Cross-check operation counts across the README, reference, coverage ledger, and metadata against the vocabulary; preserve dated evidence and documented-only limitations.
- [ ] **L0181 — flashcards:** Repair the core-spec link and document the existing compatibility boundary: L0159 stored items and its matching/memory modes remain separate. No major semantic contradiction found in the reviewed material.
- [ ] **L0182 — surveys:** Regenerate the served `scope.json`, which lacks the source’s named-survey routing guidance. Keep the documented survey inventory synchronized with packaged survey data.
- [ ] **L0183 — concept webs:** No major semantic contradiction found. Add a clearly linked integration example explaining the existing standalone scoring and L0176 embedding paths.
- [ ] **L0184 — charts:** Update the developer roadmap, which still describes analytical plots as future work despite their implementation. Add development commands to the README. Regenerate stale instructions using `hide-chart-menu` instead of `show-chart-menu`, and refresh heatmap guidance and example prompts.
- [ ] **L0176 generated instructions:** Regenerate the served instructions to include the source’s current no-connection preview-signing behavior.
- [ ] **Shared reference links:** Replace the missing `./graffiticode-language-spec.html` target in L0003, L0010, L0013, L0176, L0177, L0178, L0180, and L0181 with a core-spec destination available in both source and served documentation.

## Completion checks and defaults

- Treat this as documentation maintenance; implementation defects discovered during reconciliation become separate tasks.
- Preserve historical migration/evidence records, clearly marked as historical. Update current recommendations without blindly replacing every legacy language ID.
- Edit canonical sources and regenerate assets through the existing build pipeline. Account for intentionally prepended parent instructions and injected `authoring_guide` metadata.
- Extend existing checks to cover README examples, documented vocabulary, working reference links, and generated-asset freshness. Add focused checks for the L0180 contradictions and L0014 omissions.
- Re-run affected documentation and recipe tests, validate compiled examples against output schemas, and inspect generated documentation before release.
