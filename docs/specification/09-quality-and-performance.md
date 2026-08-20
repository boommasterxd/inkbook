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

The project uses a rolling-current toolchain and dependency policy. Every newly added dependency starts at the newest stable release that is mutually compatible with the supported Obsidian and Android runtime. Dependabot proposes npm and GitHub Actions updates weekly. Prereleases are excluded unless a separate accepted decision requires one. `package.json` uses maintained semantic-version ranges, the npm-generated lockfile records the exact reviewed graph, and CI and release builds use `npm ci`. Supply-chain-sensitive CI actions use reviewed immutable commit digests that Dependabot updates. A published plugin never fetches or updates executable dependencies at runtime.

Relevant behavior changes require deterministic executable tests in the same change. Bug fixes require regression tests. Every behavior, invariant, limit, failure path, race, and lifecycle rule that can be driven or observed through code MUST have automated coverage at the lowest faithful layer. Tests observe public behavior, cover normal, boundary, failure, security-abuse, race, cancellation, recovery, disposal, and misuse cases, and MUST NOT rely on fixed waits. State-machine behavior uses model-based or transition-table tests where that exposes invalid sequences more clearly than example-only tests. Property and fuzz suites use recorded seeds and replayable minimized failures. The `test/` tree mirrors the production source structure.

Automated asynchronous tests use injected monotonic clocks and controlled timers, microtasks, animation frames, idle callbacks, worker responses, Vault acknowledgements, host transactions, lifecycle events, and admissible event-order schedules. Simulated Obsidian, CodeMirror, browser, storage, worker, and device capabilities MUST model available, unavailable, malformed, throwing, delayed, stale, and disposed states. No uncontrolled wall-clock race or written manual procedure may substitute for this executable coverage.

Technical documentation and source comments are concise English. Public interfaces, configuration, operations, security boundaries, and non-obvious tradeoffs are documented. Comments explain reasons or constraints rather than restating code. Stale commented-out code and unbounded TODO or FIXME markers are forbidden. Durable non-obvious architecture decisions are recorded as English ADRs under `docs/decisions/` before the owning implementation phase exits.

## 2. Required Quality Lanes

The project uses the three cumulative quality lanes below. A later lane includes every applicable earlier gate and MUST NOT waive it.

### 2.1 Per-Commit CI

Every production or documentation change MUST pass all applicable deterministic gates:

1. formatting and linting with size, complexity, parameter, and nesting rules as errors;
2. strict TypeScript type checking without unchecked boundary casts;
3. deterministic unit and integration tests;
4. at least 85 percent line coverage over production sources;
5. duplication detection using `jscpd` with `minTokens: 50` and at most 5 percent duplicated lines;
6. dead-code and unused-export detection using `knip` or a proven equivalent;
7. dependency auditing with no unresolved critical or high vulnerability;
8. architecture-boundary checking and a successful production build.

When their corresponding implementation exists, the lane also includes deterministic host-fake and CodeMirror integration, browser and SVG simulation, model and property suites, fault and race orchestration, lifecycle and disposal checks, machine-observable accessibility assertions, package inspection, structural performance assertions, synthetic workload benchmarks, and available host or device automation that is necessary to observe the implemented behavior. These checks extend the existing test and CI commands. Placeholder evidence files, requirement inventories, written procedures, and speculative runner scaffolds do not satisfy a gate.

### 2.2 Phase-Exit Validation

Before an implementation phase exits, `npm run ci` MUST pass every applicable unit, property, model, fuzz, integration, Obsidian-host, browser, performance, accessibility, fault-injection, migration, and lifecycle check assigned to that phase in [Implementation Roadmap](11-implementation-roadmap.md). Product-specific commands join that entry point only when an implemented workflow cannot fit an existing suite. Verification runs without user-entered measurements or repeated user-driven compatibility cells. Normal test output and direct inspection of the tested production artifact are sufficient; no generated result model is required.

After the complete automated lane passes, the phase has exactly one concise human sanity scenario for the newly visible workflow. The scenario uses one representative user-available environment, contains at most three short actions and one observable pass or fail outcome, and requires no manual timing, heap reading, digest calculation, version inventory, log inspection, database inspection, or compatibility matrix. A phase with no new visible surface uses one no-regression smoke scenario. This check supplements automation and MUST NOT validate internal correctness, performance budgets, fault handling, platform coverage, or accessibility conformance. A phase MUST NOT claim an untested dependent feature complete.

