# Quality and Performance

## 1. Code-Quality Requirements

The plugin MUST satisfy the project-wide engineering standards. The following limits are CI failures unless a narrower project rule replaces them:

| Metric                  |    Review threshold |         CI maximum |
| ----------------------- | ------------------: | -----------------: |
| Function length         |  more than 50 lines |          100 lines |
| File length             | more than 300 lines |          500 lines |
| Cyclomatic complexity   |        more than 15 |                 20 |
| Cognitive complexity    |        more than 15 |                 25 |
| Parameters per function |         more than 4 |                  6 |
| Nesting depth           |         more than 3 |                  4 |
| Line coverage           |    below 85 percent | minimum 85 percent |

Review-threshold exceptions require a specific written reason. CI maxima MUST NOT be bypassed through minification, line compression, blanket exclusions, disabled rules, or unjustified ignore comments.

Every function, class, component, and module MUST have one clear primary responsibility. Domain, application, rendering, input, UI, persistence, and host-adapter concerns remain separated. Public interfaces stay narrow, immutable, and explicit; related arguments use named request objects instead of ambiguous boolean parameters. The implementation MUST prefer composition, dependency injection at meaningful ports, early validation, and structurally unrepresentable invalid states. Global mutable state, hidden side effects, speculative abstraction, cyclic ownership, and convenience layers without a current requirement are forbidden.

Production, test, configuration, documentation, branch, and commit content is English. Technical identifiers and file names are ASCII-compatible and use one documented casing convention per file type. Commits, when made, use English Conventional Commit messages. The implementation declares npm as its one package manager, generates its lockfile only through npm, and MUST NOT mix package managers or perform unrelated dependency upgrades.

The project uses a rolling-current toolchain and dependency policy. Every newly added dependency starts at the newest stable release that is mutually compatible with the supported Obsidian and mobile runtime. Before every phase exit and release-candidate freeze, an automated freshness check resolves the current stable release channels for Node.js active LTS, npm, every direct dependency, every quality tool, and every CI action or build runtime. The candidate MUST use those current stable compatible releases; a compatibility failure blocks the candidate until it is resolved rather than silently retaining an older version. Prereleases are excluded unless a separate accepted decision explicitly requires one. `package.json` uses maintained semantic-version ranges instead of permanent exact version pins where the ecosystem supports them. The npm-generated lockfile still records the exact resolved graph, CI and release builds use `npm ci`, and build evidence records the exact Node.js, npm, dependency, tool, action, and runtime versions used. Supply-chain-sensitive CI actions are pinned to one reviewed immutable digest within a workflow revision, but automated maintenance continually replaces that digest with the newest reviewed stable release. A published plugin never fetches or updates executable dependencies at runtime. New versions enter only through a reviewed lockfile or workflow update that passes all quality, security, mobile, package, and performance gates against one immutable artifact.

Relevant behavior changes require deterministic tests in the same change. Bug fixes require regression tests. Tests observe public behavior, cover normal, boundary, failure, security-abuse, race, and cancellation cases, and MUST NOT rely on fixed waits. The `test/` tree mirrors the production source structure.

Technical documentation and source comments are concise English. Public interfaces, configuration, operations, security boundaries, and non-obvious tradeoffs are documented. Comments explain reasons or constraints rather than restating code. Stale commented-out code and unbounded TODO or FIXME markers are forbidden. Durable non-obvious architecture decisions are recorded as English ADRs under `docs/decisions/` before the owning implementation phase exits.

## 2. Required Quality Lanes

The repository uses the settings, automation, required checks, and rulesets in [Repository and CI Governance](17-repository-and-ci-governance.md) and the three cumulative lanes below. A later lane includes every earlier gate and MUST NOT waive it.

### 2.1 Per-Commit CI

Every production or documentation change MUST pass all applicable deterministic gates:

1. formatting and linting with size, complexity, parameter, and nesting rules as errors;
2. strict TypeScript type checking without unchecked boundary casts;
3. deterministic unit and integration tests;
4. at least 85 percent line coverage over production sources;
5. duplication detection using `jscpd` with `minTokens: 50` and at most 5 percent duplicated lines;
6. dead-code and unused-export detection using `knip` or a proven equivalent;
7. dependency, phase-exit, and release validation with no unresolved, waived, or accepted critical or high security finding;
8. production build and Obsidian plugin package validation;
9. manifest validation, including mobile support and minimum Obsidian version;
10. documentation-link and example validation for this specification tree;
11. license and clean-room provenance validation for every changed code, test, fixture, algorithm, icon, asset, configuration, or documentation artifact;
12. host-adapter contract tests against deterministic fakes for the declared minimum API surface;
13. static mobile-bundle inspection that rejects transitive Node.js, Electron, native-module, remote-code, and hidden-file-system dependencies;
14. package-shape validation for `main.js`, `manifest.json`, and `styles.css`.

