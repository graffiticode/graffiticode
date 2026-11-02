# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 0.4.0 (2026-11-02)

### Breaking changes

* No exporter by default. With `OTEL_SPAN_EXPORTER` unset the SDK is not started,
  instead of falling back to `ConsoleSpanExporter`. Set `OTEL_SPAN_EXPORTER=console`
  for the old output.

### Fixes

* Filesystem auto-instrumentation is disabled: one span per `fs` call, thousands at
  startup, none of them about a request.
* The published package contains only `src/` (0.3.1 shipped `example/node_modules`).

## [0.3.1](https://github.com/KevinDyer/node-graffiticode-compiler-framework/compare/v0.3.0...v0.3.1) (2023-01-08)

**Note:** Version bump only for package @graffiticode/tracing





# [0.3.0](https://github.com/KevinDyer/node-graffiticode-compiler-framework/compare/v0.2.0...v0.3.0) (2022-05-24)


### Features

* upgraded tracing deps and sdk creation ([b753f85](https://github.com/KevinDyer/node-graffiticode-compiler-framework/commit/b753f854af9fb4ba2bfb9e0823ac886c876a8a6f))





# [0.2.0](https://github.com/KevinDyer/node-graffiticode-compiler-framework/compare/v0.1.15...v0.2.0) (2022-05-23)


### Features

* add nodejs auto instrumentations ([9633954](https://github.com/KevinDyer/node-graffiticode-compiler-framework/commit/96339545051b24eba8a0f6693d2e085d7bacf21d))





## [0.1.15](https://github.com/KevinDyer/node-graffiticode-compiler-framework/compare/v0.1.14...v0.1.15) (2022-03-06)

**Note:** Version bump only for package @graffiticode/tracing





## [0.1.14](https://github.com/KevinDyer/node-graffiticode-compiler-framework/compare/v0.1.13...v0.1.14) (2022-03-06)

**Note:** Version bump only for package @graffiticode/tracing





## [0.1.9](https://github.com/KevinDyer/node-graffiticode-compiler-framework/compare/v0.1.8...v0.1.9) (2021-10-24)

**Note:** Version bump only for package @graffiticode/tracing





## [0.1.8](https://github.com/KevinDyer/node-graffiticode-compiler-framework/compare/v0.1.7...v0.1.8) (2021-07-18)

**Note:** Version bump only for package @graffiticode/tracing





## [0.1.7](https://github.com/KevinDyer/node-graffiticode-compiler-framework/compare/v0.1.6...v0.1.7) (2021-07-18)

**Note:** Version bump only for package @graffiticode/tracing





## [0.1.6](https://github.com/KevinDyer/node-graffiticode-compiler-framework/compare/v0.1.5...v0.1.6) (2021-07-18)

**Note:** Version bump only for package @graffiticode/tracing
