`@graffiticode/tracing`
---
Setup [OpenTelemetry](https://opentelemetry.io/) for tracing

## Getting Started
```
npm i @graffiticode/tracing
node -r @graffiticode/tracing app.js
```

## Exporters

Tracing is **off** unless `OTEL_SPAN_EXPORTER` names an exporter: `google-cloud`,
`zipkin`, `jaeger` or `console`. With it unset, preloading this package does
nothing. Filesystem (`fs`) auto-instrumentation stays off either way.

Until 0.4.0 an unset variable fell back to the console exporter, which printed
every span to stdout as ~30 lines; with `fs` spans on, each cold start printed
thousands (about 20 GiB a week of Cloud Logging across the legacy language
services, 2026-11).

## Source

Lives in `graffiticode/graffiticode` at `packages/tracing` since 0.4.0. Earlier
versions came from `KevinDyer/node-graffiticode-compiler-framework`. It is not
one of the monorepo's npm workspaces, so its dependencies stay out of the
monorepo lockfile; publish it from this directory.

## License

MIT

## Collaborators

- Kevin Dyer <kevin.m.dyer@gmail.com>