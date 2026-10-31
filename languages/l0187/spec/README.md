<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0187 spec sources

The canonical, hand-written sources of L0187's published documentation. `tools/assemble-static.mjs`
builds the served assets from them (`spec.html` from `spec.md`; `instructions.md` merged after
L0000's; `language-info.json` with its `authoring_guide` from the usage guide's Overview).
Every `gc` block here is compiled by `crates/core/tests/docs.rs`, and the vocabulary tables in
`spec.md` must equal `crates/core/src/vocab.rs`.