The package gate verifies that the immutable worker payload is embedded in `main.js`, no fourth runtime artifact is required, and the production bundle contains no remote-worker or dynamic-code path.

### 2.2 Phase-Exit Validation

Before an implementation phase exits, the project MUST pass Per-Commit CI plus every integration, Obsidian host, browser, performance, accessibility, fault-injection, migration, and real-device check assigned to that phase in [Implementation Roadmap](11-implementation-roadmap.md). The run records the production bundle digest, fixture digests, exact host and operating-system versions, device identifiers, test IDs, results, and approved manual evidence. A missing required matrix cell, threshold, fixture, or manual record blocks the phase exit. A phase may explicitly prove an unavailable capability and fail closed, but it MUST NOT claim the dependent feature complete.

### 2.3 Release Validation

A release candidate repeats Per-Commit CI and every phase-exit suite against the frozen compatibility and benchmark manifests. It additionally validates exact tag-version equality, plugin ID-folder equality, `versions.json` when the minimum version changed, complete desktop, iOS, and Android host cells, 5,000-element capacity, 10,000-element stress, packaging, licensing, provenance, accessibility, security, privacy, and Community directory requirements. A release result is valid only for the recorded immutable artifact.

Before any production implementation begins, the clean-room ADR and provenance log required by [Architecture](04-architecture.md) MUST exist and be reviewed. Provenance is updated with the same change that introduces an influenced artifact, not reconstructed only at release time.

## 3. Architecture Gates

CI MUST reject:

- imports from domain into Obsidian, DOM, UI, rendering, storage, or CodeMirror packages;
- cyclic package dependencies;
- direct Node.js, Electron, or raw file-system imports in production code;
- global `app`, `window.app`, global mutable plugin state, and view-owned use of global `document` or `window`;
- unbounded global caches, queues, listeners, timers, or session registries;
- public mutable scene objects;
- direct sidecar mutation outside the persistence adapter;
- arbitrary raw SVG or HTML injection paths;
- custom Inkbook `ItemView`, Bases integration, annotation leaf, Ribbon action, persistent host status-bar item, or replacement Markdown editor;
- bare Vault or workspace event registrations without an owning `Component`, and resources that lack idempotent disposal;
- editor state-field mutation outside typed transaction effects, side effects in state-field updates, or decoration widgets that change Markdown layout;
- one React component per annotation element, scene-wide React context values that change on every pointer sample or scene revision, or React ownership of retained SVG geometry;
- authored production, test, benchmark, and mockup files or functions above the CI maxima. Only generated artifacts may use a narrow documented exclusion.

Reusable components SHOULD be small and purpose-specific. Shared controls such as color, width, opacity, caps, dash, fill, menu, slider, and segmented choice belong in a toolbar component library. Domain operations, geometry, input routing, and Obsidian adapters MUST not be folded into UI components for convenience.

## 4. Performance Workload

The long-note benchmark fixture contains at least:

- 100,000 Markdown characters;
- 10,000 annotation elements, each with exactly one valid binding;
- at least 2,000 text-following elements distributed across text-range and text-position bindings, with the remaining elements using a deterministic mix that includes fixed bindings;
- 250,000 total stroke points;
- 200,000 note CSS pixels of scrollable height;
- mixed strokes, highlighters, shapes, connectors, axes, and tables;
- offscreen, selected, degraded, and orphaned elements.

The minimum supported interactive-capacity tier is 5,000 canonical annotation elements in one note on every supported release device. The 10,000-element workload is the standard release stress gate, not a parser-limit claim. Both tiers contain dispersed and dense visible-cluster variants, are generated deterministically, have recorded digests and encoded byte sizes, and MUST be valid under every simultaneous sidecar limit. Parser abuse ceilings above these tiers do not imply interactive performance.

Benchmarks MUST run on named desktop, tablet, and phone reference devices with the Obsidian version, operating system, refresh rate, theme, plugin build, and fixture digest recorded.

## 5. Performance Gates

The frame and latency budgets in [SVG Rendering](06-svg-rendering.md) are release gates after calibration. Regression checks MUST additionally verify:

