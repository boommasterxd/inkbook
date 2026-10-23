# Inkbook Project Instructions

## Scope and Authority

- These instructions apply to the complete repository. Global instructions supplement them where this file is silent.
- For commits authored on behalf of Yannick Schäfer, use `yannickschaefer@boomapps.de` as the Git author and committer email. Other contributors retain their own identities. Do not rewrite existing commit identities unless explicitly requested.
- The Markdown files under `docs/` are the normative product, architecture, performance, and acceptance contracts. Keep each behavioral rule in one canonical document and link to it instead of duplicating it.
- Preserve numeric values, formulas, input conditions, timing rules, and failure behavior when reorganizing code or documentation. Mark unresolved contradictions explicitly.
- Introduce a module only when it owns real behavior in one of the responsibility areas below. Do not create speculative abstractions or parallel implementations.

## Architecture Map

| Area          | Owns                                                                                                                                                     | Must not own                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `domain`      | Elements, geometry, commands, history, schema, normalized storage, ordering, anchors, connections, the spatial index, and the portable scheduling policy | React, DOM, browser APIs, workers, vault access, CodeMirror, or Obsidian APIs                                                        |
| `editor`      | Tools, pointer arbitration, gestures, selection, sessions, camera coordination, and autosave scheduling                                                  | Host lifecycle, persisted file formats, or React-driven ink rendering                                                                |
| `rendering`   | The imperative SVG scene, input surface, culling, retained nodes, and React application chrome                                                           | Domain mutation, persistence, host APIs, or React participation in pointer, camera, culling, snapping, and animation-frame hot paths |
| `persistence` | Document validation, migration, clipboard codecs, SVG export, hashing, persisted-output verification, worker protocol, and save orchestration            | DOM, pointer, camera, scroll, or Obsidian APIs                                                                                       |
| `obsidian`    | Plugin composition, Markdown surfaces, workspace lifecycle, settings UI and host storage, vault adapters, and pop-out-window integration                 | Reimplementation of domain, editor, rendering, or persistence rules                                                                  |

Dependencies point inward from `obsidian` and thin boundary adapters for Obsidian, vault, clipboard, and workers toward editor, persistence, rendering, and pure domain contracts. The complete `src/` import graph, including TypeScript type-only edges, must remain cycle-free and satisfy these area directions under the automated architecture gate. Avoid cross-area mutable globals, hidden singletons, generic grab-bag modules, recursive barrels, and broad re-exports.

### Runtime Cardinality and Ownership

- Keep one workspace activation coordinator per plugin instance. It serializes activation across tabs, panes, and pop-out windows and may retain at most one detached dirty session until save or recovery finishes.
- Each authoritative active or draining document session owns one normalized element store, one command history, one uniform spatial index, and one document worker. Each attached presentation owns one imperative SVG scene renderer and one canvas input surface.
- The store owns two fixed render bands, stable order within each band, semantic shape anchors, one derived reverse map for connected line and arrow endpoints, and domain-classified deltas with commit-time geometry and paint versions.
- React owns application chrome and coarse UI state only. It never renders ink elements or participates in pointer, camera, culling, snapping, or animation-frame updates. Static lint rules reject React, ReactDOM, JSX, TSX, React-owned UI imports, roots, portals, and state APIs in `src/rendering/scene/`; imperative DOM and SVG remain allowed there.
- The document worker owns bounded editable-document validation, migration, clipboard codecs, SVG export, hashing, and persisted-output verification. It never owns DOM, `Window`, React, pointer, camera, scroll, or Obsidian API work. Its entry-based `ES2021` plus `WebWorker` typecheck excludes the main-thread `worker-factory.ts`.
- Do not add a backend, dependency-injection container, state-management framework, event-bus framework, generic graph library, worker pool, or plugin-internal extension system.

The complete dependency and runtime flows are canonical in [`docs/specification.md`](docs/specification.md) and [`docs/architecture-flows.md`](docs/architecture-flows.md).

### Animation Contract

