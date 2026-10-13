# L0010R

L0010 — the composition-planning dialect (`plan ["0158" "0166"]` → `{ langs: [...] }`) — in
Rust.

It is a `Dialect` on the Rust kernel in [`../l0000r`](../l0000r), beside the TypeScript
implementation in [`../l0010`](../l0010), which is unchanged and is what production runs.

## Layout

- **`crates/core`** (`graffiticode-l0010`) — the dialect: what `plan` evaluates to, the checks
  on a plan, and the merged lexicon.
- **`crates/server`** (`l0010r-server`, binary `l0010r`) — the language server, which is
  `l0000r`'s server run with this dialect.
- **`tools/build-static.mjs`** — assembles `./static` from `../l0010`, which owns the spec
  documents and the React View.

## Commands

```bash
cargo test            # all tests; needs no Node and no network
npm run build         # ./static (from ../l0010), then the release binary
npm run dev           # cargo run on :50010, against a local auth service on :4100
npm run lint          # cargo clippy --all-targets -- -D warnings
npm run fixtures      # regenerate the conformance fixtures from the TypeScript implementation
```

Requires Rust 1.99+ and a checkout that includes `../l0000r`. Node `>=22` is needed only for
`build:static` and `fixtures`. The server's environment is the same as `l0000r`'s.

## Docker and deploy

Built and released from the repository root:

```bash
docker build -f configs/Dockerfile.l0010r.yaml .
npm run deploy -- l0010r
```
