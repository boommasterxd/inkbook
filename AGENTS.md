# Project Instructions

## Scope and Architecture

Inkbook is a mobile-capable Obsidian plugin that overlays retained SVG annotations on native Markdown views. Obsidian owns Markdown, editor history, workspace lifecycle, settings hosting, and Vault access. Inkbook owns annotation domain records, deterministic geometry and binding logic, view-local projection, sidecar persistence, and recovery.

Dependencies point toward framework-independent domain modules. Domain code must not import Obsidian, CodeMirror, React, DOM, storage, or worker APIs. Application modules coordinate commands and ports. Rendering, input, UI, workers, and Obsidian adapters implement outward concerns. Cyclic dependencies, process-global mutable state, per-element React scene components, and direct file-system access are forbidden.

## Naming and Documentation

Technical content, identifiers, comments, tests, configuration, and documentation use English. Source identifiers and file names use ASCII-compatible English names. Documentation lives under `docs/`, uses `kebab-case` Markdown file names, and links to the authoritative owning specification instead of duplicating contracts. Update this index whenever a Markdown document under `docs/` is created, moved, renamed, or removed.

## Quality Limits

Review functions above 50 lines, files above 300 lines, cyclomatic or cognitive complexity above 15, functions above 4 parameters, and nesting above 3 levels. CI fails above 100 function lines, 500 file lines, cyclomatic complexity 20, cognitive complexity 25, 6 parameters, nesting depth 4, or below 85 percent line coverage. Exceptions must be narrow, measured, and justified.

Prefer immutable records, closed discriminated unions, small public interfaces, explicit lifecycle ownership, bounded queues and caches, stable callbacks, incremental indices, viewport-bounded work, retained SVG updates outside React, and worker-first DOM-independent computation. Correctness, security, accessibility, and maintainability remain release gates alongside performance.

## Tests and Tooling

Tests live under `test/` and mirror the production structure. Every relevant behavior change requires deterministic normal, boundary, failure, race, and abuse coverage. Critical editor, persistence, recovery, multi-pane, mobile, accessibility, and performance workflows require integration or end-to-end evidence on declared host versions and real devices. Fixed waits are forbidden.

CI must enforce formatting and linting with the quality limits, strict static type checking, automated tests, at least 85 percent line coverage, `jscpd` with `minTokens: 50`, `knip`, dependency security auditing, architecture-boundary checks, production build and package validation, mobile-bundle validation, and calibrated performance regression gates. Do not weaken gates through broad exclusions or unexplained suppressions.

## Documentation Index

| Document                                                                                                                                             | Purpose                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`docs/decisions/0001-clean-room-implementation.md`](docs/decisions/0001-clean-room-implementation.md)                                               | Records the separated clean-room implementation process and provenance contract.                                |
| [`docs/decisions/0002-toolchain-and-build.md`](docs/decisions/0002-toolchain-and-build.md)                                                           | Records the rolling-current toolchain, bootstrap resolutions, compatibility constraint, and production build.   |
| [`docs/specification/00-readme.md`](docs/specification/00-readme.md)                                                                                 | Defines normative language, product boundaries, authority, and the specification overview.                      |
| [`docs/specification/01-product-scope.md`](docs/specification/01-product-scope.md)                                                                   | Defines product capabilities, exclusions, supported surfaces, and platform scope.                               |
| [`docs/specification/02-interaction-and-tools.md`](docs/specification/02-interaction-and-tools.md)                                                   | Defines input routing, tools, selection, host history, clipboard, zoom, and accessibility.                      |
| [`docs/specification/03-toolbar-and-stylebar.md`](docs/specification/03-toolbar-and-stylebar.md)                                                     | Defines toolbar and contextual stylebar behavior and presentation.                                              |
| [`docs/specification/04-architecture.md`](docs/specification/04-architecture.md)                                                                     | Defines packages, ownership, lifecycle, sessions, host integration, and publication order.                      |
| [`docs/specification/05-anchors-and-layout.md`](docs/specification/05-anchors-and-layout.md)                                                         | Defines note coordinates, text binding, reflow, anchors, and background alignment.                              |
| [`docs/specification/06-svg-rendering.md`](docs/specification/06-svg-rendering.md)                                                                   | Defines retained SVG rendering, geometry projection, culling, hit testing, and worker use.                      |
| [`docs/specification/07-sidecar-persistence.md`](docs/specification/07-sidecar-persistence.md)                                                       | Defines sidecar locations, schema, YAML locator, saves, conflicts, relocation, and recovery.                    |
| [`docs/specification/08-settings.md`](docs/specification/08-settings.md)                                                                             | Defines Obsidian plugin settings, defaults, scopes, validation, and maintenance actions.                        |
| [`docs/specification/09-quality-and-performance.md`](docs/specification/09-quality-and-performance.md)                                               | Defines quality gates, performance budgets, resource limits, security, and privacy.                             |
| [`docs/specification/10-testing-and-acceptance.md`](docs/specification/10-testing-and-acceptance.md)                                                 | Defines test layers, acceptance scenarios, fault cases, benchmarks, and release evidence.                       |
| [`docs/specification/11-implementation-roadmap.md`](docs/specification/11-implementation-roadmap.md)                                                 | Defines implementation phases, deliverables, and exit criteria.                                                 |
| [`docs/specification/12-toolbar-mockup.md`](docs/specification/12-toolbar-mockup.md)                                                                 | Defines the role and validation boundary of the interactive toolbar mockup.                                     |
| [`docs/specification/13-references.md`](docs/specification/13-references.md)                                                                         | Lists official host references and clean-room evidence constraints.                                             |
| [`docs/specification/14-obsidian-host-contract.md`](docs/specification/14-obsidian-host-contract.md)                                                 | Defines Obsidian API, package, editor, Vault, mobile, and release contracts.                                    |
| [`docs/specification/15-domain-model-and-codecs.md`](docs/specification/15-domain-model-and-codecs.md)                                               | Defines canonical scene, element, style, geometry, identity, ordering, attachment, and codec records.           |
| [`docs/specification/16-operations-sessions-and-recovery.md`](docs/specification/16-operations-sessions-and-recovery.md)                             | Defines operations, session admission, host effects, recovery records, and the recovery-store contract.         |
| [`docs/specification/17-repository-and-ci-governance.md`](docs/specification/17-repository-and-ci-governance.md)                                     | Defines GitHub repository settings, dependency automation, CI, rulesets, security scanning, and release assets. |
| [`docs/specification/18-source-coordination-and-persistence-operations.md`](docs/specification/18-source-coordination-and-persistence-operations.md) | Defines offset maps, source admission, initial-sidecar state, and relocation or removal validation.             |