Before implementing or reviewing visible Inkbook UI, read and apply the available `animation:motion` skill and reuse the existing shared Motion components and presets. The normative [Animation Contract](docs/quality-and-testing.md#animation-contract) defines transition ownership, gestures, reduced motion, immediate-input exceptions, and verification. That local contract still applies when the skill is unavailable.

## Repository Layout

| Path                    | Responsibility                                                    |
| ----------------------- | ----------------------------------------------------------------- |
| `src/main.ts`           | Build entry point and the only source file directly under `src/`  |
| `src/domain/`           | Pure model and geometry logic                                     |
| `src/editor/`           | Editor orchestration and interaction logic                        |
| `src/rendering/motion/` | Framework-free motion contracts                                   |
| `src/rendering/scene/`  | Imperative SVG scene rendering                                    |
| `src/rendering/ui/`     | React-owned application chrome                                    |
| `src/persistence/`      | File formats, workers, export, validation, and save orchestration |
| `src/obsidian/`         | Obsidian integration and adapters                                 |
| `src/obsidian/styles/`  | Static plugin and host-integration styles                         |
| `test/`                 | Focused source-parallel Unit, Integration, and performance tests  |
| `scripts/`              | Repository automation and verification scripts                    |
| `docs/`                 | Normative technical documentation in focused subtopics            |
| `dist/`                 | Generated Obsidian release artifacts, never hand-edited           |

Root files are limited to repository documentation, metadata, and configuration required by npm, Obsidian, GitHub, or quality tooling. Do not accumulate shared runtime code or styles directly under `src/`, and do not create generic `common`, `helpers`, `services`, `shared`, or `utils` dumping grounds.

## Change Routing

| Change                                                                           | Primary source area | Primary tests                                             | Canonical documentation                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Elements, geometry, order, anchors, connections, schema, or pure settings        | `src/domain/`       | `test/unit/domain/`                                       | [`docs/core-model.md`](docs/core-model.md), [`docs/file-format.md`](docs/file-format.md), [`docs/settings.md`](docs/settings.md) |
| Tools, gestures, selection, input, or zoom                                       | `src/editor/`       | `test/unit/editor/`, `test/integration/editor/`           | [`docs/editor-tools.md`](docs/editor-tools.md), [`docs/features.md`](docs/features.md), [`docs/zoom.md`](docs/zoom.md)           |
| SVG scene, culling, retained nodes, or chrome                                    | `src/rendering/`    | `test/unit/rendering/`, `test/integration/rendering/`     | [`docs/rendering-and-performance.md`](docs/rendering-and-performance.md), [`docs/embed-ui.md`](docs/embed-ui.md)                 |
| Document validation, migration, serialization, export, worker, or save           | `src/persistence/`  | `test/unit/persistence/`, `test/integration/persistence/` | [`docs/file-format.md`](docs/file-format.md), [`docs/svg-envelope.md`](docs/svg-envelope.md)                                     |
| Markdown embeds, workspace lifecycle, settings UI and host storage, or vault I/O | `src/obsidian/`     | `test/unit/obsidian/`, `test/integration/obsidian/`       | [`docs/obsidian-integration.md`](docs/obsidian-integration.md), [`docs/settings.md`](docs/settings.md)                           |

## Obsidian Integration Contract

- Use documented public Obsidian APIs. The sole private runtime exception is the read-only hotkey-conflict gateway documented in [`docs/obsidian-integration.md`](docs/obsidian-integration.md); replace it when Obsidian exposes an equivalent public effective-hotkey API. Live Preview uses `registerEditorExtension()`, Reading view uses `registerMarkdownPostProcessor()` with owned `MarkdownRenderChild` instances, active-note text changes use `Editor`, and vault files use `Vault` and `FileManager`.
- Replace only an exact standalone `!inkbook` Markdown block through documented lifecycle APIs without depending on private host DOM structure. Ordinary native SVG and image embeds remain host-owned and must not be intercepted.
- Before a locked preview mounts, perform only the incremental strict safe-envelope inspection needed to prove the allowlisted presentation markup safe. Import only a completely validated Inkbook SVG into the lifecycle-owned, non-interactive SVG surface, strip metadata and the file stylesheet, apply the canonical palette through scoped host CSS, and fail closed instead of mounting unknown or partially validated markup.
- Own DOM, listeners, timers, observers, React roots, portals, and pointer work through an Obsidian `Component` or widget lifecycle. Resolve pop-out behavior through the owning document and window.
- Use `Plugin.loadData()` and `Plugin.saveData()` for vault settings. Use `App.loadLocalStorage()` and `App.saveLocalStorage()` for device-local, vault-specific preferences.
- Preserve desktop and mobile support without Node.js, Electron, Adapter APIs, private host fields outside the isolated read-only hotkey-conflict gateway, private host CSS selectors, or host DOM traversal. Inkbook Overflow, Shape, canvas context, Style, and Background menus use lifecycle-owned adaptive surfaces that preserve host menu appearance and interaction without mutating host DOM or global theme tokens. The Markdown editor insertion entry remains in the native Obsidian menu. These boundaries are defined in [`docs/obsidian-integration.md`](docs/obsidian-integration.md).
- Follow the release and Community directory contract in [`docs/obsidian-integration.md`](docs/obsidian-integration.md). Do not claim submission readiness until the manifest, README, license, source, build, and release artifacts have been verified.

## Performance and Resource Contract

- Treat 10,000 strokes as the required interactive dataset and preserve live input responsiveness over animation and background work.
- All existing and new cooperative work interruptions MUST use the injected central `WorkScheduler`. Main-thread consumers share one scheduler per owning window; each document worker uses the same central scheduler with task-based admission, its worker adapter, and live frame-derived slice limits. Main-thread fallback work retains the owning window's frame admission policy. Never introduce a consumer-local deadline reset, parallel yield loop, idle scheduler, or native task/frame scheduling for work outside the approved adapters. Use checkpoints only when work must yield; use an explicit frame wait only for a real frame dependency or documented frame resource cap. Do not add element-, point-, or step-count CPU quotas that force a handoff while the shared budget remains. Bounded indivisible steps, cancellation check intervals, and justified memory, protocol, or browser-publication limits retain their separate purposes. Semantic debounce, gesture, animation-duration, and I/O timeout timers are not work budgets. The source-layout scheduling gate enforces the native primitive boundary; additions must preserve that gate and the [central scheduling contract](docs/rendering-and-performance.md#central-work-scheduling).
- Coalesce scene invalidations into at most one animation-frame update. Mutate only changed or newly visible SVG nodes, keep main-thread and worker caches bounded, and avoid React work in the render and input hot paths.
- Use culling, snapping, and connection lookup through the spatial index and reverse connection map. Never scan the complete element store in an interaction hot path.
- Keep order-only commands within the command-commit budget. Serialize vault writes while coalescing newer asynchronous exports.
- Preserve Obsidian as the sole vertical scroll owner. Reserve its native scrollbar gutter for the complete recognized-presentation lifetime before width-derived preview or editor measurement, retain it across lock and unlock, never toggle it in the pointer hot path, and do not create a nested vertical scroller.
- Keep saved SVG files self-contained and visually equivalent to the active document graphic in the canonical light and dark schemes. Host theme variables style plugin chrome only and never become an external file dependency.

Detailed rendering, cache, scheduling, memory, and latency contracts are canonical in [`docs/rendering-and-performance.md`](docs/rendering-and-performance.md) and [`docs/quality-and-testing.md`](docs/quality-and-testing.md).

## Testing and Acceptance

- During local implementation, run only checks affected by the current changes. Once the integrated result is stable, run the complete verification prescribed for that change type once. After later edits, rerun only checks whose evidence those edits actually invalidate; retain unaffected passing results. This local workflow preserves the complete CI gate at its required triggers.
- If verification stops at a failed stage, diagnose and fix or report that failure, then complete the remaining required checks without restarting already valid stages. Expand verification only for a concrete gap or unresolved concern, stating which evidence it affects. Missing or failed required checks remain failures.
- Use Unit and focused Integration tests only. End-to-end and smoke suites are explicitly excluded.
- For every new or changed test, follow the [shared test-authoring rules](docs/quality-and-testing.md#automated-test-strategy): reuse existing coverage, fixtures, and helpers; eliminate redundant setup and execution while preserving independent state, meaningful cases, assertions, and coverage.
- Add deterministic regression coverage for every relevant behavior change. Full-project coverage must retain at least 85 percent lines, statements, and functions plus at least 80 percent branches; selected pull request coverage applies the same thresholds to the reachable runtime source and is reported as partial under [the CI selection contract](docs/ci-selection.md).
- Add deterministic work/resource tests for every new or changed performance-critical path. Follow [Adding or Changing Performance Tests](docs/performance-ci.md#adding-or-changing-performance-tests): observe actual expensive boundaries, assert justified upper bounds, register the manifest entry, and cover relevant capacity, cancellation, reuse, and cleanup cases.
- Apply the [Unified Verification Model](docs/performance-ci.md#unified-verification-model): observe work/resources directly and use simulated time only for scheduling. Do not add elapsed-time or CPU-time measurements, p95/p99 assertions, baselines, tolerance percentages, timing reports, or statistical warmups/repetitions. Unobserved computation can still regress; a green CI run is not proof of execution speed.
- Test real indexed visits, point reads, fragment/geometry builds, DOM writes, host accesses, queues, buffer bytes, and retained resource ownership where applicable. Counting a test loop or checking only output correctness is not a production work bound. Keep large fixtures and meaningful state transitions; record remaining instrumentation gaps. Physical-device latency targets remain separate acceptance requirements.
- Enforce hard CI maxima of 100 function lines, 500 file lines, cyclomatic complexity 20, cognitive complexity 25, 6 parameters, and nesting depth 4. Review large or complex units for clear responsibilities and readability without treating an additional arbitrary numeric threshold as a defect.
- Documentation-only changes require a complete content review, working relative links, balanced Markdown code fences, and a synchronized Documentation Index. Do not add parser, snapshot, or string-comparison tests solely for documentation prose.
- The exhaustive performance manifest must classify every performance test exactly once. Reject missing, unclassified, or duplicate files. Preserve full fixtures and deterministic behavioral scenarios; remove repetitions used only to produce timing statistics.

| Test scope  | Required coverage                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Pure domain, geometry, schema, state machines, workspace activation coordination, commands, settings, zoom, scroll-owner leases, document-worker state, serialization, render ordering, shape anchors, endpoint connections, detachment, propagation, migration, and clipboard ID remapping |
| Integration | Important renderer, document-worker and fallback, workspace and pop-out lifecycle, native-scrollbar stability, Vault/FileManager, CodeMirror, Reading-view lifecycle, clipboard, and settings boundaries through test adapters                                                              |

| Performance class      | Execution contract                                                        |
| ---------------------- | ------------------------------------------------------------------------- |
| Refresh-rate invariant | Run work/resource contracts once at the default 120 Hz profile.           |
| Cadence-sensitive      | Run simulated scheduling/input contracts at 60, 90, 120, 144, and 240 Hz. |

The complete test matrix, performance budgets, and acceptance requirements are canonical in [`docs/quality-and-testing.md`](docs/quality-and-testing.md).

## CI and Repository Protection

- Pull requests targeting `main` run affected checks for the complete base-to-head diff; uncertain or invalid selection falls back to the complete gate. Manual dispatches and release tags run the complete gate. Do not repeat the same tested squash tree on a post-merge `main` push. Follow the canonical [affected pull request verification contract](docs/ci-selection.md).
- Preserve the exact required check names `CI`, `Performance (shared)`, `Performance (refresh profiles)`, `gitleaks`, and `Validate PR Title`. Workflow, job, or matrix-label changes that rename or remove a check require a synchronized and verified repository-ruleset update in the same change.
- Required pull requests must be current with `main` and merge by squash only.
- Execute every classified performance file/profile contract on full local checks, manual dispatches, releases, and full pull request fallbacks. For selected pull requests, run the affected manifest files in each shard; a validated shard with no affected manifest files may return no-work success. Documentation-only pull requests have no work in either shard. Keep scenarios independently initialized, preserve capacity fixtures and meaningful lifecycle sequences, and avoid redundant statistical repetition.
- Keep full local and hosted performance coverage identical under [Local and GitHub Parity](docs/performance-ci.md#local-and-github-parity). Pull request selection follows [Affected Pull Request Verification](docs/ci-selection.md). The full local `npm run ci` includes both complete shards and rejects shard-only overrides. Missing, failed, unexpectedly skipped, malformed, and timed-out executions fail closed.
- For new or changed work bounds, observe the actual production boundary and verify that extra work would violate the assertion where practical. Do not replace removed speed comparisons with fake-time speed claims. Operational timeouts remain safety limits, not performance acceptance thresholds.
- Keep the quality job and both performance shards within twenty minutes of execution each. Timeouts fail closed; do not skip checks or increase the limit to accommodate additional benchmarks.
- Use `ubuntu-slim` for affected-check selection, final CI aggregation, PR title validation, Dependabot inspection and auto-merge, secret scanning, and gitleaks updates. Active quality and performance execution and release use `ubuntu-latest`; documentation-only quality and unaffected performance contexts confirm successful selection on `ubuntu-slim` without checkout, dependency installation, or application execution. These no-work contexts retain five-minute timeouts; all Slim jobs must remain within the platform's fifteen-minute limit. Active quality and both active parallel performance shards use the latest Node.js 24.x release with `check-latest: true`. Do not add macOS or larger paid runners.
- Keep all GitHub Actions pinned to full commit SHAs.
- Release tags use `x.y.z` without a leading `v`, match `manifest.json`, and point to a commit on `main`.
- Keep `gitleaks` as its standalone required job. Performance remains split into invariant work/resource contracts and five-profile scheduling contracts. Preserve the exhaustive manifest. Do not add reference commits, historical anchors, post-merge promotion, timing artifacts, or a separate local measurement mode.

## Manual Obsidian Display Verification

Apply the [local verification workflow](#testing-and-acceptance) to real UI checks as well. During implementation, use focused reproductions in the affected mode and interaction. Once the UI is stable, complete the required modes and scenarios once. Record artifact hashes, platform, fixture, interaction, and result so later changes invalidate only the evidence they actually affect.

Confirm vault identity, plugin readiness, and fixture syntax before interaction checks. Distinguish test-setup failures from product failures. Correct profile initialization, plugin enablement, fixture syntax, selectors, or assertions and resume the failed scenario; retain passed scenarios unless the same fault invalidates them. Reuse a working isolated profile, display, and shared setup across required modes. Restart or recapture only for a concrete verification need, then perform the required cleanup once when the verification session ends.

1. Use the dedicated QA vault and locally installed Flatpak build of Obsidian. Install the exact production artifacts under test and confirm that their hashes match `dist/`.
2. Start an isolated X11 display with at least a 1920 by 1200, 24-bit framebuffer:

   ```bash
   xvfb-run -a -s "-screen 0 1920x1200x24" flatpak run md.obsidian.Obsidian --disable-gpu --remote-debugging-port=9222
   ```

3. Electron may restore a small window despite the framebuffer size. Before evaluating layout, use `xdotool` on the X display selected by `xvfb-run` to resize and position Obsidian to at least 1600 by 1000 pixels. Verify through the DevTools protocol that `window.innerWidth >= 1500` and `window.innerHeight >= 900`.
4. Drive the real Obsidian page through the DevTools protocol. Wait for the relevant locked or active Inkbook state, capture uncaught errors and unhandled rejections, exercise the requested interaction, and take a screenshot for visual inspection. Keep the working instance for the remaining required modes; perform final cleanup in step 10.
5. For every UI layout, styling, or interaction change that can affect shared platform code, verify all three real-Obsidian presentation modes: desktop, tablet, and phone. A single-mode verification is sufficient only when the changed selectors and runtime branch are proven exclusive to that mode. State that scope explicitly; shared components, tokens, or control flow always require all three modes.
6. Verify desktop mode after calling `Emulation.clearDeviceMetricsOverride`, removing the platform flag with `localStorage.removeItem("EmulateMobile")`, reloading Obsidian, and resizing the real window as described above. Confirm that the body is neither `is-mobile` nor `is-phone`. Never accept a default 640 by 480 capture as desktop evidence for toolbar, adaptive-panel, embed-width, sticky-position, or transition behavior.
7. Verify tablet mode with Obsidian's own mobile emulation by calling `localStorage.setItem("EmulateMobile", "1")`, reloading, and retaining a wide viewport. Confirm through the DevTools protocol that the body is `is-mobile` and `is-tablet`, but not `is-phone`; do not simulate tablet behavior by manually adding CSS classes.
8. Verify phone mode by keeping `localStorage.EmulateMobile` enabled and applying a Chrome DevTools `Emulation.setDeviceMetricsOverride` with `mobile: true` and a narrow phone viewport, normally 360 by 800 CSS pixels. Reload when the platform flag changes and confirm that the body is both `is-mobile` and `is-phone`; do not simulate phone behavior by manually adding CSS classes.
9. In every required mode, record the viewport and platform classes, exercise the same affected interaction, inspect computed geometry and relevant host theme tokens, capture a screenshot, and assert that the uncaught-error and unhandled-rejection collections remain empty. For software-keyboard behavior, reduce the emulated phone viewport height while the panel is open and verify that the surface remains inside `visualViewport`.
10. Restore the QA vault's original theme and emulation settings, clear the device-metrics override, and close the temporary Obsidian and X11 processes after verification. These simulations cover Obsidian's responsive desktop, tablet, and phone branches; behavior that depends on physical Android hardware or the operating-system input stack still requires an explicitly reported hardware check.

## Tooling and Commands

Use `npm`, TypeScript, esbuild, Vitest, ESLint with the official type-aware `eslint-plugin-obsidianmd` configuration, dependency-cruiser, Stylelint, Prettier, `jscpd` with `minTokens: 50`, `knip`, and `npm audit`. Applicable Obsidian API, lifecycle, mobile, command, styling, path, settings, and sample-code findings are errors.

| Command                    | Purpose                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `npm run ci`               | Run the complete local quality and performance gate                            |
| `npm run ci:quality`       | Run every non-performance quality, architecture, test, build, and package gate |
| `npm run benchmark`        | Run all classified work/resource and simulated-scheduling contracts.           |
| `npm run architecture`     | Verify the complete source import graph, cycles, and area directions           |
| `npm test`                 | Run Unit and Integration tests without coverage                                |
| `npm run test:unit`        | Run Unit tests                                                                 |
| `npm run test:integration` | Run focused Integration tests                                                  |
| `npm run test:coverage`    | Run Unit and Integration tests with coverage                                   |
| `npm run format:check`     | Verify formatting                                                              |
| `npm run lint`             | Run ESLint with zero warnings allowed                                          |
| `npm run lint:styles`      | Run Stylelint for source CSS                                                   |
| `npm run lint:layout`      | Verify source and test filenames, Scene TSX absence, and CSS file size         |
| `npm run typecheck`        | Type-check runtime and test projects                                           |
| `npm run typecheck:worker` | Type-check the actual worker graph without DOM, React, or Obsidian types       |
| `npm run duplication`      | Run `jscpd` duplication detection                                              |
| `npm run dead-code`        | Run `knip` dead-code detection                                                 |
| `npm run audit`            | Fail on high-severity dependency vulnerabilities                               |
| `npm run build`            | Produce the production plugin artifacts                                        |
| `npm run package:verify`   | Verify the distributable package contract                                      |

Keep CodeMirror and Lezer external to the production bundle. Add direct CodeMirror development dependencies only when source imports require them, pin them to the exact peer versions declared by the selected `obsidian` package, and update that compatibility set together. Generic Dependabot updates for direct CodeMirror peers remain ignored.

## Documentation Contract

- Write technical content in English and use ASCII-compatible `kebab-case` documentation filenames. Preserve exact product, API, UI, command, and identifier spelling when part of a contract.
- Keep each document focused on one stable responsibility and below 500 lines.
- Use stable topic-based filenames; do not create date-specific documentation files.
- Keep one-off measurement reports and changing speed comparisons out of `docs/`. Document lasting architecture, resource budgets, and verification requirements in their canonical topic documents.
- Store technical documentation under `docs/`, except for standardized root files such as `AGENTS.md`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, and `LICENSE.md`.
- Update the Documentation Index whenever a Markdown file under `docs/` is created, moved, renamed, or deleted. Keep it complete, recursive, alphabetically sorted, and free of broken links.

## Documentation Index

| Document                                                                                                   | Purpose                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/architecture-flows.md`](docs/architecture-flows.md)                                                 | Visualizes runtime ownership, session lifecycle, workspace activation, native scrolling, imperative rendering, document-worker boundaries, and persistence recovery.  |
| [`docs/ci-selection.md`](docs/ci-selection.md)                                                             | Defines complete-diff pull request selection, safe fallbacks, partial coverage, performance shards, and valid empty-shard results.                                    |
| [`docs/core-model.md`](docs/core-model.md)                                                                 | Defines the SVG-backed handwriting file model and page dimensions.                                                                                                    |
| [`docs/decisions/bounded-interaction-work.md`](docs/decisions/bounded-interaction-work.md)                 | Records progressive viewport publication, validation reuse, incremental derived state, and verification boundaries.                                                   |
| [`docs/decisions/centerline-selection-highlights.md`](docs/decisions/centerline-selection-highlights.md)   | Records centerline selection indicators, geometric transform bounds, and verification boundaries.                                                                     |
| [`docs/decisions/central-work-scheduler.md`](docs/decisions/central-work-scheduler.md)                     | Records shared window budgets, worker scheduling policy, explicit waits, lifecycle ownership, and enforcement.                                                        |
| [`docs/decisions/compact-stroke-contours.md`](docs/decisions/compact-stroke-contours.md)                   | Records compact pressure contours, constant-width simplification, reference output budgets, and verification boundaries.                                              |
| [`docs/decisions/compact-stroke-metadata.md`](docs/decisions/compact-stroke-metadata.md)                   | Records exact compact stroke metadata, reader compatibility, integrity binding, and verification boundaries.                                                          |
| [`docs/decisions/deterministic-performance-checks.md`](docs/decisions/deterministic-performance-checks.md) | Records removal of timing gates, retained work/resource checks, and the accepted speed-coverage gap.                                                                  |
| [`docs/decisions/document-worker-recovery.md`](docs/decisions/document-worker-recovery.md)                 | Records bounded native replacement, active-time watchdogs, authoritative resynchronization, and local failure diagnostics.                                            |
| [`docs/decisions/eraser-local-work.md`](docs/decisions/eraser-local-work.md)                               | Records owned stroke-section reuse, retained removal history, shared band snapshots, local spatial preparation, and hidden preview readiness.                         |
| [`docs/decisions/history-replay-reuse.md`](docs/decisions/history-replay-reuse.md)                         | Records private history record reuse, bounded retired scene contours, validation boundaries, and resource ownership.                                                  |
| [`docs/decisions/isolated-scene-document.md`](docs/decisions/isolated-scene-document.md)                   | Records isolation of the retained decorative SVG document and its ownership boundary.                                                                                 |
| [`docs/decisions/performance-base-comparison.md`](docs/decisions/performance-base-comparison.md)           | Historically records PR-base-only performance comparisons and the accepted cumulative-regression limitation.                                                          |
| [`docs/decisions/performance-bounded-measurements.md`](docs/decisions/performance-bounded-measurements.md) | Historically records scenario-level timing selection, fixed measurement populations, six-pair decisions and the two-runner workload partition, and validation limits. |
| [`docs/decisions/performance-comparison-profiles.md`](docs/decisions/performance-comparison-profiles.md)   | Historically records 120-Hz cadence comparisons, preserved multi-profile contracts, and the accepted timing coverage gap.                                             |
| [`docs/decisions/performance-timing-warnings.md`](docs/decisions/performance-timing-warnings.md)           | Historically records ratio-only timing decisions, nonblocking uncertainty, strict evidence failures, and local/hosted parity.                                         |
| [`docs/decisions/prepared-scene-pressure-export.md`](docs/decisions/prepared-scene-pressure-export.md)     | Records bounded reuse of internally generated scene contours in worker export and its trust boundary.                                                                 |
| [`docs/decisions/pressure-path-capacity.md`](docs/decisions/pressure-path-capacity.md)                     | Records continuous pressure outlines, opacity compositing, and bounded SVG capacity.                                                                                  |
| [`docs/decisions/retained-stroke-position.md`](docs/decisions/retained-stroke-position.md)                 | Records durable stroke offsets, local geometry reuse, worker trust boundaries, and compatibility tradeoffs.                                                           |
| [`docs/decisions/selection-resize-feedback.md`](docs/decisions/selection-resize-feedback.md)               | Records continuous feedback on retained canonical paths while bounded replacement geometry is prepared.                                                               |
| [`docs/decisions/selection-work-reuse.md`](docs/decisions/selection-work-reuse.md)                         | Records complete visible selection feedback, private preparation reuse, bounded local geometry, and clipboard trust boundaries.                                       |
| [`docs/decisions/validated-unlock-geometry-reuse.md`](docs/decisions/validated-unlock-geometry-reuse.md)   | Records snapshot-authoritative safe unlock, strict output-proof reuse, trust boundaries, and verification tradeoffs.                                                  |
| [`docs/editor-tools.md`](docs/editor-tools.md)                                                             | Specifies selection, drawing, highlighting, shapes, endpoint snapping, arranging, erasing, and style behavior.                                                        |
| [`docs/embed-ui.md`](docs/embed-ui.md)                                                                     | Describes locked and unlocked embed states, toolbar layout, responsiveness, owned menus, and adaptive panels.                                                         |
| [`docs/features.md`](docs/features.md)                                                                     | Specifies backgrounds, page expansion, history, clipboard, input, arranging, locking, and overflow actions.                                                           |
| [`docs/file-format.md`](docs/file-format.md)                                                               | Defines the versioned SVG envelope, compact editable snapshot schema, ordering, connections, geometry, size limits, and migrations.                                   |
| [`docs/keyboard-shortcuts.md`](docs/keyboard-shortcuts.md)                                                 | Defines configurable canvas bindings, fixed system shortcuts, gesture modifiers, command ownership, settings UI, and persistence.                                     |
| [`docs/obsidian-integration.md`](docs/obsidian-integration.md)                                             | Defines supported Obsidian surfaces, multi-window ownership, native-scrollbar stability, public APIs, lifecycle, host storage, UI rules, and release requirements.    |
| [`docs/performance-ci.md`](docs/performance-ci.md)                                                         | Defines deterministic performance checks, affected pull request shards, coverage limits, authoring rules, and local/hosted parity.                                    |
| [`docs/quality-and-testing.md`](docs/quality-and-testing.md)                                               | Defines test coverage, CI gates, performance, memory, file-size, scroll stability, document-worker, multi-window, animation, accessibility, and verification.         |
| [`docs/rendering-and-performance.md`](docs/rendering-and-performance.md)                                   | Defines the imperative SVG scene, gesture updates, culling, bounded caches, document-worker boundary, and coalesced asynchronous persistence.                         |
| [`docs/settings.md`](docs/settings.md)                                                                     | Defines tool defaults, page preferences, input settings, scope, precedence, and validation.                                                                           |
| [`docs/specification.md`](docs/specification.md)                                                           | Defines implementation scope, platform baseline, architecture, workspace activation, state transitions, persistence, and security.                                    |
| [`docs/svg-envelope.md`](docs/svg-envelope.md)                                                             | Defines the standalone SVG envelope, portable light and dark palette, strict CSS allowlist, and external-rendering fidelity.                                          |
| [`docs/zoom.md`](docs/zoom.md)                                                                             | Specifies width-fit zoom, navigation inputs, anchoring, frame updates, and lock transitions.                                                                          |