### 2.3 Release Validation

A release candidate repeats Per-Commit CI and every applicable product suite against the exact release artifact. Host, simulator, emulator, or instrumented-device execution is added only when a stable control surface exists and a required claim cannot be established at a simpler layer. The lane additionally validates tag-version equality, `versions.json` when the minimum version changed, supported desktop and Android behavior, 5,000-element capacity, 10,000-element stress, packaging, licensing, accessibility, security, privacy, and Community directory requirements. Publication approval remains a deliberate owner action and is not test evidence.

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

Reusable components SHOULD be small and purpose-specific. Shared controls such as color, width, independent outline and fill opacity, caps, dash, fill, menu, slider, and segmented choice belong in a toolbar component library. Domain operations, geometry, input routing, and Obsidian adapters MUST not be folded into UI components for convenience.

## 4. Performance Workload

The long-note benchmark fixture contains at least:

- 100,000 Markdown characters;
- 10,000 annotation elements, each with exactly one valid binding;
- at least 2,000 text-following elements distributed across text-range and text-position bindings, with the remaining elements using a deterministic mix that includes fixed bindings;
- 250,000 total stroke points;
- 200,000 note CSS pixels of scrollable height;
- mixed strokes, highlighters, shapes, free and attached Lines or Arrows, axes, and tables;
- offscreen, selected, degraded, and orphaned elements.

The minimum supported interactive-capacity tier is 5,000 canonical annotation elements in one note on every supported release device. The 10,000-element workload is the standard release stress gate, not a parser-limit claim. Both tiers contain dispersed and dense visible-cluster variants, are generated deterministically, have recorded digests and encoded byte sizes, and MUST be valid under every simultaneous sidecar limit. Parser abuse ceilings above these tiers do not imply interactive performance.

Performance verification uses the smallest faithful form for each implemented path:

1. deterministic structural and simulated-interaction assertions in the normal unit or integration suite for visited records, candidate counts, allocations, publications, index mutations, local queue depth, owner counts, mounted nodes, path commands, React commits, disposal, frame scheduling, cancellation, priority, stale delivery, and sliced fallback;
2. focused microbenchmarks beside the owning algorithm only when structural bounds cannot catch a meaningful regression;
3. calibrated host or device automation only for claims that inherently depend on actual wall-clock latency, presentation, paint, dropped frames, cold parse or evaluation, real heap, native touch arbitration, Android WebView behavior, or thermal effects.

Routine phase development runs every applicable structural, simulation, and microbenchmark check through the existing CI entry point without user action. Physical automation runs only when a stable controllable target exists and the implemented behavior requires it. A simulation MUST NOT be reported as proof of physical-device duration, presentation, paint, dropped frames, memory, touch-driver, thermal, or assistive-technology behavior. If an absolute physical-device claim cannot be automated, only that claim remains explicitly unverified until suitable automation exists or the requirement is narrowed. This does not authorize a recurring user procedure or speculative automation framework.

Performance fixtures, thresholds, warmups, sample counts, and deterministic counters live as compact constants beside the executable tests that use them. Large checked-in fixture copies, separate profile schemas, evidence frameworks, generated manifests, result validators, and runner hierarchies are forbidden unless an implemented cross-process workflow cannot use normal test output or direct package inspection. A later change may tighten a threshold or add coverage. Relaxing a threshold requires a reviewed specification change made before a failing run is observed and MUST NOT make an already observed failure pass retrospectively.

Every countable performance invariant is an executable assertion backed by stable low-overhead instrumentation. Synthetic fixtures and schedules are generated deterministically and replayably. Shared-machine wall-clock results are diagnostic unless the machine is controlled sufficiently for a strict duration gate.

## 5. Performance Gates

The frame and latency budgets in [SVG Rendering](06-svg-rendering.md) are release gates after calibration. Regression checks MUST additionally verify:

