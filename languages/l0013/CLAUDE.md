# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
Vitest is installed at the root (`vitest ^2.1.3`) but **no test script is wired up and no `*.spec.*` / `*.test.*` files exist**. There is no test config. If adding tests, wire up a `test` script and a vitest config first.

### Deployment
- **Deploy**: `npm run gcp:build` — this is the canonical way to deploy (submits `cloudbuild.yaml` to Cloud Build, which builds and deploys to Cloud Run).
- **GCP Direct Deploy**: `npm run gcp:deploy` (a from-source Cloud Run deploy of `l0013`, region `us-central1`, port 50013, **2Gi memory / 2 CPU / concurrency 4 / 300s timeout** — sized for headless Chrome). Use `gcp:build` instead for normal deploys.
- **View logs**: `npm run gcp:logs`
- Also: `cloudbuild.staging.yaml`, `cloudbuild.production.yaml`, `Dockerfile`. See `DEPLOYMENT.md` and `GITHUB_DEPLOYMENT.md`.

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
  - `GRAFFITICODE_CREDENTIALS` / `GOOGLE_APPLICATION_CREDENTIALS` — service-account key for Storage upload
  - `PUPPETEER_EXECUTABLE_PATH` — Chrome binary override (set in the container)
  - `GC_SNAP_ACCESS_TOKEN` — fallback auth token used when rendering the target item

### Dependencies
- `@graffiticode/l0000` / `@graffiticode/l0000-view` (published) — base language / view, inherited by `core` / `view`
- `@graffiticode/auth` — auth client used by `api`
- **`puppeteer`** (headless Chrome render), **`sharp`** (crop/resize/PNG), **`firebase-admin`** (Storage upload) — `core` only, lazy-loaded inside `snap.ts`. These are why Cloud Run is sized at 2Gi/2CPU.