- viewport culling mounts no more than the documented bounded set for the standard long-note viewport;
- scroll and zoom work is proportional to viewport candidates, not all 10,000 elements;
- selecting or resizing one visible element performs work proportional to that element and bounded nearby candidates, never all scene elements;
- a single geometry resize preserves the style record and invalidates only affected geometry, paint bounds, selection geometry, spatial-index entries, and geometry-dependent caches;
- aggregate resize preview uses one transient group transform for compatible mounted projections and one coalesced worker batch only for mounted pressure-stroke level-of-detail outlines; it never regenerates offscreen member paths, Table dividers, axes guides, or canonical samples for each pointer event;
- aggregate commit work is proportional to selected members, publishes atomically, and never rebuilds the complete scene or spatial index;
- Markdown reflow updates affected anchor transforms without rebuilding unrelated stroke paths;
- binding inference runs only after a completed creation gesture, a destination move of a non-fixed element, or an explicit rebind request, never for movement of a fixed element, never after resize or rotation, and never on pointer movement, scroll, pure note zoom, or every layout frame;
- binding candidate lookup is proportional to bounded nearby text-layout candidates rather than the complete Markdown document;
- width-induced reflow updates only affected text-position transforms, text-range fragments, enclosing regions, bounds, and spatial-index entries;
- two panes with different widths share canonical geometry and bindings but retain independent bounded projection caches;
- secondary-button pan while zoomed changes only the shared view transform and never annotation selection, canonical state, history, or sidecar work;
- pointer movement causes no canonical scene publication and at most one scheduled render per frame;
- pointer movement, scroll, pure zoom, culling, retained-node updates, selection chrome, and worker progress cause zero React note-root commits and zero per-element React renders;
- a tool, style, or selection-summary change causes at most one batched React commit for only the subscribed toolbar, stylebar, menu, or status subtree;
- listener callbacks, worker completions, and attached-view updates never re-enter canonical publication synchronously; bursts are serialized and revision-coalesced without recursive render or command cascades;
- one completed gesture causes one operation, one isolated invertible event in the originating host history, and one coalescible save generation;
- native Markdown transaction bursts compose into at most one active and one replaceable latest source-checkpoint write, materialize no per-element anchor array on the editor update path, and cause one coalescible sidecar generation, with no annotation effect event and no view-only reflow checkpoint;
- a 100,000-point interactive stroke and a 200,000-point imported stroke never trigger quadratic reconstruction;
- final binding inference for a 100,000-point gesture consumes incrementally accumulated evidence and does not rescan all samples at pointer up;
- maximum Tables and axes use bounded composed paths and remain inside the documented projection, DOM-node, path-command, and frame-work budgets;
- spatial queries, whole-note lasso, Select All, multi-selection style aggregation, and bulk-transform preparation run in cancellable slices of at most 4 ms and never expose partial canonical state;
- every DOM-independent phase admitted by `WORKER_ADMISSION_V1` below is worker-first on a conforming worker platform;
- worker messages use bounded packed or transferable data, stale low-priority work is cancelled, queue length is bounded, and worker overhead is measured separately from useful computation;
- bulk selection uses one bounded aggregate control frame rather than one handle set per selected element;
- next and previous annotation selection use the cached selectable-order index and current spatial index, perform no scene-wide scan or offscreen mount, and publish only the selected ID plus bounded reveal work;
- background rendering performs constant work per mounted rhythm region, remains proportional to bounded visible body-text regions rather than complete document length, and recomputes metrics only when the host-layout token changes, never for every scroll or pure-zoom frame;
- sidecar-location migration runs only after explicit user admission, enumerates and migrates in bounded yielding batches, and performs no Vault scan, path derivation, or file move during startup or ordinary note input;
- geometry cache use stays within 8 MiB per view under the standard workload;
- every cache, observer, worker, timer, pointer capture, and session is released after view close and plugin unload;
- editor-extension registration occurs once, each concrete editor creates and destroys exactly one plugin value, update bursts produce at most one current projection request per animation frame, and offscreen Markdown is never forced to mount;
- passive workspace discovery causes zero deferred-view loads, while an explicit user command records and bounds every required reveal or compatibility load;
- Reading View reprocessing replaces only the affected section generation and creates no duplicate whole-note overlay, observer, or background region;
- migration between the main window and a desktop pop-out releases old-window listeners, observers, animation frames, framework roots, and SVG ownership before binding the new owner window;
- coarse UI framework root count remains proportional to attached view and settings surfaces, and every root unmounts with its `Component` owner.

A conforming worker platform is one compatibility-matrix cell whose Phase 0 production worker probe passes launch, transfer, cancellation, crash, and disposal. `WORKER_ADMISSION_V1` MUST apply when any threshold in a row is met:

| Operation family                                                                     | Worker admission threshold                                                   |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Sidecar tokenize, validation, decode, encode, migration, or SHA-256                  | At least 512 KiB encoded or decoded input                                    |
| Pressure outline or stroke level of detail                                           | At least 4,096 canonical samples                                             |
| Bulk bounds, spatial-index build, large spatial query, lasso, or aggregate transform | At least 1,000 candidate or affected elements                                |
| Clipboard encode, decode, validate, or remap                                         | At least 256 KiB payload or 1,000 elements                                   |
| Anchor materialization, external reattachment, or binding inference                  | At least 128 ranked candidates, 256 source blocks, or 512 rendered fragments |
| Reflow or background-region derivation                                               | At least 256 affected elements, fragments, source line boxes, or regions     |

