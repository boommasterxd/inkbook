# Project Instructions

## Architecture

This repository contains the implementation specification for Inkbook's handwriting embed. The target implementation uses five responsibility areas: pure domain logic, editor orchestration, SVG rendering, persistence, and Obsidian integration.

Keep the architecture small: one workspace activation coordinator, one normalized element store, one command history, one uniform spatial index, one imperative SVG scene renderer with one canvas input surface, one document worker per active document, and thin adapters for Obsidian, vault, clipboard, and worker boundaries. The coordinator serializes activation across tabs, panes, and pop-out windows and may retain at most one detached dirty session until save or recovery completes. React owns application chrome and coarse UI state only; it never renders ink elements or participates in pointer, camera, culling, snapping, or animation-frame updates. The store owns two fixed render bands, stable order within each band, semantic shape anchors, one derived reverse map for connected line and arrow endpoints, and domain-classified deltas with commit-time geometry and paint versions. The document worker owns bounded file validation, migration, clipboard codecs, SVG export, hashing, and persisted-output verification, but never DOM, pointer, camera, scroll, or Obsidian API work. Do not add a backend, dependency-injection container, state-management framework, generic graph library, worker pool, or plugin-internal extension system.

A minimal mobile-compatible Obsidian plugin entry point and the repository quality, build, security, and release tooling are present. Introduce implementation modules only when they own real behavior in one of the documented responsibility areas. The normative contracts under `docs/` define the intended implementation and acceptance behavior.

All plugin runtime code and static plugin styles live in responsibility-specific folders below `src/`; shared source files MUST NOT accumulate directly under `src/` except for the build entry point. Obsidian host styling belongs below `src/obsidian/styles/`. Keep focused test code below `test/`, repository automation below `scripts/`, and generated Obsidian release files below `dist/`. Root files are limited to repository documentation, metadata, and configuration required by npm, Obsidian, GitHub, or quality tooling.

## Obsidian Integration Boundaries

- Use documented public Obsidian APIs. Live Preview uses `registerEditorExtension()`, Reading view uses `registerMarkdownPostProcessor()` with owned `MarkdownRenderChild` instances, active-note text changes use `Editor`, and vault files use `Vault` and `FileManager`.
- Prefer progressive enhancement. If a native SVG embed cannot be identified through documented context, preserve Obsidian's static preview instead of depending on private DOM structure.
- Own DOM, listeners, timers, observers, React roots, portals, and pointer work through an Obsidian `Component` or widget lifecycle. A workspace coordinator owns only the authoritative session and its worker while active or draining a detached dirty save. Support pop-out windows through the owning document and window.
- Use `Plugin.loadData()` and `Plugin.saveData()` for vault settings and `App.loadLocalStorage()` and `App.saveLocalStorage()` for device-local, vault-specific preferences.
- Preserve desktop and mobile support without Node.js, Electron, Adapter APIs, private host fields, or private CSS selectors.
- Follow the release and Community directory contract in `docs/obsidian-integration.md`. Do not claim submission readiness until the required manifest, README, license, source, build, and release artifacts have been verified.

## Naming

- Write technical content in English.
- Use ASCII-compatible `kebab-case` names for documentation files.
- Preserve exact product, API, UI, command, and identifier spelling when those names are part of the specified contract.
- Keep each behavioral rule in one canonical document and use relative links instead of duplicating details.

## Quality Boundaries

- Keep each document focused on one stable responsibility and below 500 lines.
- Preserve numeric values, formulas, input conditions, timing rules, and failure behavior when reorganizing content.
- Mark unresolved or contradictory specification details explicitly instead of silently guessing.
- Keep architecture, security, accessibility, performance, and operational claims grounded in available project evidence.
- Treat 10,000 strokes as the required interactive performance dataset and preserve live input responsiveness over animation or background work.
- Coalesce renderer invalidations to one animation-frame update, mutate only changed or newly visible SVG nodes, bound all main-thread and worker caches, and serialize vault writes while coalescing newer asynchronous exports.
- Preserve Obsidian as the sole vertical scroll owner. Reserve its native scrollbar gutter for the complete recognized-presentation lifetime before Inkbook performs a width-derived preview or editor measurement, retain it across lock and unlock, never toggle it in the pointer hot path, and do not create a nested vertical scroller.
- Keep order-only commands within the command-commit budget and resolve connected endpoints incrementally through the reverse connection map. Snap candidate lookup must use the spatial index rather than scan the element store.
- Keep the saved SVG self-contained and visually equivalent to the active document graphic in both canonical light and dark schemes. Host theme variables style plugin chrome only and never become an external file dependency.
- Prefer direct, measurable contracts and the fewest modules or dependencies necessary to satisfy them.

