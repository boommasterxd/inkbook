# Project Instructions

## Scope and Architecture

Inkbook is a desktop- and Android-capable Obsidian plugin that overlays retained SVG annotations on native Markdown views. Obsidian owns Markdown, editor history, workspace lifecycle, settings hosting, and Vault access. Inkbook owns annotation domain records, deterministic geometry and binding logic, view-local projection, sidecar persistence, and recovery.

Dependencies point toward framework-independent domain modules. Domain code must not import Obsidian, CodeMirror, React, DOM, storage, or worker APIs. Application modules coordinate commands and ports. Rendering, input, UI, workers, and Obsidian adapters implement outward concerns. Cyclic dependencies, process-global mutable state, per-element React scene components, and direct file-system access are forbidden.

## Performance Priority

Performance and resource efficiency are Inkbook's highest technical optimization priority. Every architecture and implementation choice MUST optimize and measure interaction latency, main-thread work, allocation and retained-memory cost, framework and DOM work, and avoidable I/O. Correctness, data integrity and recovery, security, and accessibility are non-negotiable and MUST NOT be traded for speed.

The plugin MUST remain fully interactive at the 5,000-element minimum tier and pass the predeclared 10,000-element stress tier on the named supported desktop and Android device matrix. Preserve retained, viewport-bounded SVG; minimal imperative projection diffs outside React; zero per-element React scene components; zero React note-root commits on pointer, gesture-preview, scroll, zoom, culling, retained-node, selection-chrome, and worker-progress paths; incremental spatial indices and work proportional to affected elements or viewport candidates; worker-first DOM-independent computation at the specified admission thresholds; and hard bounds on queues, bytes, concurrency, caches, slices, mounted nodes, path commands, and lifecycle resources. A single-element operation MUST NOT scan or rebuild the complete scene.

Performance is a phase-exit and release gate, not deferred hardening. Each phase MUST run and record its assigned calibrated performance evidence before its exit can be claimed. Fixtures, devices, thresholds, warmups, sample counts, and procedures MUST be fixed before measurement; missing, retrospectively changed, or exceeded gates fail the phase or release. [`docs/specification/06-svg-rendering.md`](docs/specification/06-svg-rendering.md), [`docs/specification/09-quality-and-performance.md`](docs/specification/09-quality-and-performance.md), [`docs/specification/10-testing-and-acceptance.md`](docs/specification/10-testing-and-acceptance.md), and [`docs/specification/11-implementation-roadmap.md`](docs/specification/11-implementation-roadmap.md) remain authoritative for budgets and evidence.

## Naming and Documentation

Technical content, identifiers, comments, tests, configuration, and documentation use English. Source identifiers and file names use ASCII-compatible English names. Documentation lives under `docs/`, uses `kebab-case` Markdown file names, and links to the authoritative owning specification instead of duplicating contracts. Update this index whenever a Markdown document under `docs/` is created, moved, renamed, or removed.

## Quality Limits

Review functions above 50 lines, files above 300 lines, cyclomatic or cognitive complexity above 15, functions above 4 parameters, and nesting above 3 levels. CI fails above 100 function lines, 500 file lines, cyclomatic complexity 20, cognitive complexity 25, 6 parameters, nesting depth 4, or below 85 percent line coverage. Exceptions must be narrow, measured, and justified.

Prefer immutable records, closed discriminated unions, small public interfaces, explicit lifecycle ownership, bounded queues and caches, stable callbacks, incremental indices, viewport-bounded work, retained SVG updates outside React, and worker-first DOM-independent computation. Correctness, security, accessibility, and maintainability remain release gates alongside performance.

## Tests and Tooling

Tests live under `test/`. Create subdirectories only when real suites need them. Every relevant behavior change requires deterministic normal, boundary, failure, race, and abuse coverage. Critical editor, persistence, recovery, multi-pane, Android, accessibility, and performance workflows require integration or end-to-end evidence on declared host versions and real devices. Fixed waits are forbidden.

CI must enforce formatting and linting with the quality limits, strict static type checking, automated tests, at least 85 percent line coverage, `jscpd` with `minTokens: 50`, `knip`, dependency security auditing, architecture-boundary checks, and the production build. Add integration, accessibility, Android, and calibrated performance gates when the corresponding implementation exists. Do not add placeholder evidence systems or weaken gates through broad exclusions or unexplained suppressions.

## Documentation Index

