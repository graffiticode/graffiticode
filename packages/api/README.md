Graffiticode API Gateway
---

# Getting started

## [Authorization](docs/authorization.md)

## Running locally

The API lives in the [graffiticode monorepo](https://github.com/graffiticode/graffiticode)
as the `packages/api` workspace. Clone and set it up from the repository root:

```bash
git clone git@github.com:graffiticode/graffiticode.git
cd graffiticode
npm ci
npm run build
```

See the [root README](../../README.md) for starting the emulators, auth service and gateway together.

# Deploying

The API releases to Google Cloud Run through the workspace deploy CLI, from the repository root:

```bash
npm run deploy -- api --plan   # offline preview
npm run deploy -- api
```

Read [`packages/deploy/README.md`](../deploy/README.md) before a real release.

# Contributing

## Development

```bash
npm run dev
```

This is the npm script to clean, build, test, and run the application on file changes.

## License

[MIT](LICENSE)