An admitted phase runs in the worker on a conforming cell. On a cell whose Phase 0 worker probe fails, or after a worker crash, the identical pure phase uses the specified cancellable 2 ms active or 4 ms idle main-thread slices and remains fail-closed if its queue or memory bound cannot be met. Below all listed thresholds, measured main-thread work is permitted only while it stays inside the same slicing and frame budgets. The version and thresholds are part of the benchmark manifest and cannot change after observing a release-candidate run.

The following additional initial budgets MUST pass:

| Scenario                                                                   |                        Desktop or tablet |                       Mobile |
| -------------------------------------------------------------------------- | ---------------------------------------: | ---------------------------: |
| Plugin `onload` with no annotated note open                                |           at most 50 ms main-thread work |               at most 100 ms |
| Editor extension update with no relevant document or viewport change, p95  |                           at most 0.5 ms |                 at most 1 ms |
| Passive workspace discovery forced deferred-view loads                     |                                exactly 0 |                    exactly 0 |
| Cold 16 MiB sidecar tokenize, validate, decode                             |                       p95 at most 600 ms |         p95 at most 1,600 ms |
| Spatial-index build for 10,000 elements                                    |                       p95 at most 100 ms |           p95 at most 250 ms |
| Single geometry-aware hit test in either capacity tier                     |                         p95 at most 4 ms |             p95 at most 8 ms |
| Main-thread request packing and publication for one worker-owned task, p95 |                        at most 1 ms each |            at most 2 ms each |
| Select All and aggregate-frame publication for 5,000 elements              |                 p95 at most 100 ms total |     p95 at most 250 ms total |
| Whole-note lasso classification and atomic selection for 5,000 elements    |                 p95 at most 150 ms total |     p95 at most 400 ms total |
| Geometry commit or undo for a 5,000-member aggregate transform             |                 p95 at most 200 ms total |     p95 at most 500 ms total |
| Annotation recovery preparation plus durable host-recorded transition      |                        p95 at most 75 ms |           p95 at most 200 ms |
| Cold 5,000-element note open to full mutation readiness                    |                       p95 at most 750 ms |         p95 at most 1,500 ms |
| Cold full-scene encoding of the 5,000-element fixture, excluding Vault I/O |                       p95 at most 250 ms |           p95 at most 600 ms |
| Small internal-edit anchor reflow                                          |                        p95 at most 50 ms |           p95 at most 120 ms |
| Single-element binding inference                                           |                         p95 at most 8 ms |            p95 at most 12 ms |
| Single affected range or enclosure projection                              |                         p95 at most 8 ms |            p95 at most 12 ms |
| Full external reattachment completion                                      |                          p95 at most 2 s |              p95 at most 5 s |
| View detach and plugin unload work                                         |                        p95 at most 50 ms |           p95 at most 100 ms |
| Stable heap after 50 open-close cycles                                     | at most 5 MiB above post-warmup baseline | at most 5 MiB above baseline |
| Peak additional heap for a 16 MiB sidecar load                             |                          at most 160 MiB |              at most 160 MiB |
| Steady additional heap for the 5,000-element fixture in one pane           |                           at most 64 MiB |               at most 48 MiB |

The standard 10,000-element stress tier MUST pass these predeclared end-to-end duration budgets. For a presented-frame row, `F` is the measured refresh interval of the named device and display configuration. The separate main-thread work budgets remain 8 ms for desktop or tablet and 12 ms for mobile under [SVG Rendering](06-svg-rendering.md); they MUST NOT be substituted for presentation latency.

