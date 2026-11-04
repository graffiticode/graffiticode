# C2 batch 1: L0174, L0179, L0181 and L0183 on the interpreter

Interpreter plan C2. These languages read their input, so every model is a plan the kernel evaluates against the stage's input.

**Live interpreted gate** (`node scripts/lang-parity.js --lang NNNN --interpreted --rust https://lNNNNr-sja7fatcta-uc.a.run.app`), run on 2026-11-04 against the deployed Rust services. For every case it compares the compile answer with `/compile` in `"form": "model"` followed by `/interpret`, in both modes:

| Language | Identical | Different | Invalid | Skipped | Plans | Values | Report |
|---|---|---|---|---|---|---|---|
| L0174 | 90 | 0 | 0 | 0 | 84 | 0 | `interpreted-gate-l0174.json` |
| L0179 | 1097 | 0 | 0 | 0 | 1036 | 0 | `interpreted-gate-l0179.json` |
| L0181 | 459 | 0 | 0 | 14 | 358 | 0 | `interpreted-gate-l0181.json` |
| L0183 | 1698 | 0 | 0 | 0 | 1691 | 0 | `interpreted-gate-l0183.json` |

- **Skipped:** cases whose recorded upstream data is empty, which the gate can't send.
- **Models:** a case that doesn't compile has no model, so plans are fewer than cases.
- **Rust test:** `crates/core/tests/interpret.rs` in each language checks the same thing over the whole corpus. Each case runs against its recorded data, against no data, and against an upstream value and envelope.