- viewport culling mounts no more than the documented bounded set for the standard long-note viewport;
- scroll and zoom work is proportional to viewport candidates, not all 10,000 elements;
- the annotation-aware bottom scroll extent uses one bounded current-entry maximum aggregate per concrete view, updates only affected paint-bound entries, never scans the scene or mounted DOM, and never forces offscreen SVG or Markdown to mount;
- an active gesture that extends the reachable bottom performs at most one extent-carrier write per animation frame and only when the outward-rounded value changes, with zero React note-root commits, synchronous read-after-write layout cycles, canonical publications, history effects, recovery attempts, or sidecar generations;
- selecting or resizing one visible element performs work proportional to that element and bounded nearby candidates, never all scene elements;
- one-element canonical publication path-copies only persistent runtime-store branches, visits no unrelated element or Group record, allocates no flat scene-array spine, and materializes flat ordering only at a bounded codec boundary;
- dragging or reconnecting one Line or Arrow endpoint queries only bounded spatial-index candidates inside the snap tolerance, projects only their stable ports, and updates attachment dependents through the reverse index, never through a complete-scene scan;
- a single geometry resize preserves the style record and invalidates only affected geometry, paint bounds, selection geometry, spatial-index entries, and geometry-dependent caches;
- aggregate resize preview uses one transient group transform for compatible mounted projections and one coalesced worker batch only for mounted pressure-stroke level-of-detail outlines; it never regenerates offscreen member paths, Table dividers, axes guides, or canonical samples for each pointer event;
- aggregate commit work is proportional to selected members, publishes atomically, and never rebuilds the complete scene or spatial index;
- Markdown reflow updates affected anchor transforms without rebuilding unrelated stroke paths;
- binding inference runs only after a completed creation gesture, a destination move of a non-fixed element, or an explicit rebind request, never for movement of a fixed element, never after resize or rotation, and never on pointer movement, scroll, pure note zoom, or every layout frame;
- binding candidate lookup is proportional to bounded nearby text-layout candidates rather than the complete Markdown document;
- width-induced reflow updates only affected text-position transforms, text-range fragments, enclosing regions, bounds, and spatial-index entries;
- two panes with different widths share canonical geometry and bindings but retain independent bounded projection caches;
- secondary-button pan while zoomed changes only the shared view transform and never annotation selection, canonical state, history, or sidecar work;
- native one-finger pan while zoomed remains on the host scroll surface, updates horizontal and vertical view matrices only for available ranges, and causes no Inkbook pointer capture, non-passive one-contact listener, annotation selection, canonical publication, history, recovery, or sidecar work;
- selection-move edge autoscroll owns at most one animation-frame request and one latest pointer sample per active view, performs at most one clamped vertical host-scroll write plus one coalesced retained projection update per frame, and performs no synchronous read-after-write layout cycle, complete-scene scan, offscreen mount, worker admission, timer, React note-root commit, or intermediate canonical publication;
- pointer movement causes no canonical scene publication and at most one scheduled render per frame;
- pointer movement, scroll, pure zoom, culling, retained-node updates, selection chrome, and worker progress cause zero React note-root commits and zero per-element React renders;
- a tool, style, selection-summary, or toolbar-visibility change causes at most one batched React commit for only the subscribed toolbar, stylebar, persistent visibility-toggle, menu, or status subtree; collapsing and expanding never recreate the view's framework root or overlay;
- listener callbacks, worker completions, and attached-view updates never re-enter canonical publication synchronously; bursts are serialized and revision-coalesced without recursive render or command cascades;
- one completed gesture causes one operation, one isolated invertible event in the originating host history, and one coalescible save generation;
- native Markdown transaction bursts compose into at most one active and one replaceable latest source-checkpoint write, materialize no per-element anchor array on the editor update path, and cause one coalescible sidecar generation, with no annotation effect event and no view-only reflow checkpoint;
- a durable source checkpoint maps affected canonical anchors without eagerly rewriting every actionable history entry; one later Undo or Redo materializes only its requested entry through the bounded composed-map graph;
- a 100,000-point interactive stroke and a 200,000-point imported stroke never trigger quadratic reconstruction;
- final binding inference for a 100,000-point gesture consumes incrementally accumulated evidence and does not rescan all samples at pointer up;
- maximum Tables and axes use bounded composed paths and remain inside the documented projection, DOM-node, path-command, and frame-work budgets;
- a target transform with the maximum 1,024 attached endpoints updates only reverse-indexed visible dependents during preview and completes offscreen materialization in one bounded atomic commit;
- a 5,000-element Paste validates, remaps, infers bindings from one shared immutable layout index, and publishes through bounded worker chunks without one independent full candidate scan per element;
- spatial queries, whole-note lasso, Select All, multi-selection style aggregation, and bulk-transform preparation run in cancellable slices of at most 4 ms and never expose partial canonical state;
- every DOM-independent phase admitted by `WORKER_ADMISSION_V1` below is worker-first on a conforming worker platform;
- worker messages use bounded packed or transferable data, stale low-priority work is cancelled, queue length is bounded, and worker overhead is measured separately from useful computation;
- concurrent sessions, panes, worker generations, and persistence pipelines remain inside their explicit local count and byte limits, and resource pressure never drops dirty or actionable state;
- bulk selection uses one bounded aggregate control frame rather than one handle set per selected element;
- next and previous annotation selection use the cached selectable-order index and current spatial index, perform no scene-wide scan or offscreen mount, and publish only the selected ID plus bounded reveal work;
- background rendering performs constant work per mounted rhythm region, remains proportional to bounded visible body-text regions rather than complete document length, and recomputes metrics only when the host-layout token changes, never for every scroll or pure-zoom frame;
- sidecar-location migration runs only after explicit user admission, enumerates and migrates in bounded yielding batches, and performs no Vault scan, path derivation, or file move during startup or ordinary note input;
- geometry cache use stays within 8 MiB per view under the standard workload;
- every cache, scroll-extent aggregate and carrier, observer, worker, timer, pointer capture, and session is released after view close and plugin unload;
- editor-extension registration occurs once, each concrete editor creates and destroys exactly one plugin value, update bursts produce at most one current projection request per animation frame, and offscreen Markdown is never forced to mount;
- passive workspace discovery causes zero deferred-view loads, while an explicit user command records and bounds every required reveal or compatibility load;
- Reading View reprocessing replaces only the affected section generation and creates no duplicate whole-note overlay, observer, or background region;
- migration between the main window and a desktop pop-out releases old-window listeners, observers, animation frames, framework roots, and SVG ownership before binding the new owner window;
- coarse UI framework root count remains proportional to attached view and settings surfaces, and every root unmounts with its `Component` owner.