| Stable row ID                     | Scenario                                                                                                  |                        Desktop or tablet p95 / p99 / maximum |                                    Mobile p95 / p99 / maximum |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | -----------------------------------------------------------: | ------------------------------------------------------------: |
| `PERF-10K-OPEN`                   | Cold note open to full mutation readiness                                                                 |                                     1,500 / 2,250 / 3,000 ms |                                      3,000 / 4,500 / 6,000 ms |
| `PERF-10K-SELECT`                 | Select All and aggregate-frame publication                                                                |                                           200 / 300 / 400 ms |                                          500 / 750 / 1,000 ms |
| `PERF-10K-LASSO`                  | Whole-note lasso classification and atomic selection                                                      |                                           300 / 450 / 600 ms |                                        800 / 1,200 / 1,600 ms |
| `PERF-10K-AGGREGATE-COMMIT`       | 10,000-member aggregate geometry commit, undo, or redo                                                    |                                           400 / 600 / 800 ms |                                      1,000 / 1,500 / 2,000 ms |
| `PERF-10K-RECOVERY`               | Annotation recovery preparation plus durable host-recorded transition                                     |                                            75 / 125 / 250 ms |                                            200 / 350 / 700 ms |
| `PERF-10K-ENCODE`                 | Cold full-scene encoding, excluding Vault I/O                                                             |                                         500 / 750 / 1,000 ms |                                      1,200 / 1,800 / 2,400 ms |
| `PERF-10K-PARSE`                  | Cold 16 MiB sidecar tokenize, validate, and decode                                                        |                                         600 / 900 / 1,200 ms |                                      1,600 / 2,400 / 3,200 ms |
| `PERF-10K-FIRST-OVERLAY`          | Warm sidecar to first truthful visible overlay                                                            |                                           300 / 450 / 600 ms |                                        750 / 1,125 / 1,500 ms |
| `PERF-10K-DRAW-PRESENT`           | Drawing input to presented preview                                                                        |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-SELECT-PRESENT`         | Single-object selection to presented chrome                                                               |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-RESIZE-PRESENT`         | Single-object resize input to presented preview                                                           |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-TABLE-PRESENT`          | Table-divider input to presented preview                                                                  |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-AXIS-PRESENT`           | Axis-length input to presented preview                                                                    |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-AGGREGATE-PRESENT`      | Aggregate resize input to presented preview, with or without pressure Pens                                | `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` / `max(66.8 ms, 4F)` | `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` / `max(100.2 ms, 4F)` |
| `PERF-10K-VIEW-FRAME`             | Scroll, pure zoom, or culling main-thread frame work                                                      |                                             8 / 12 / 16.6 ms |                                             12 / 16 / 16.6 ms |
| `PERF-10K-VIEW-PRESENT`           | Scroll, pure zoom, or culling to next presented frame                                                     |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-PAINT`                  | Browser paint plus compositor duration for an interaction frame, where exposed                            |                                       `0.5F` / `0.75F` / `F` |                                        `0.5F` / `0.75F` / `F` |
| `PERF-10K-DROPPED`                | Dropped frames per 10-second drawing, scroll, or zoom run                                                 |                                             0 / 1 / 2 frames |                                              1 / 2 / 4 frames |
| `PERF-10K-HIT`                    | Single geometry-aware hit test                                                                            |                                                 4 / 6 / 8 ms |                                                8 / 12 / 16 ms |
| `PERF-10K-BACKGROUND`             | Visible background-region derivation and publication                                                      |                                             50 / 75 / 100 ms |                                            120 / 180 / 240 ms |
| `PERF-10K-INFERENCE`              | Single-element binding inference                                                                          |                                               8 / 12 / 16 ms |                                               12 / 18 / 24 ms |
| `PERF-10K-RANGE`                  | Single affected text-range projection                                                                     |                                               8 / 12 / 16 ms |                                               12 / 18 / 24 ms |
| `PERF-10K-ENCLOSURE`              | Single affected enclosure projection                                                                      |                                               8 / 12 / 16 ms |                                               12 / 18 / 24 ms |
| `PERF-10K-REFLOW`                 | Small internal-edit anchor reflow to current projection                                                   |                                             50 / 75 / 100 ms |                                            120 / 180 / 240 ms |
| `PERF-10K-SAVE-WARM`              | Warm one-element save acknowledgement including Vault I/O                                                 |                                           250 / 375 / 500 ms |                                        750 / 1,125 / 1,500 ms |
| `PERF-10K-SAVE-BULK`              | 10,000-member bulk-transform save acknowledgement including Vault I/O                                     |                                       750 / 1,125 / 1,500 ms |                                      1,800 / 2,700 / 3,600 ms |
| `PERF-10K-CHECKPOINT-FORCED`      | Source checkpoint from forced barrier to durable acknowledgement                                          |                                           100 / 150 / 200 ms |                                            250 / 375 / 500 ms |
| `PERF-10K-CHECKPOINT-NORMAL`      | Normal source checkpoint from first dirty generation to durable acknowledgement                           |                                           200 / 300 / 500 ms |                                            350 / 475 / 500 ms |
| `PERF-10K-CHECKPOINT-FORCED-WAIT` | Forced source-checkpoint queue wait                                                                       |                                              20 / 40 / 80 ms |                                             50 / 100 / 200 ms |
| `PERF-10K-CHECKPOINT-NORMAL-WAIT` | Normal source-checkpoint debounce and queue wait                                                          |                                           120 / 200 / 300 ms |                                            200 / 300 / 350 ms |
| `PERF-10K-CHECKPOINT-MAP`         | Source-checkpoint mapping composition                                                                     |                                              10 / 20 / 40 ms |                                              25 / 50 / 100 ms |
| `PERF-10K-CHECKPOINT-DIGEST`      | Source-checkpoint digest work                                                                             |                                              20 / 40 / 80 ms |                                             50 / 100 / 200 ms |
| `PERF-10K-CHECKPOINT-APPEND`      | Source-checkpoint `RecoveryStore` append                                                                  |                                             30 / 50 / 100 ms |                                             75 / 150 / 250 ms |
| `PERF-10K-CHECKPOINT-PUBLISH`     | Source-checkpoint acknowledgement to first durable publication                                            |                                                4 / 8 / 16 ms |                                                8 / 16 / 32 ms |
| `PERF-10K-TEARDOWN`               | Synchronous view-resource detach or plugin-unload teardown, excluding a recovery-protected headless flush |                                             50 / 75 / 100 ms |                                            100 / 150 / 200 ms |

