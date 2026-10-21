# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Two implementations live here.** `packages/` is the TypeScript L0013 that production runs; `crates/` is L0013 in Rust. Everything down to "The Rust implementation" describes the TypeScript side.

## Commands

### Development
- **Start dev server**: `npm run dev` (API server on port 50013; sets `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` and `AUTH_URL=http://127.0.0.1:4100`, runs `tsx watch`)
- **Build project**: `npm run build` (builds `core` → `core` static → `api` → `view` → `view` embed, then `assemble`)
- **Start production**: `npm run start` (runs built `packages/api/dist/main.js`)

### Linting & Formatting
- **Lint repo**: `npm run lint` (`eslint .`)
- **Lint a package**: `npm -w packages/<core|api|view> run lint`
- **Fix lint errors**: `npm run lint:fix`
- **Format**: `npm run format` (`prettier --write .`)

### Package Management
- **Build and pack**: `npm run pack` (builds, then packs `packages/view`)
- **Publish**: `npm run publish` (publishes `@graffiticode/l0013` (core) and `@graffiticode/l0013-view` with public access)

### Testing
`npm test` runs vitest (root `test` script, default config) over `packages/*/src/**/*.test.ts`, which `tsc` excludes from `dist/`. So far the only suite is `packages/core/src/chrome-egress.test.ts`: Chrome's ISOLATE-01 egress-proxy arguments (the PAC script, the background-traffic flags) and NSS database.

### Deployment
- **Release**: `npm run deploy -- l0013` from the graffiticode repository root (deploy CLI; entry in root `deploy.json`, image from `configs/Dockerfile.l0013.yaml`, runtime `l0013-run`). It tests, builds, deploys a no-traffic candidate, checks `/` and `/lexicon.js`, then promotes. The service is sized for headless Chrome (**2Gi memory / 2 CPU / concurrency 4 / 300s timeout**); the deploy CLI passes only image, port, service account, env and pinned secrets, so scaling, CPU/memory, concurrency and timeout carry forward from the live service; change those with `gcloud run services update`. `l0013-run` has `roles/storage.objectAdmin` on `gs://graffiticode.appspot.com` for thumbnails.
- **View logs**: `npm run gcp:logs`

## Architecture

L0013 is a Graffiticode dialect — a child of `@graffiticode/l0000`. **Its purpose is to photograph (screenshot/thumbnail) the rendered form view of another Graffiticode item**: it renders an item in headless Chrome, crops content-aware, uploads a PNG to Firebase Storage, and returns the public URL. It's an npm-workspaces monorepo with three packages.

### Structure

- **`packages/core/`** — `@graffiticode/l0013`: the language. Pure TypeScript.
  - `src/lexicon.ts`: merges L0000's base lexicon with L0013's additions
  - `src/compiler.ts`: `Checker` and `Transformer` extending L0000's; the `SNAP` handler invokes `snap()` async, the modifier handlers normalize L0000 `Record` wrappers into a plain options object
  - `src/snap.ts`: **the side-effecting core** — render → content-aware crop → resize → upload. Node-only deps (puppeteer / sharp / firebase-admin) are imported **lazily** so that merely importing the compiler (e.g. `build-static`) doesn't pull them in
  - `tools/build-static.js`: generates `dist/static/` (merged `lexicon.json` — the legacy `lexicon.js` request path is aliased to it by the API server, `spec.html` from spec-md, merged `instructions.md`, plus `usage-guide.md` / `scope.json` / `schema.json` / `template.gc`) for the API to serve

- **`packages/api/`** — `@graffiticode/api-l0013`: Express language server. TypeScript, `tsx` in dev, compiled to `dist/` for prod.
  - Routes (`src/routes/`): `root.ts` (`GET /` health check), `compile.ts` (`POST /compile` + `OPTIONS` for CORS — forwards to core `compile()` with `lang="0013"`), `auth.ts` (token validation middleware → `req.auth`), `utils.ts` (auth parsing, CORS, handler builder), `index.ts` (re-exports)
  - `GET /form` serves the embedded form `index.html`; static assets served from `static/`
  - Port: 50013 (dev) or `process.env.PORT`