A conforming worker platform is a supported environment whose Phase 0 production worker probe passes launch, transfer, cancellation, crash, and disposal. `WORKER_ADMISSION_V1` MUST apply when any threshold in a row is met:

| Operation family                                                                     | Worker admission threshold                                                   |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Sidecar tokenize, validation, decode, encode, migration, or SHA-256                  | At least 512 KiB encoded or decoded input                                    |
| Pressure outline or stroke level of detail                                           | At least 4,096 canonical samples                                             |
| Bulk bounds, spatial-index build, large spatial query, lasso, or aggregate transform | At least 1,000 candidate or affected elements                                |
| Clipboard encode, decode, validate, or remap                                         | At least 256 KiB payload or 1,000 elements                                   |
| Anchor materialization, external reattachment, or binding inference                  | At least 128 ranked candidates, 256 source blocks, or 512 rendered fragments |
| Reflow or background-region derivation                                               | At least 256 affected elements, fragments, source line boxes, or regions     |

An admitted phase runs in the worker on a conforming environment. On an environment whose Phase 0 worker probe fails, or after a worker crash, the identical pure phase uses the specified cancellable 2 ms active or 4 ms idle main-thread slices and remains fail-closed if its queue or memory bound cannot be met. Below all listed thresholds, measured main-thread work is permitted only while it stays inside the same slicing and frame budgets. Benchmark versions and thresholds are fixed in the executable suite and cannot change after observing a release-candidate run. Simulated worker and fallback tests control their clock, task queue, frame delivery, cancellation acknowledgement, crash point, response ordering, and resource-release events deterministically.

The following additional initial budgets MUST pass:

| Scenario                                                                   |                Desktop or Android tablet |                Android phone |
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