For the same tier, steady additional heap in one pane is at most 96 MiB on desktop or tablet and 72 MiB on mobile. Peak additional heap during any listed stress operation is at most 192 MiB and 160 MiB respectively. Steady heap is the maximum of five post-GC measurements after full mutation readiness; peak heap includes workers and transferable staging owned by the plugin. Every percentile-gated scenario uses at least 5 warmup samples followed by at least 100 measured samples per fixture and compatibility cell. Percentiles use the nearest-rank method and maximum is the largest measured value. Before a release-candidate run begins, the device matrix, fixture digests, thresholds, warmup, sample count, and measurement procedure are frozen in the versioned benchmark manifest. A missing threshold or a threshold changed after observing the run fails the stress gate.

Forced checkpoint barriers bypass the idle debounce and use the Forced queue-wait row. Normal checkpoints use the Normal debounce-and-queue row. Both scenarios use the common Mapping composition, Digest work, `RecoveryStore` append, and Acknowledgement to first durable publication rows while also enforcing their respective end-to-end row. All phase and end-to-end gates are conjunctive; phase percentiles are not added to derive an end-to-end percentile. The 500 ms normal-path maximum is measured from the first dirty source generation and is absolute. The asynchronous last-view checkpoint flush is separate from synchronous detach and uses the two-second hard maximum in [Architecture](04-architecture.md).

Every named 10,000-element harness phase maps explicitly to a stable table-row ID. Generic `input-to-preview` uses `PERF-10K-DRAW-PRESENT` unless `PERF-10K-RESIZE-PRESENT`, `PERF-10K-TABLE-PRESENT`, `PERF-10K-AXIS-PRESENT`, or `PERF-10K-AGGREGATE-PRESENT` applies. Selection, view work, paint, dropped frames, hit testing, background, binding, projection, reflow, save, source-checkpoint, and teardown metrics use their corresponding explicit `PERF-10K-*` row above. Aggregate commit, Undo, and Redo use `PERF-10K-AGGREGATE-COMMIT` and additionally enforce the end-to-end `PERF-10K-RECOVERY` row. Sidecar parse uses `PERF-10K-PARSE`, first overlay `PERF-10K-FIRST-OVERLAY`, full mutation readiness `PERF-10K-OPEN`, and unload cleanup `PERF-10K-TEARDOWN`. Name matching or an unmapped component timing is forbidden. Measuring a phase without its referenced stable row ID and p95, p99, and maximum gate does not satisfy the stress tier.

The full external reattachment path MUST yield a first visible progress state within 100 ms. Frame work at refresh interval `F` is additionally limited to 80 percent of `F`; the tighter of that value and the platform target in [SVG Rendering](06-svg-rendering.md) applies.

Binding benchmarks separately record candidate counts, classification time, range-fragment projection time, enclosure projection time, affected-element count, and discarded stale generations. Pure note zoom MUST record zero classification calls, zero canonical publications, zero history entries, and zero sidecar generations. Width reflow MUST record zero canonical geometry rewrites.

Background benchmarks separately record mounted rhythm regions, inspected source line boxes, derivation slices, discarded stale generations, measurement time, and region-publication time. Scroll work MUST remain proportional to entering and leaving visible regions, not complete document length. A pure zoom with unchanged host layout records zero background remeasurement calls.

Performance measurements MUST report p50, p95, p99, maximum, sample count, warmup, variance, affected-element count, spatial-index candidates and mutations, allocation volume, mounted-node changes, canonical publication count, editor-extension update and projection-request count, forced deferred loads, framework root and commit count, postprocessor callback and duplicate-overlay count, next-presented-frame latency, dropped-frame count, and browser paint plus compositor duration where the host exposes them. Averages alone are insufficient. Fixed sleeps are forbidden in automated performance tests. No plugin-owned task may occupy the main thread continuously for 50 ms or longer during startup, note open, active input, rebuild, background processing, or unload.

Progressive rendering records time to first truthful visible projection, hit-test readiness, and full mutation readiness. Every supported 5,000-element fixture MUST return to full interactivity within the applicable initial budget, and every 10,000-element fixture within the predeclared stress table above. A permanently progressive read-only state is not a passing capacity result. An intentionally adversarial scene that violates an independent DOM-node or path-command ceiling is a resource-limit test, not evidence that a supported capacity fixture passed.

