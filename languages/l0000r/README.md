# L0000R

L0000 — the root Graffiticode language — in Rust: the evaluator, the lexicon, the `Dialect`
trait child languages implement, and a language server that runs it.

It sits beside the TypeScript implementation in [`../l0000`](../l0000), which is unchanged.
Both release to the same Cloud Run service, `l0000`: whichever was deployed last is what runs.

## Layout

- **`crates/core`** (`graffiticode-l0000`) — the language: AST, values, evaluator, lexicon,
  schemas, protected-function admission.
- **`crates/server`** (`l0000r-server`, binary `l0000r`) — `/compile`, `/preflight`, `/form`, and
  the public static assets.
- **`tools/build-static.mjs`** — assembles `./static` from `../l0000`, which owns the spec
  documents and the React View.

## Commands

```bash
cargo test            # all tests; needs no Node and no network
npm run build         # ./static (from ../l0000), then the release binary
npm run dev           # cargo run, against a local auth service on :4100
npm start             # run the release binary
npm run lint          # cargo clippy --all-targets -- -D warnings
npm run fixtures      # regenerate the conformance fixtures from the TypeScript implementation
```

Requires Rust 1.99+. Node `>=22` is needed only for `build:static` and `fixtures`, both of
which run against `../l0000`.

The server reads `PORT` (default `50000`), `AUTH_URL`, `STATIC_DIR` (default `./static`),
`GRAFFITICODE_API_URL`, `GRAFFITICODE_SECRET_KEY`/`GRAFFITICODE_SECRET_KEYS`, `LOG_LEVEL`, and for
chain admission `POLICY_URL` and `PREFLIGHT_GATEWAYS` (see `CLAUDE.md`).

## Docker and deploy

The image is built from the repository root, because it needs `languages/l0000` too:

```bash
docker build -f configs/Dockerfile.l0000r.yaml .   # from the repository root
npm run deploy -- l0000r                            # Rust → Cloud Run service l0000
npm run deploy -- l0000                             # TypeScript → the same service
npm run rollback -- l0000r --release <release-id>   # back to whatever ran before that release
```