Every stable `PERF-10K-X` row below also owns the stable `PERF-5K-X` row with the same scenario, p99, and maximum. Its p95 equals the 10,000-element p95 unless this table provides the stricter V1 override: `OPEN` 750/1,500 ms, `SELECT` 100/250 ms, `LASSO` 150/400 ms, `AGGREGATE-COMMIT` 200/500 ms, `ENCODE` 250/600 ms, `REFLOW` 50/120 ms, `INFERENCE` 8/12 ms, `RANGE` 8/12 ms, and `TEARDOWN` 50/100 ms, with desktop or Android tablet first and Android phone second. `PERF-5K-HIT` uses the p95 in the table above. All other 5K stable rows use their corresponding 10K limits unchanged. This ID transformation is normative; name-based fallback remains forbidden.

The following package limits apply to the exact production package before `onload()` instrumentation begins:

| Artifact or cold-load phase                                      | Desktop or Android tablet | Android phone |
| ---------------------------------------------------------------- | ------------------------: | ------------: |
| Raw `main.js`, embedded worker included                          |                     2 MiB |         2 MiB |
| Gzip-compressed `main.js`                                        |                   512 KiB |       512 KiB |
| Extracted raw embedded-worker payload, also counted in `main.js` |                   768 KiB |       768 KiB |
| Raw / gzip-compressed `styles.css`                               |              128 / 32 KiB |  128 / 32 KiB |
| Module and CSS parse, compile, and top-level evaluation, p95     |                     50 ms |        100 ms |
| Immediately before host load through settled `onload()`, p95     |                    100 ms |        200 ms |
| Peak additional heap over that complete cold boundary            |                    32 MiB |        24 MiB |

Raw and compressed byte checks are deterministic CI gates. Automated calibrated runtime targets separately report module parse or evaluation, CSS work where exposed, and `onload()`, and fail if only the method-local timing passes. A named physical matrix is required only for claims that depend on physical hardware, and its execution is orchestrated rather than delegated to the user.

The standard 10,000-element stress tier MUST pass these predeclared end-to-end duration budgets. For a presented-frame row, `F` is the measured refresh interval of the named device and display configuration. The separate main-thread work budgets remain 8 ms for desktop or Android tablet and 12 ms for Android phone under [SVG Rendering](06-svg-rendering.md); they MUST NOT be substituted for presentation latency.