## 6. Resource Efficiency

The implementation MUST bound:

- sidecar size and parser nesting;
- element, point, group, table, and axis-grid counts;
- anchor search windows and context lengths;
- spatial-index candidates and overscan;
- mounted SVG nodes;
- background rhythm regions and source line boxes per view;
- geometry caches;
- save generations and recovery journal bytes;
- clipboard payloads;
- conflict copies and diagnostics;
- observers, workers, timers, and subscriptions per view.
- editor plugin values, Reading View children, postprocessor generations, framework roots, pop-out rebinding resources, and deferred-view reveal requests.

Worker count, queued jobs, queued bytes, transferred bytes, detached buffers, retry count, and per-priority latency are bounded and observable. The scheduler admits at most 64 queued jobs and 16 MiB of plugin-owned queued payloads across all workers; replacement of stale view work occurs before rejecting new current work. It has one replaceable latest job per revision-superseded view-work kind and a finite FIFO for non-replaceable recovery or persistence work. Admission fails before mutation when a required job cannot fit its queue or byte budget.

Annotation history payloads use compact immutable revision-free patch pairs keyed by stable history-entry IDs and structural sharing. Fresh dispatch and recovery envelopes are retained only for their current direction attempt. The release probe records every byte retained by history entries, dispatch records, recovery attempts, and host-held effects, proves that host branching and view disposal release unreachable payloads, and keeps the 5,000- and 10,000-element history fixtures within 32 MiB per editable pane. An effect MUST remain fully actionable while the host exposes it as undoable or redoable; an external cache eviction MUST NOT leave a dangling handle. If the tested host cannot provide bounded retention and reliable disposal without replacing its history, unified history is unsupported and annotation mutation fails closed under the Phase 0 gate. Shared geometry caches are limited to 8 MiB per note session, view-local caches to 8 MiB per view, and all plugin caches to 48 MiB total with least-recently-used eviction.

Admission MUST fail before canonical mutation when the result cannot remain within a hard limit.

The standard long-note viewport MUST remain within 250 individual element projections, 4,000 mounted SVG DOM nodes, and 100,000 path commands under the exact counting rules in [SVG Rendering](06-svg-rendering.md). The benchmark records individual projections, aggregated sources, DOM nodes, and path commands and fails when an applicable limit is exceeded.

## 7. Security and Privacy

### 7.1 Threat Model

Protected assets are native Markdown integrity, annotation and anchor integrity, acknowledged recovery, host-history ordering, validated Vault path identity, plugin settings, user clipboard boundaries, interaction availability, and bounded host resources. Inkbook provides no confidentiality boundary against Obsidian itself, the operating system account, a malicious plugin with equivalent Vault or DOM access, or a user who opens sidecar content directly. It MUST still avoid exposing note content through its own diagnostics, network, logs, error details, or cross-note confusion.

Relevant threat actors and failure sources are:

- a malformed, stale, synchronized, or adversarial Markdown, YAML, sidecar, settings, recovery, or clipboard record;
- another local plugin or theme that changes DOM, CSS, files, events, or timing within host-granted access;
- accidental concurrent edits, rename or delete races, duplicated events, stale workers, replayed commands, crashes, quota loss, and partial host operations;
- a user gesture or accessibility sequence misclassified across native Markdown and plugin-owned targets;
- a compromised dependency or release artifact.

The enforced trust boundaries are:

| Boundary                     | Untrusted input                                     | Required control                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault and YAML adapter       | Paths, file kinds, file text, events, locators      | Capability-bound `TFile` or `TFolder`, normalized allowlisted paths, host-object identity and base revalidation, compare-and-swap, bounded scans only after explicit action |
| Sidecar and clipboard codecs | JSON tokens, numbers, strings, references, versions | Streaming limits, closed schemas, finite values, duplicate-key rejection, reference closure, aggregate limits, immutable construction only after full validation            |
| Editor and Reading View      | Transactions, viewport, DOM, source evidence, mode  | One guarded adapter, revision tokens, documented source evidence, viewport bounds, safe degradation, no DOM-order authority                                                 |
| Worker scheduler             | Requests, responses, buffers, timing                | Versioned messages, byte and job admission, transfer ownership, canonical-buffer non-detachment, cancellation, stale-result rejection, crash cleanup                        |
| Recovery and history         | Effects, attempts, epochs, replay, quota            | Transactional IndexedDB, exact lifecycle and revision checks, one owner lease, bounded retention, durable direction before publication, fail-closed exhaustion              |
| UI, theme, and diagnostics   | Labels, CSS tokens, focus, errors                   | Safe DOM and SVG APIs, closed paint allowlists, namespaced CSS, no authored markup sinks, redaction, accessible non-color state                                             |
| Build and dependencies       | Transitive code and package artifacts               | Lockfile, license and provenance records, audit, architecture checks, mobile-bundle scan, immutable release validation                                                      |

