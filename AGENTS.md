# Inkbook Project Instructions

## Scope and Authority

- These rules cover the complete repository. Global instructions supplement them. Commit and publish only within the authority granted for the task.
- For commits authored on behalf of Yannick Schäfer, use `yannickschaefer@boomapps.de` as the author and committer email. Preserve other contributors' identities and existing commits unless explicitly instructed otherwise.
- Follow the normative product, architecture, performance and acceptance contracts in the [Documentation Index](docs/README.md#documentation-index). Put each detailed behavioral rule in its canonical guide. Preserve exact values, formulas, inputs, timing and failure behavior. Mark unresolved contradictions explicitly.

## Architecture and Source Layout

| Path                         | Responsibility                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                | Build entry point and the only source file directly in `src/`                                                         |
| `src/domain/`                | Pure model, geometry, commands, history, storage, ordering, connections, spatial index and portable scheduling policy |
| `src/editor/`                | Tools, pointer arbitration, selection, sessions, camera coordination and autosave scheduling                          |
| `src/rendering/`             | Imperative SVG and input surface in `scene/`, framework-free motion in `motion/`, and React chrome in `ui/`           |
| `src/persistence/`           | Document validation, migration, clipboard, export, hashing, output verification, workers and save orchestration       |
| `src/obsidian/`              | Plugin and Markdown lifecycle, workspace integration, settings, host storage, vault adapters and styles in `styles/`  |
| `test/`, `scripts/`, `docs/` | Focused tests, repository automation and normative guides                                                             |
| `dist/`                      | Generated Obsidian release artifacts. Never edit these by hand.                                                       |

- Keep the complete source graph, including type-only imports, acyclic and within the [area directions](docs/specification.md#simple-architecture). Domain stays independent of DOM, React, workers and Obsidian. Host adapters own their boundary. Avoid mutable cross-area globals, hidden singletons, generic grab-bag directories and broad or recursive barrels.
- Keep one workspace activation coordinator per plugin instance and at most one detached dirty session pending save or recovery. Each authoritative active or draining session owns one normalized Store, history, spatial index and document worker. Each attached presentation owns one imperative renderer and input surface. Follow the [runtime flows](docs/architecture-flows.md).
- Each Store has exactly three ordered render bands (image, highlight and content), one reverse connection map, semantic anchors and domain-classified deltas with commit-time geometry and paint versions.
- React owns chrome and coarse state. Ink, pointer, camera, culling, snapping and frame work remain imperative. The scene lint gate excludes React, JSX, TSX, roots, portals and React-owned UI. The worker uses `ES2021` and `WebWorker` without DOM, `Window`, React, input or Obsidian. The main-thread worker factory is outside that graph.
- Introduce modules for concrete responsibilities. Avoid a backend, dependency-injection container, state-management or event-bus framework, generic graph library, worker pool, plugin-internal extension system and parallel implementations. Reserve root files for standard repository documentation, metadata and configuration.
- Before implementing or reviewing visible UI, apply the available `animation:motion` skill. Reuse the components, presets and CSS tokens under `src/rendering/motion/`, `src/rendering/ui/` and `src/obsidian/styles/`. The local [Animation Contract](docs/quality-and-testing.md#animation-contract) also applies without the skill.

## Obsidian and Persistence Boundaries

- Use public Obsidian APIs. The [hotkey and native PDF options gateways](docs/obsidian-integration.md#authority-and-support-surface) are the only private runtime reads. Keep them read-only, narrowly scoped and isolated. Prefer equivalent public APIs when available.
- Live Preview uses `registerEditorExtension()`. Reading view uses `registerMarkdownPostProcessor()` with owned `MarkdownRenderChild` instances. Use `Editor` for active-note changes and `Vault` and `FileManager` for vault I/O. Preserve mobile support without Node.js, Electron, Adapter APIs, private host CSS selectors or host DOM traversal.
- Enhance exact standalone native images only after safe Inkbook recognition. Keep ordinary or ambiguous occurrences host-owned. Mount only a completely validated static SVG, strip its metadata and theme stylesheet, and retain only validated font rules. Apply the canonical palette and fail closed on unknown or incomplete markup. Follow [Native Embeds](docs/obsidian-integration.md#native-embeds) and the [SVG allowlist](docs/svg-envelope.md#strict-static-markup-allowlist).
- Own DOM, listeners, timers, observers, roots and pointer work through the host lifecycle and resolve the owning document and window. Use `Plugin.loadData()` and `Plugin.saveData()` for vault settings and `App.loadLocalStorage()` and `App.saveLocalStorage()` for device preferences. Follow the [menu and styling boundaries](docs/obsidian-integration.md#commands-menus-icons-and-styling). The Markdown insertion entry remains in the native menu.
- Keep CodeMirror and Lezer external to the production bundle and follow the [peer and direct dependency contract](docs/specification.md#platform-baseline), including Dependabot exclusions for host-provided CodeMirror dependencies.
- Verify manifest, README, license, source, build and release artifacts before claiming [Community directory readiness](docs/obsidian-integration.md#community-directory-release-contract).

## Performance and Resource Contract

- Keep live input responsive with the [10,000-stroke dataset](docs/quality-and-testing.md#performance-acceptance-dataset). Use the injected [central WorkScheduler](docs/rendering-and-performance.md#central-work-scheduling) for all cooperative interruptions. Use one scheduler per owning window and the central task-admitted worker adapter with live frame-derived limits. Main-thread fallback keeps window admission.
- Preserve the source-layout scheduling gate. No private deadline resets, yield loops, idle scheduler or native work scheduling outside approved adapters. Checkpoint only when work must yield. An explicit frame wait needs a frame dependency or documented publication cap. Element, point and step counts must not force CPU handoffs within the shared budget. Bounded work, cancellation intervals, resource limits and semantic timers retain their distinct purposes.
- Coalesce invalidations to one scene update per frame and mutate only changed or newly visible SVG nodes. Bound caches. Use the spatial index and reverse map for culling, snapping and connections. Keep full-store scans out of interaction hot paths, order-only commands within budget, and vault writes serialized while coalescing newer exports.
- Obsidian owns vertical scrolling. Reserve its gutter before measuring recognized presentations and retain it across the full lifetime, including lock and unlock. Keep nested vertical scrollers and pointer-time gutter changes out of the canvas. See the [native scroll contract](docs/obsidian-integration.md#native-scroll-owner-and-scrollbar-stability).
- Keep saved SVG self-contained and visually equivalent to the active document graphic in the canonical light and dark schemes. Host theme variables belong to chrome. Follow the [rendering](docs/rendering-and-performance.md) and [resource budgets](docs/quality-and-testing.md#performance-budgets).

## Testing and Acceptance

- During implementation run checks affected by the change. Once stable, run the prescribed complete verification for that change type once. Diagnose a failed stage and complete the remaining required checks, reusing still-valid results. Missing or failed required checks remain failures.
- Keep permanent Unit and focused Integration tests for core failures only. Cover creation and safe reopening, drawing and editing with Undo/Redo, save and recovery, portable document and clipboard data, host session handoff, and CI selection and failure propagation. Choose the lowest reliable layer and reuse the smallest existing case. End-to-end and smoke suites are excluded.
- Unit coverage is under `test/unit/domain/`, `test/unit/editor/`, `test/unit/persistence/` and `test/unit/scripts/`. Use `test/integration/obsidian/` for Obsidian-hosted editor, rendering and lifecycle integration, and `test/integration/persistence/` for persistence boundaries. See the [automated test strategy](docs/quality-and-testing.md#automated-test-strategy) and [affected selection](docs/ci-selection.md).
- Exercise affected workflows, accessibility, interaction and motion in running Obsidian during implementation and recheck after fixes. Use the [isolated Flatpak QA procedure](docs/manual-release-checks.md#manual-obsidian-display-verification). Shared UI code requires desktop, tablet and phone verification. For performance changes, capture a baseline, profile the affected work, fix bottlenecks in scope and remeasure with the same fixture, platform and interaction. Report evidence and gaps using the [performance procedure](docs/performance-ci.md).
- Keep the two [performance contracts](docs/performance-ci.md#unified-verification-model): bounded viewport publication for 10,000 strokes at 120 Hz and one coalesced pen update per frame at 60, 90, 120, 144 and 240 Hz. Assert production work with simulated time. Use direct runtime diagnostics for other affected costs.
- Keep CI maxima at 100 function lines, 500 file lines, cyclomatic complexity 20, cognitive complexity 25, 6 parameters and nesting depth 4. Review larger or more complex units for clear responsibilities without adding arbitrary numeric gates.
- Review content, local links and anchors, Markdown fences and the [complete index](docs/README.md#documentation-index) for documentation-only changes. Keep prose out of parser, snapshot and string-comparison tests.

## CI and Repository Protection

- Advance tooling to the newest officially released Node.js LTS major through a reviewed update. The baseline is 26.x. Verify the official schedule and release, then update engines, local selectors, project-code jobs and matching declarations together. Use the baseline's latest patch with `check-latest: true` in active CI. Node.js remains build and test tooling only.
- Validate the full PR diff and simulated merge against current `main`. Merge by squash only. Keep the docs-only fast path, required quality, audit, build and package checks on other changes, validated zero-test-impact handling, and full fallback for uncertainty. Manual dispatches and release tags run the full gate. Do not repeat the same tested squash tree after merge.
- Preserve `CI`, `Performance (shared)`, `Performance (refresh profiles)`, `gitleaks` and `Validate PR Title`. Synchronize any check-name change with the verified ruleset. Keep `gitleaks` standalone and preserve the documented [administrator bypass](docs/decisions/repository-admin-bypass.md).
- Keep quality and both performance shards at or below 20 minutes. Use `ubuntu-slim` for selection, aggregation, PR title, Dependabot, secret scanning and gitleaks updates. Docs-only quality and no-work performance jobs use Slim without checkout, install or application execution and time out at five minutes. All Slim jobs stay within the platform's 15-minute limit. Active quality, performance and release jobs use `ubuntu-latest`. Do not add macOS or larger paid runners.
- Classify each performance contract exactly once in the manifest. Complete local verification, release, manual and full fallback run both contracts at every assigned profile. Complete local `npm run ci` rejects shard overrides. Missing, failed, malformed, unexpectedly skipped and timed-out results fail closed. Follow [Local and GitHub Parity](docs/performance-ci.md#local-and-github-parity).
- Pin all GitHub Actions to full commit SHAs. Tags use `x.y.z`, match `manifest.json` and point to a commit on `main`.

## Tooling and Commands

| Command                                                      | Purpose                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| `npm run ci`                                                 | Complete local quality and performance gate             |
| `npm run ci:quality`                                         | Complete non-performance gate                           |
| `npm run benchmark`                                          | Both performance contracts at their assigned profiles   |
| `npm test`                                                   | Validate the complete Unit and Integration suite        |
| `npm run test:unit`, `npm run test:integration`              | Native focused test groups                              |
| `npm run architecture`                                       | Complete import graph, cycles and area directions       |
| `npm run format:check`, `npm run docs:check`                 | Formatting and documentation validation                 |
| `npm run lint`, `npm run lint:styles`, `npm run lint:layout` | ESLint, CSS and source-layout checks                    |
| `npm run typecheck`, `npm run typecheck:worker`              | TypeScript projects and isolated worker checks          |
| `npm run duplication`, `npm run dead-code`                   | jscpd with `minTokens: 50` and Knip                     |
| `npm run audit`                                              | Production dependency audit with high/critical failures |
| `npm run build`, `npm run package:verify`                    | Production build and package contract                   |

Use the npm, esbuild, Vitest, ESLint, Stylelint, Prettier and dependency-cruiser workflow in [Quality and Testing](docs/quality-and-testing.md#ci-gates). Keep applicable findings from the official type-aware `eslint-plugin-obsidianmd` configuration blocking. See [README setup](README.md#development) for `npm run dev` and the [manual verification guide](docs/manual-release-checks.md#manual-obsidian-display-verification) for the Flatpak launch.

## Documentation

Write technical content in English with stable ASCII `kebab-case` filenames. Keep guides focused and under 500 lines. Use `docs/` for technical guides and the standard root files for their respective roles. Update [the index](docs/README.md#documentation-index) for every new, moved, renamed or removed Markdown file. Keep one-off reports, traces, dates and changing speed measurements in working context.