| Document                                                                                                                                             | Purpose                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`docs/decisions/0002-toolchain-and-build.md`](docs/decisions/0002-toolchain-and-build.md)                                                           | Records the rolling-current toolchain, bootstrap resolutions, compatibility constraint, and production build. |
| [`docs/decisions/0003-host-history-and-recovery-feasibility.md`](docs/decisions/0003-host-history-and-recovery-feasibility.md)                       | Records the proven host-history and recovery boundaries, fail-closed behavior, and unsupported cases.         |
| [`docs/specification/00-readme.md`](docs/specification/00-readme.md)                                                                                 | Defines normative language, product boundaries, authority, and the specification overview.                    |
| [`docs/specification/01-product-scope.md`](docs/specification/01-product-scope.md)                                                                   | Defines product capabilities, exclusions, supported surfaces, and platform scope.                             |
| [`docs/specification/02-interaction-and-tools.md`](docs/specification/02-interaction-and-tools.md)                                                   | Defines input routing, tools, selection, host history, clipboard, zoom, and accessibility.                    |
| [`docs/specification/03-toolbar-and-stylebar.md`](docs/specification/03-toolbar-and-stylebar.md)                                                     | Defines toolbar and contextual stylebar behavior and presentation.                                            |
| [`docs/specification/04-architecture.md`](docs/specification/04-architecture.md)                                                                     | Defines packages, ownership, lifecycle, sessions, host integration, and publication order.                    |
| [`docs/specification/05-anchors-and-layout.md`](docs/specification/05-anchors-and-layout.md)                                                         | Defines note coordinates, text binding, reflow, anchors, and background alignment.                            |
| [`docs/specification/06-svg-rendering.md`](docs/specification/06-svg-rendering.md)                                                                   | Defines retained SVG rendering, geometry projection, culling, hit testing, and worker use.                    |
| [`docs/specification/07-sidecar-persistence.md`](docs/specification/07-sidecar-persistence.md)                                                       | Defines sidecar locations, schema, YAML locator, saves, conflicts, relocation, and recovery.                  |
| [`docs/specification/08-settings.md`](docs/specification/08-settings.md)                                                                             | Defines Obsidian plugin settings, defaults, scopes, validation, and maintenance actions.                      |
| [`docs/specification/09-quality-and-performance.md`](docs/specification/09-quality-and-performance.md)                                               | Defines quality gates, performance budgets, resource limits, security, and privacy.                           |
| [`docs/specification/10-testing-and-acceptance.md`](docs/specification/10-testing-and-acceptance.md)                                                 | Defines test layers, acceptance scenarios, fault cases, benchmarks, and release evidence.                     |
| [`docs/specification/11-implementation-roadmap.md`](docs/specification/11-implementation-roadmap.md)                                                 | Defines implementation phases, deliverables, and exit criteria.                                               |
| [`docs/specification/12-toolbar-mockup.md`](docs/specification/12-toolbar-mockup.md)                                                                 | Defines the role and validation boundary of the interactive toolbar mockup.                                   |
| [`docs/specification/13-references.md`](docs/specification/13-references.md)                                                                         | Lists official host references and excluded implementation inputs.                                            |
| [`docs/specification/14-obsidian-host-contract.md`](docs/specification/14-obsidian-host-contract.md)                                                 | Defines Obsidian API, package, editor, Vault, Android, and release contracts.                                 |
| [`docs/specification/15-domain-model-and-codecs.md`](docs/specification/15-domain-model-and-codecs.md)                                               | Defines canonical scene, element, style, geometry, identity, ordering, attachment, and codec records.         |
| [`docs/specification/16-operations-sessions-and-recovery.md`](docs/specification/16-operations-sessions-and-recovery.md)                             | Defines operations, session admission, host effects, recovery records, and the recovery-store contract.       |
| [`docs/specification/17-github-and-ci.md`](docs/specification/17-github-and-ci.md)                                                                   | Defines the practical GitHub, dependency-update, CI, and release configuration.                               |
| [`docs/specification/18-source-coordination-and-persistence-operations.md`](docs/specification/18-source-coordination-and-persistence-operations.md) | Defines offset maps, source admission, initial-sidecar state, and relocation or removal validation.           |
| [`docs/specification/19-feature-and-settings-overview.md`](docs/specification/19-feature-and-settings-overview.md)                                   | Summarizes the planned plugin features, tool controls, and settings.                                          |