Security invariants are fail closed before mutation: a path never escapes the Vault policy, an unknown or over-limit record never reaches scene construction, stale work never publishes, a failed recovery admission never reaches history or scene, external file conflict never uses silent last-writer-wins, and an unsupported host capability never falls back to private or broader access. Runtime production code performs no network request, remote code load, telemetry, tracking, or secret storage. Security checks MUST NOT be disabled to recover performance.

Residual risks that cannot be eliminated by this plugin are host API changes, equivalent-access local plugins, operating-system or synchronization failures, and platform storage eviction. The compatibility matrix, drift and conflict UI, recovery probes, provenance review, and truthful read-only modes reduce but do not claim to eliminate those risks.

### 7.2 Verification and Data Minimization

Inkbook processes only Vault-local note, sidecar, settings, and recovery data. Runtime annotation behavior requires no network access, telemetry, tracking, profiling, advertisements, third-party scripts, remote fonts, or cloud service. Host-managed Community installation and updates are distribution transport, not permission for Inkbook runtime networking.

Security tests MUST cover malicious JSON, huge numbers, deep nesting, duplicate IDs, invalid references, path confusion, `TAbstractFile` confusion, rename races, clipboard abuse, SVG and CSS injection attempts, unsafe HTML sinks, global-host escape attempts, stale revisions, sidecar conflicts, and replayed operation identities.

Security-relevant changes require an updated threat-boundary and abuse-case review covering assets, attackers, trust boundaries, data flows, replay, races, and resource exhaustion. SHA-256 MUST use an established platform cryptographic API; custom cryptography is forbidden.

Diagnostics MUST redact Markdown text, YAML values, anchor context, element geometry, file contents, and absolute system paths by default. Errors shown to users MUST not expose internal stack traces or sensitive paths.

## 8. Accessibility

The production UI MUST target WCAG 2.2 AA within the host constraints. Normal text contrast is at least 4.5:1, large text is at least 3:1, and essential non-text component boundaries, focus indicators, selection indicators, and graphical objects are at least 3:1 against adjacent colors. Automated checks are necessary but not sufficient. The finite release theme matrix contains Obsidian's default light theme, default dark theme, and host forced-colors or high-contrast mode where the matrix platform exposes it. Third-party themes are supported through documented Obsidian semantic tokens but are not individually certified. Manual acceptance MUST cover keyboard-only use, screen-reader naming and state, 200 percent application zoom, that finite theme matrix, reduced motion, touch targets, software keyboard access, and focus restoration.

The SVG scene itself is not a substitute for semantic toolbar controls. Selected objects MUST be representable through an accessible selection summary and actionable controls even when every geometry detail cannot be narrated.

## 9. Dependency Policy

Dependencies require a concrete benefit, active maintenance, compatible license, mobile compatibility, and acceptable bundle cost. The implementation SHOULD prefer Obsidian, CodeMirror, browser, and small focused utilities already present before adding a framework.

Every Obsidian import is recorded with its first supported host version. A dependency that makes `isDesktopOnly: false` untrue is forbidden. Release validation evaluates the bundled transitive graph, not only authored imports.

The adjacent `obsidian_ink` checkout is excluded evidence. Its source, source-level summaries, identifiers, algorithms, fixtures, assets, and build details MUST NOT enter specification or production implementation work. The separated process in [Clean-Room Implementation](../decisions/0001-clean-room-implementation.md) and [Architecture](04-architecture.md) is mandatory, and its provenance plus isolation records are release artifacts. Any future proposal to change this boundary requires a new reviewed ADR and compatible legal decision before the material is accessed or used.

## 10. Release Definition of Done

A phase or release is complete only when its requested behavior, architecture, code quality, security, privacy, accessibility, performance, resource, documentation, and test requirements are satisfied by the simplest suitable implementation. Every completion report lists changed surfaces, checks actually executed, results, checks not executed with reasons, residual risks, and unresolved uncertainty. Partial or unverified work MUST NOT be reported as complete.

Before public distribution, the project records a factual applicability assessment based on current official primary sources for GDPR, TDDDG, DDG, BFSG, BFSGV, the EU AI Act, consumer and e-commerce rules, and required legal notices. Inapplicable areas require a concrete rationale based on the actual local-only product, distribution, operator role, target market, business model, and data flows. Missing facts block a compliance claim rather than being invented.

Public release additionally requires the package, manifest, mobile, documentation, policy, licensing, directory, version-fallback, and artifact rules in [Obsidian Host Contract](14-obsidian-host-contract.md). No completion report may claim Community compatibility from compilation alone.