## Test Requirements

- Documentation-only changes require a complete content review, working relative links, balanced Markdown code fences, and a synchronized Documentation Index.
- Do not add synthetic parser, snapshot, or string-comparison tests solely for documentation.
- The implementation uses Unit and focused Integration tests only. End-to-end and smoke test suites are explicitly excluded.
- Unit tests cover pure domain, geometry, schema, state-machine, workspace activation coordination, command, settings, zoom, scroll-owner leases, document-worker state, serialization, render ordering, shape anchors, endpoint connections, detachment, propagation, migration, and clipboard ID remapping.
- Integration tests cover only important renderer, document-worker and fallback, workspace and pop-out lifecycle, native-scrollbar stability, Vault/FileManager, CodeMirror, Reading-view lifecycle, clipboard, and settings boundaries through test adapters.
- Maintain at least 85 percent line coverage across executable source and satisfy the acceptance requirements in `docs/quality-and-testing.md`.

## Quality Tooling

Use `npm`, TypeScript, esbuild, Vitest, ESLint, the official `eslint-plugin-obsidianmd` recommended type-aware configuration, a formatter, `jscpd` with `minTokens: 50`, `knip`, and `npm audit`. Applicable Obsidian API, lifecycle, mobile, command, styling, path, settings, and sample-code findings are errors. CI must run formatting verification, linting, type checking, Unit and Integration tests with coverage, duplicate and dead-code detection, dependency audit, deterministic performance benchmarks, and a production artifact build.

Keep CodeMirror and Lezer external to the production bundle. Do not add direct CodeMirror development dependencies until source imports require them. When required, pin them to the exact peer versions declared by the selected `obsidian` package and update that compatibility set together; generic Dependabot updates for direct CodeMirror peers remain ignored.

## Documentation Index

| Document                                                                 | Purpose                                                                                                                                                              |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/architecture-flows.md`](docs/architecture-flows.md)               | Visualizes runtime ownership, session lifecycle, workspace activation, native scrolling, imperative rendering, document-worker boundaries, and persistence recovery. |
| [`docs/core-model.md`](docs/core-model.md)                               | Defines the SVG-backed handwriting file model and page dimensions.                                                                                                   |
| [`docs/editor-tools.md`](docs/editor-tools.md)                           | Specifies selection, drawing, highlighting, shapes, endpoint snapping, arranging, erasing, and style behavior.                                                       |
| [`docs/embed-ui.md`](docs/embed-ui.md)                                   | Describes locked and unlocked embed states, toolbar layout, responsiveness, and flyouts.                                                                             |
| [`docs/features.md`](docs/features.md)                                   | Specifies backgrounds, page expansion, history, clipboard, input, arranging, locking, and overflow actions.                                                          |
| [`docs/file-format.md`](docs/file-format.md)                             | Defines the versioned SVG envelope, compact editable snapshot schema, ordering, connections, geometry, size limits, and migrations.                                  |
| [`docs/obsidian-integration.md`](docs/obsidian-integration.md)           | Defines supported Obsidian surfaces, multi-window ownership, native-scrollbar stability, public APIs, lifecycle, host storage, UI rules, and release requirements.   |
| [`docs/quality-and-testing.md`](docs/quality-and-testing.md)             | Defines performance, memory, file-size, scroll stability, document-worker, multi-window, animation, accessibility, and verification requirements.                    |
| [`docs/rendering-and-performance.md`](docs/rendering-and-performance.md) | Defines the imperative SVG scene, gesture updates, culling, bounded caches, document-worker boundary, and coalesced asynchronous persistence.                        |
| [`docs/settings.md`](docs/settings.md)                                   | Defines tool defaults, page preferences, input settings, scope, precedence, and validation.                                                                          |
| [`docs/specification.md`](docs/specification.md)                         | Defines implementation scope, platform baseline, architecture, workspace activation, state transitions, persistence, and security.                                   |
| [`docs/svg-envelope.md`](docs/svg-envelope.md)                           | Defines the standalone SVG envelope, portable light and dark palette, strict CSS allowlist, and external-rendering fidelity.                                         |
| [`docs/zoom.md`](docs/zoom.md)                                           | Specifies width-fit zoom, navigation inputs, anchoring, frame updates, and lock transitions.                                                                         |