- **`packages/view/`** — `@graffiticode/l0013-view`: React (Vite + TypeScript + Tailwind) view, built on `@graffiticode/l0000-view`.
  - `src/components/form/Form.tsx`: language-specific form rendering
  - `embed/`: standalone HTML entry built by `vite.embed.config.ts` → `dist-embed/`, embedded into the API's static bundle

### Build pipeline

`npm run build` composes packages in order:
1. `core` compiles TypeScript (`build`) then runs `build-static` → `core/dist/static/`
2. `api` compiles TypeScript → `api/dist/`
3. `view` builds the library (`build` → `dist/`) and the embed bundle (`build:embed` → `dist-embed/`)
4. `assemble` clears `packages/api/static/` and copies `core/dist/static/` + `view/dist-embed/` into it — this is what the API serves

### Language Functions

L0013 inherits the full L0000 base vocabulary (arithmetic, lists, lambdas, `map`/`filter`/`reduce`, pattern matching, tags — including L0000's own `hello`/`image`/`theme`/`id`) and adds a **screenshot vocabulary**. A program is `snap <opts>..`, where `<opts>` is built by chaining arity-2 modifier functions onto a base record `{}`; each modifier returns a plain object with one field set, so `snap` receives a plain options object.

| Function   | Arity | Description |
|------------|:-----:|-------------|
| `snap`     | 1 | Photograph an item's form view → `{ url, item }` |
| `item`     | 2 | The item id to capture (task + language are resolved from it) |
| `viewport` | 2 | Browser window the form lays out into (default 1024×768) |
| `slice`    | 2 | `"W:H"` → crop the densest band at that aspect (e.g. `"4:1"` wide, `"1:4"` tall) |
| `zoom`     | 2 | `0..1` zoom within a `slice`: `0` = frame all ink, `1` = densest region (max ink²/area) |
| `crop`     | 2 | Explicit clip rectangle (`{ x, y, width, height }`) — manual override |
| `width`    | 2 | Max output width (px); with `height`, a bounding box to fit inside |
| `height`   | 2 | Max output height (px) |

Examples (note the trailing `..` that applies the chain):
```
snap item "item123" {}..
snap width 240 item "item123" {}..
snap slice "4:1" item "item123" {}..
snap crop { x: 0 y: 0 width: 800 height: 600 } item "item123" {}..
```

### Capture pipeline (`snap.ts`)

`snap()` resolves the item id to its task + language (via the app's `/form/{itemId}` route), renders the form in headless Chrome (Puppeteer, `DEVICE_SCALE=2`, `SETTLE_MS=1500` to let the form paint), then:
- **Default crop**: trims to inked content (greyscale distance ≥ `INK_THRESHOLD` from background, padded by `INK_MARGIN`).
- **`slice "W:H"`**: content-aware crop. Analysis runs on a downscaled greyscale copy with an **integral image** (O(1) ink-sum per window) and a 2-D sliding-window search for the densest target-aspect rectangle. `zoom` interpolates the window's size between the full content box (`zoom 0` = all ink) and the **densest natural region** (`zoom 1`), then re-finds the densest position *inside* the zoom-0 frame. The `zoom 1` size is ink-derived: a size search picks the window maximizing **ink²/area** (ink × density) — the tightest box that still captures a dense cluster (e.g. the square bounding a pie chart), no fixed ratio.
- Resizes with **sharp** to fit `width`/`height`, encodes PNG, **uploads to Firebase Storage** at `thumbnails/{safe}.png`, and returns the public CDN URL plus base64.

### Data Flow

```
User Input → State Update → POST /compile → Compiler (core) → snap() [render/crop/upload] → Output Data → Form (view) → postMessage to parent
```

The embedded form supports iframe embedding and communicates with parent windows via postMessage.

### Environment Variables
- `PORT`: API port (default 50013)
- `AUTH_URL`: Auth service URL (default `https://auth.graffiticode.org`; dev `http://127.0.0.1:4100`)
- `FIRESTORE_EMULATOR_HOST`: Local Firestore emulator (dev: `127.0.0.1:8080`)
- `NODE_ENV`: `development` or `production`
- **Capture (`snap.ts`)**:
  - `GRAFFITICODE_API_URL` (default `https://api.graffiticode.org`)
  - `GRAFFITICODE_APP_URL` (default `https://app.graffiticode.org`) — the app whose `/form/{itemId}` route is rendered
  - `THUMBNAIL_BUCKET` (default `graffiticode.appspot.com`) — Firebase Storage bucket for uploaded PNGs
  - Storage upload uses Application Default Credentials only: the runtime service account on Cloud Run; locally, `gcloud auth application-default login` (your own account). No service-account key file (`GRAFFITICODE_CREDENTIALS` is no longer read).
  - `PUPPETEER_EXECUTABLE_PATH` — Chrome binary override (set in the container)
  - `GC_SNAP_ACCESS_TOKEN` — fallback auth token used when rendering the target item
  - `HTTPS_PROXY` with `NODE_EXTRA_CA_CERTS` (set by the deploy CLI's `network` config, ISOLATE-01): Chrome is launched with a PAC script (`--proxy-pac-url`, a `data:` URL) that sends only `graffiticode.org` and `*.graffiticode.org` to the proxy, keeps loopback direct and sends everything else to a closed local port, with its background traffic off (`--disable-background-networking` and the rest), and a temporary `HOME` whose NSS database (built with `certutil`, from the image's `nss-tools`) trusts the proxy's CA (`src/chrome-egress.ts`; the Rust side is `crates/capture/src/egress.rs`). A proxy without a CA, or without `certutil`, fails the snap rather than launching a browser that can't verify anything

### Dependencies
- `@graffiticode/l0000` / `@graffiticode/l0000-view` (published) — base language / view, inherited by `core` / `view`
- `@graffiticode/auth` — auth client used by `api`
- **`puppeteer`** (headless Chrome render), **`sharp`** (crop/resize/PNG), **`firebase-admin`** (Storage upload) — `core` only, lazy-loaded inside `snap.ts`. These are why Cloud Run is sized at 2Gi/2CPU.

## The Rust implementation (`crates/`)

This directory holds **two implementations of L0013**. `packages/core` and `packages/api` are the TypeScript compiler and server, which production runs (Cloud Run service `l0013`). `crates/` is the same language in Rust, to be released to its own service `l0013r` so it can be vetted before it replaces the TypeScript. `packages/view` and the spec are shared by both.

- `crates/core` (`graffiticode-l0013`) — the dialect and nothing side-effecting. `L0013` implements `Dialect` from `graffiticode-l0000`: the modifiers build an options record, and `snap` turns it into a `SnapRequest` and hands it to a `Camera` (a trait). `crop.rs` is the content-aware crop as a pure function of a greyscale scan. `lexicon()` is the base lexicon merged with `src/lexicon-additions.json`.
- `crates/capture` (`l0013-capture`) — the `Camera` that does the work, `ChromeCamera`: resolve the item, render its form in headless Chrome (`browser.rs`, over `chromiumoxide`), decide the crop, re-render at a higher device scale if the crop is smaller than the output, encode a PNG (`pixels.rs`, over `image`), and upload it (`storage.rs`). Storage is a trait too; `GoogleStorage` writes the bucket with application default credentials.
- `crates/server` (`l0013r-server`, binary `l0013r`) — `l0000r_server::serve(L0013::new(camera), lexicon())`. Routes, auth and static serving live in `languages/l0000/crates/server`.
- `tools/assemble-static.mjs` — builds `packages/core`'s static assets and `packages/view`'s embed bundle into `./static`, which the Rust server serves.

**The Rust side depends on `languages/l0000` by relative path** (Cargo path dependencies on its kernel and server crates; the fixture generator uses its `node_modules` for the parser). Read "The Rust implementation" in `languages/l0000/CLAUDE.md` for how evaluation, values and the `Dialect` trait work.

```bash
cargo test            # everything; the Chrome tests skip, loudly, where no Chrome is installed
cargo test -p graffiticode-l0013        # the dialect and the crop algorithm: no browser, no network
cargo test -p l0013-capture --test chrome   # the pipeline against a real headless Chrome
npm run rust:build    # rust:static, then cargo build --release -p l0013r-server
npm run rust:dev      # cargo run -p l0013r-server on :50013 with AUTH_URL=http://127.0.0.1:4100
npm run rust:lint     # cargo clippy --all-targets -- -D warnings
npm run rust:fixtures # build packages/core, then regenerate tests/conformance/cases.json and src/lexicon-additions.json
```

Capture env vars (same meaning as the TypeScript server's): `GRAFFITICODE_API_URL`, `GRAFFITICODE_APP_URL`, `THUMBNAIL_BUCKET`, `GC_SNAP_ACCESS_TOKEN`, and `CHROME_PATH` (or `PUPPETEER_EXECUTABLE_PATH`) for the browser; with neither, Chrome is found on the system.

### What differs from the TypeScript

- **The caller's token.** The TypeScript server copies the request's token into `config`, where a program can read it with `get-var "config"`. Here it travels in the invocation's identity: `snap` gets it only when the server verified it, and no program can see it.
- **Pixels are not byte-identical.** The crop decision is the same algorithm, but it runs on a scan downscaled by the `image` crate, not `sharp`, and the final resize uses that crate's Lanczos filter. Crops can differ by a pixel and outputs by resampling. Nothing compares the two implementations' images.
- **Full-page capture** is done with raw DevTools commands (`Page.captureScreenshot` with a clip of the content size), because `chromiumoxide`'s own full-page mode resets the device scale this pipeline depends on.
- **One profile per browser.** Each snap launches Chrome with its own temporary profile, so concurrent snaps cannot collide.

### Tests

- `crates/core/tests/conformance.rs` — against the TypeScript compiler, for programs that never reach a successful `snap` (that would launch a browser and upload to production storage): the modifiers on their own, and `snap`'s refusals. Identical data and errors; no divergences.
- `crates/core/tests/dialect.rs` — `snap` with a fake camera: the request it builds, that only a verified token reaches it, and how a failure is reported.
- `crates/core/src/crop.rs` — the crop algorithm on synthetic pages.
- `crates/capture/tests/chrome.rs` — the whole pipeline with a real headless Chrome, a local server standing in for the API and app, and in-memory storage. It checks the trim, the output sizes, a slice, an explicit crop, the sharp re-render, and that tokens go where they should. **Nothing in the tests writes to real storage or renders a real item.**

### Deploying the Rust server

`deploy.json` has an `l0013r` entry (own service, `l0013r-run@graffiticode.iam.gserviceaccount.com`, image from `configs/Dockerfile.l0013r.yaml`; snapshot is this directory and `languages/l0000`; build step `cargo test --locked`, where the Chrome tests skip). The runtime image is Debian with Chromium and fonts, not distroless. Run the deploy with `CLOUDSDK_PYTHON` pointing at Python 3.10 or later (see `languages/l0000/CLAUDE.md`).

The service and account do not exist until provisioned. To do what `snap` does, the account needs `roles/storage.objectAdmin` on the thumbnail bucket (`graffiticode.appspot.com`), as `l0013-run` has, and the service needs the sizing Chrome requires (the TypeScript service runs with 2 CPU, 2Gi, concurrency 4). Until it has the bucket role, every `snap` fails at the upload.

**A real `snap` on this service overwrites the production thumbnail** for that item (`thumbnails/{item}.png`), exactly as the TypeScript service does. Point `THUMBNAIL_BUCKET` elsewhere to try it without that.

Rust conventions: `cargo fmt` (`rustfmt.toml`, 120 columns) and `cargo clippy --all-targets -- -D warnings` clean; `static/` and `target/` are gitignored build outputs; `src/lexicon-additions.json` and `tests/conformance/cases.json` are generated, not edited.