| Stable row ID                     | Scenario                                                                                                  |                Desktop or Android tablet p95 / p99 / maximum |                             Android phone p95 / p99 / maximum |
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
| `PERF-10K-MOVE-PRESENT`           | Selection-move input, including vertical edge autoscroll, to presented preview                            |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-RESIZE-PRESENT`         | Single-object resize input to presented preview                                                           |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-ATTACH-PRESENT`         | Line or Arrow endpoint drag to presented snap or free-endpoint preview                                    |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-TABLE-PRESENT`          | Table-divider input to presented preview                                                                  |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-AXIS-PRESENT`           | Axis-length input to presented preview                                                                    |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-AGGREGATE-PRESENT`      | Aggregate resize input to presented preview, with or without pressure Pens                                | `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` / `max(66.8 ms, 4F)` | `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` / `max(100.2 ms, 4F)` |
| `PERF-10K-VIEW-FRAME`             | Native one-finger pan, scroll, pure zoom, edge autoscroll, or culling main-thread frame work              |                                             8 / 12 / 16.6 ms |                                             12 / 16 / 16.6 ms |
| `PERF-10K-VIEW-PRESENT`           | Native one-finger pan, scroll, pure zoom, edge autoscroll, or culling to next presented frame             |  `max(16.7 ms, F)` / `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` |   `max(33.4 ms, F)` / `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` |
| `PERF-10K-PAINT`                  | Browser paint plus compositor duration for an interaction frame, where exposed                            |                                       `0.5F` / `0.75F` / `F` |                                        `0.5F` / `0.75F` / `F` |
| `PERF-10K-DROPPED`                | Dropped frames per 10-second drawing, native pan, scroll, zoom, or edge-autoscroll run                    |                                             0 / 1 / 2 frames |                                              1 / 2 / 4 frames |
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
| `PERF-10K-ATTACH-FANOUT`          | Target transform with 1,024 attached endpoints to presented complete preview                              | `max(33.4 ms, 2F)` / `max(50.1 ms, 3F)` / `max(66.8 ms, 4F)` | `max(50.1 ms, 2F)` / `max(66.8 ms, 3F)` / `max(100.2 ms, 4F)` |
| `PERF-10K-PASTE-5K`               | Validate, infer bindings, and atomically publish a 5,000-element paste                                    |                                         500 / 750 / 1,000 ms |                                      1,500 / 2,250 / 3,000 ms |
| `PERF-10K-HISTORY-MATERIALIZE`    | Materialize one deeply mapped actionable history entry for Undo or Redo                                   |                                             50 / 75 / 100 ms |                                            120 / 180 / 240 ms |
| `PERF-10K-GROUP-PATCH`            | Apply and publish one sparse Group replacement in a 10,000-element scene                                  |                                               8 / 12 / 16 ms |                                               12 / 18 / 24 ms |
| `PERF-10K-CAS-WRITABLE`           | Worst-case synchronous exact comparison at the platform writable-sidecar ceiling                          |                                              20 / 35 / 49 ms |                                               30 / 40 / 49 ms |
| `PERF-10K-RECOVERY-CLEANUP`       | Atomic acknowledgement and rebase of 512 retained direct recovery successors                              |                                           100 / 150 / 250 ms |                                            250 / 375 / 500 ms |
| `PERF-10K-TEARDOWN`               | Synchronous view-resource detach or plugin-unload teardown, excluding a recovery-protected headless flush |                                             50 / 75 / 100 ms |                                            100 / 150 / 200 ms |

For the same tier, steady additional heap in one pane is at most 96 MiB on desktop or Android tablet and 72 MiB on Android phone. Peak additional heap during any listed stress operation is at most 192 MiB and 160 MiB respectively. Steady heap is the maximum of five post-GC measurements after full mutation readiness; peak heap includes workers and transferable staging owned by the plugin. Every percentile-gated scenario uses at least 5 warmup samples followed by at least 100 measured samples per fixture and supported environment. Percentiles use the nearest-rank method and maximum is the largest measured value. Before a release-candidate measurement begins, its executable test fixes the target, generated fixture identity, thresholds, warmup, sample count, and procedure as test-local values. A missing threshold or a threshold changed after observing the run fails the stress gate; no external performance profile is required.

Forced checkpoint barriers bypass the idle debounce and use the Forced queue-wait row. Normal checkpoints use the Normal debounce-and-queue row. Both scenarios use the common Mapping composition, Digest work, `RecoveryStore` append, and Acknowledgement to first durable publication rows while also enforcing their respective end-to-end row. All phase and end-to-end gates are conjunctive; phase percentiles are not added to derive an end-to-end percentile. The 500 ms normal-path maximum is measured from the first dirty source generation and is absolute. The asynchronous last-view checkpoint flush is separate from synchronous detach and uses the two-second hard maximum in [Architecture](04-architecture.md).

Every named 10,000-element benchmark test maps explicitly to a stable table-row ID. Generic `input-to-preview` uses `PERF-10K-DRAW-PRESENT`; single-object selection uses `PERF-10K-SELECT-PRESENT`; selection movement including edge autoscroll uses `PERF-10K-MOVE-PRESENT` together with `PERF-10K-VIEW-FRAME` and `PERF-10K-VIEW-PRESENT`; endpoint attachment uses `PERF-10K-ATTACH-PRESENT`; and resize, Table, axis, or aggregate input uses its corresponding presented-frame row. Native one-finger pan uses `PERF-10K-VIEW-FRAME` and `PERF-10K-VIEW-PRESENT`. Selection totals, view work, paint, dropped frames, hit testing, background, binding, projection, reflow, save, source-checkpoint, and teardown metrics use their corresponding explicit `PERF-10K-*` row above. Aggregate commit, Undo, and Redo use `PERF-10K-AGGREGATE-COMMIT` and additionally enforce `PERF-10K-RECOVERY`. Recovery successor cleanup uses `PERF-10K-RECOVERY-CLEANUP`; exact sidecar comparison uses `PERF-10K-CAS-WRITABLE`; sidecar parse uses `PERF-10K-PARSE`; first overlay uses `PERF-10K-FIRST-OVERLAY`; full mutation readiness uses `PERF-10K-OPEN`; and unload cleanup uses `PERF-10K-TEARDOWN`. Name matching, generic drawing fallback for an explicitly listed interaction, and unmapped component timing are forbidden. A test without its referenced stable row ID and required p95, p99, and maximum assertions does not satisfy the stress tier.

The full external reattachment path MUST yield a first visible progress state within 100 ms. Frame work at refresh interval `F` is additionally limited to 80 percent of `F`; the tighter of that value and the platform target in [SVG Rendering](06-svg-rendering.md) applies.

Binding benchmarks separately record candidate counts, classification time, range-fragment projection time, enclosure projection time, affected-element count, and discarded stale generations. Pure note zoom MUST record zero classification calls, zero canonical publications, zero history entries, and zero sidecar generations. Width reflow MUST record zero canonical geometry rewrites.

Background benchmarks separately record mounted rhythm regions, inspected source line boxes, derivation slices, discarded stale generations, measurement time, and region-publication time. Scroll work MUST remain proportional to entering and leaving visible regions, not complete document length. A pure zoom with unchanged host layout records zero background remeasurement calls.

Performance measurements MUST report the metrics exposed by the tested layer, including percentiles and maxima for timing measurements and exact operation, allocation, candidate, DOM, publication, framework-commit, queue, and owner counts for structural tests. Automated performance tests use injected monotonic clocks, controlled task queues, deterministic frames, replayable workloads, and explicit completion events. Fixed sleeps are forbidden. No plugin-owned task may occupy the main thread continuously for 50 ms or longer during startup, note open, active input, rebuild, background processing, or unload. Lifecycle memory evidence records post-GC samples for at least 50 cycles where host automation can expose them, plus zero remaining owned listeners, observers, timers, animation frames, pointer captures, framework roots, workers, ports, and queue turns after terminal disposal.

Progressive rendering records time to first truthful visible projection, hit-test readiness, and full mutation readiness. Every supported 5,000-element fixture MUST return to full interactivity within the applicable initial budget, and every 10,000-element fixture within the predeclared stress table above. A permanently progressive read-only state is not a passing capacity result. An intentionally adversarial scene that violates an independent DOM-node or path-command ceiling is a resource-limit test, not evidence that a supported capacity fixture passed.

## 6. Resource Efficiency

Resource limits stay with the subsystem that owns the resource. Sessions, views, queues, caches, workers, persistence pipelines, recovery records, DOM nodes, listeners, observers, timers, animation frames, pointer captures, and retained buffers each have explicit count or byte ceilings. Admission rejects before retaining an over-limit payload or beginning a mutation. Ownership transfers exactly once, and terminal success, failure, cancellation, replacement, close, and unload release every owned resource idempotently.

Reaching a limit does not affect native Markdown. Inkbook first coalesces replaceable work and evicts disposable least-recently-used caches, then rejects the new annotation mutation or suspends the affected inactive projection with truthful resource-limited status. Dirty, actionable, recovery-protected, owner-lease, host-history completion, and lifecycle resources are never evicted. Automated tests exercise below, at, and above each implemented limit and verify final owner counts return to zero except for acknowledged non-resident IndexedDB recovery. A plugin-wide accounting framework is introduced only if measured cross-subsystem pressure proves that these local limits cannot enforce the aggregate heap budgets.

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

Worker count, queued jobs, queued bytes, active and output bytes, transferred bytes, detached buffers, cancelled or rescheduled generations, retry count, and per-priority latency are bounded and observable. The scheduler admits at most 64 outstanding jobs and 16 MiB of owned input bytes. Replacement of stale view work occurs before rejecting new current work. It has one replaceable latest job per revision-superseded view-work kind and a finite FIFO for non-replaceable recovery or persistence work. Admission fails before mutation when a required job or worst-case result cannot fit its explicit worker limits.

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
| Build and dependencies       | Transitive code and package artifacts               | Lockfile, license review, audit, architecture checks, Android-bundle scan, immutable release validation                                                                     |

Security invariants are fail closed before mutation: a path never escapes the Vault policy, an unknown or over-limit record never reaches scene construction, stale work never publishes, a failed recovery admission never reaches history or scene, external file conflict never uses silent last-writer-wins, and an unsupported host capability never falls back to private or broader access. Runtime production code performs no network request, remote code load, telemetry, tracking, or secret storage. Security checks MUST NOT be disabled to recover performance.

Residual risks that cannot be eliminated by this plugin are host API changes, equivalent-access local plugins, operating-system or synchronization failures, and platform storage eviction. Compatibility tests, drift and conflict UI, recovery probes, and truthful read-only modes reduce but do not claim to eliminate those risks.

### 7.2 Verification and Data Minimization

Inkbook processes only Vault-local note, sidecar, settings, and recovery data. Runtime annotation behavior requires no network access, telemetry, tracking, profiling, advertisements, third-party scripts, remote fonts, or cloud service. Host-managed Community installation and updates are distribution transport, not permission for Inkbook runtime networking.

Security tests MUST cover malicious JSON, huge numbers, deep nesting, duplicate IDs, invalid references, path confusion, `TAbstractFile` confusion, rename races, clipboard abuse, SVG and CSS injection attempts, unsafe HTML sinks, global-host escape attempts, stale revisions, sidecar conflicts, and replayed operation identities.

Security-relevant changes require an updated threat-boundary and abuse-case review covering assets, attackers, trust boundaries, data flows, replay, races, and resource exhaustion. SHA-256 MUST use an established platform cryptographic API or a reviewed, maintained, worker-compatible incremental implementation with recorded version, license, security review, and bundle cost. Custom-authored cryptography is forbidden.

Diagnostics MUST redact Markdown text, YAML values, anchor context, element geometry, file contents, and absolute system paths by default. Errors shown to users MUST not expose internal stack traces or sensitive paths.

## 8. Accessibility

The production UI MUST target WCAG 2.2 AA within the host constraints. Normal text contrast is at least 4.5:1, large text is at least 3:1, and essential non-text component boundaries, focus indicators, selection indicators, and graphical objects are at least 3:1 against adjacent colors. Automated checks MUST cover every machine-observable semantic, keyboard, focus, target-size, contrast, zoom, theme, forced-colors, reduced-motion, announcement, and accessible-tree rule. The finite release theme matrix contains Obsidian's default light theme, default dark theme, and host forced-colors or high-contrast mode where the matrix platform exposes it. Third-party themes are supported through documented Obsidian semantic tokens but are not individually certified. Human accessibility review is limited to qualities that programmatic interfaces cannot establish, such as actual screen-reader comprehension, tactile or physical input quality, and perceptual usability. It is performed once at the owning phase or release boundary and MUST NOT expand into a recurring user-run matrix.

The SVG scene itself is not a substitute for semantic toolbar controls. Selected objects MUST be representable through an accessible selection summary and actionable controls even when every geometry detail cannot be narrated.

## 9. Dependency Policy

Dependencies require a concrete benefit, active maintenance, compatible license, Android compatibility, and acceptable bundle cost. The implementation SHOULD prefer Obsidian, CodeMirror, browser, and small focused utilities already present before adding a framework.

Every Obsidian import is recorded with its first supported host version. A dependency that makes `isDesktopOnly: false` untrue is forbidden. Release validation evaluates the bundled transitive graph, not only authored imports.

## 10. Release Definition of Done

A phase or release is complete only when its requested behavior, architecture, code quality, security, privacy, accessibility, performance, resource, documentation, and test requirements are satisfied by the simplest suitable implementation. Every completion report lists changed surfaces, executable checks actually run, results, checks not executed with reasons, the one concise phase-sanity outcome, residual risks, and unresolved uncertainty. Non-automatable uncertainty is reported honestly and MUST NOT be converted into additional routine user procedures. Partial or unverified work MUST NOT be reported as complete.

Before public distribution, the project records a factual applicability assessment based on current official primary sources for GDPR, TDDDG, DDG, BFSG, BFSGV, the EU AI Act, consumer and e-commerce rules, and required legal notices. Inapplicable areas require a concrete rationale based on the actual local-only product, distribution, operator role, target market, business model, and data flows. Missing facts block a compliance claim rather than being invented.

Public release additionally requires the package, manifest, Android, documentation, policy, licensing, directory, version-fallback, and artifact rules in [Obsidian Host Contract](14-obsidian-host-contract.md). No completion report may claim Community compatibility from compilation alone.
