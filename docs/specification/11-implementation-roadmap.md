# Implementation Roadmap

This roadmap is dependency-ordered. A phase begins only after every prior exit criterion is recorded as passing. Later work MUST NOT compensate for a failed earlier contract. Every change passes Per-Commit CI, and every phase exit passes the cumulative Phase-Exit lane in [Quality and Performance](09-quality-and-performance.md).

Each phase writes a versioned evidence record under `test/phase-evidence/phase-<number>/`. The record names the production bundle digest, specification digest, requirement manifest digest, test IDs, compatibility cells, fixtures, automated and manual results, exceptions, and unresolved risks. An unavailable required device, host capability, threshold, or test is a blocked exit, not a passing result.

## Phase 0: Bootstrap and Host Feasibility

### Required specifications

- [Specification Overview](00-readme.md)
- [Architecture](04-architecture.md)
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [References](13-references.md)
- [Obsidian Host Contract](14-obsidian-host-contract.md)
- [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md), limited to the probe envelopes and recovery ordering
- [Repository and CI Governance](17-repository-and-ci-governance.md)
- [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md), limited to source and initial-sidecar probe contracts
- [ADR 0001](../decisions/0001-clean-room-implementation.md)

### Deliverables

1. Complete a reviewed isolation assessment that traces every historically adjacent-project-related claim to allowed independent evidence or removes it from implementation input. Create `provenance/clean-room.jsonl`, its schema, and its validator as the first scaffold artifacts; record and review those bootstrap artifacts in the same change before accepting them.
2. Initialize Git and create a minimal mobile-capable plugin with `package.json`, one npm-generated lockfile, a Node.js active-LTS engine range, the current stable npm release, strict `tsconfig.json`, `manifest.json`, `src/main.ts`, `src/styles.css`, and a production esbuild configuration. Resolve the newest stable mutually compatible versions at scaffold time and add a content-bound provenance record before accepting each artifact.
3. Record the rolling-current version policy, supported runtime ranges, update procedure, and exact bootstrap resolutions in `docs/decisions/0002-toolchain-and-build.md`. The selected stack MUST use the newest stable mutually compatible releases of ESLint with TypeScript and complexity rules, Prettier, Vitest with V8 coverage, fast-check, Playwright or an equally capable browser runner, dependency-cruiser, jscpd, knip, dependency auditing, package checks, and custom documentation, manifest, mobile-bundle, provenance, and traceability checks. Permanent exact pins are forbidden except in the generated lockfile or where a narrow upstream compatibility constraint is proven and reviewed.
4. Provision the private GitHub repository, labels, Dependabot, least-privilege workflows, required checks, branch and tag rulesets, security features, gitleaks updater, and draft release flow from [Repository and CI Governance](17-repository-and-ci-governance.md). Create Per-Commit CI, Phase-Exit, and Release workflow entry points, and make the first present package script in Community scanner order run the production build.
5. Create `test/vault/`, deterministic host fakes, `test/manual/manual-acceptance.schema.json`, and the traceability generator plus checked-in `test/traceability/requirements.json`.
6. Create and validate `test/compatibility/compatibility-matrix.schema.json` and `test/compatibility/compatibility-matrix.json` with the actual minimum and release Obsidian versions, OS builds, desktop hardware, tablet, iOS phone or tablet, and Android phone or tablet available for testing.
7. Create benchmark-manifest schema and placeholder cells at `test/benchmarks/benchmark-manifest.schema.json` and `test/benchmarks/benchmark-manifest.json`; measurements remain unset until their owning phase calibrates them.
8. Build production-shaped attachment probes for Live Preview, Source, Reading View, split panes, deferred leaves, non-Markdown leaves, Bases, desktop pop-outs, layout readiness, lifecycle ownership, and unload.
9. Build the actual two-pointer zoom recognizer, secondary-button routing, plugin-element touch selection, native context-menu preservation, CodeMirror virtualization, native text selection, IME, and software-keyboard probes.
10. Build one isolated invertible annotation-effect bridge in existing host history using bounded `HostEffectEnvelopeV1` handles to stable revision-free history entries, monotonic per-editor and per-epoch host transaction sequences with retained high-water marks, fresh revision-bound dispatches for Forward, Undo, and Redo, one owner-pane lease, epoch handoff, and no second history extension or keymap. Probe unload and re-enable while a host effect remains reachable: the plugin MUST either restore the complete actionable history state before accepting that effect or prove the effect unreachable and fail closed.
11. Build a static worker payload inside `main.js` with launch, transfer, cancellation, crash, URL revocation, unavailable-worker fallback, and disposal probes.
12. Build the transactional IndexedDB recovery probe with schema creation, atomic prepare and host-recorded transition, abort, quota, restart, corruption, cleanup, and disposal.

### Exit evidence

- The reviewed lockfile resolves the newest stable mutually compatible toolchain and dependency versions available at the recorded freeze time. Repository drift verification passes, all three required GitHub checks protect `main`, and the package contains only `main.js`, `manifest.json`, and `styles.css` while passing every architecture, quality, bundle, provenance, documentation, freshness, and package gate.
- Markdown A, annotation B, and Markdown C undo and redo in exact host order on every selected desktop, iOS, and Android cell. Branching, delayed duplicate Forward after Undo, delayed duplicate Inverse after Redo, rapid Undo or Redo, pane conflict, epoch handoff, recovery failure, disposal, unload with a reachable effect, re-enable, and restart fail safely.
- Each concrete Obsidian editor owns exactly one bounded ViewPlugin value; Reading View children and the one view overlay dispose without duplication.
- Worker and IndexedDB contracts pass on every matrix cell. The unavailable-worker fallback is safe but does not substitute for a required worker-capable release cell.
- A reviewed `docs/decisions/0003-host-history-and-recovery-feasibility.md` records the proven public or guarded host boundary and exact unsupported cases.

If unified host history, transactional recovery, required view attachment, or mobile worker launch cannot be proven, broad feature implementation stops. The architecture, supported modes, device matrix, or minimum Obsidian version must change explicitly before Phase 1.

## Phase 1: Canonical Domain, Operations, and Recovery

### Required specifications

- [Architecture](04-architecture.md)
- [Anchors and Layout](05-anchors-and-layout.md), serialized binding and anchor records only
- [Sidecar Persistence](07-sidecar-persistence.md), schema and limits only
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [Domain Model and Codecs](15-domain-model-and-codecs.md)
- [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md)

### Deliverables

1. Implement branded IDs, revisions, points, vectors, styles, geometries, bindings, ports, attachments, elements, Groups, object order, note appearance, and immutable `SceneStateV1` in framework-independent domain modules.
2. Implement complete validation in the specified order, canonical RFC 8785 serialization, SHA-256 boundaries, and exact `delta-varint-v1` encoding and decoding.
3. Implement the closed revision-free patch union, fresh dispatch envelopes, stable history entries, metadata-free batch members, exact non-revision inverse derivation, monotonic component-generation rules without ABA, dependency closure, operation-specific order placement, Connector endpoint authority, and Group leaf-block order equality.
4. Implement the pure command-admission function, closed errors, session snapshot types, host-effect lifecycle, recovery attempts, source-checkpoint records, and relocation or removal record codecs.
5. Turn the Phase 0 IndexedDB probe into the production `RecoveryStore` adapter with transactional compare-and-swap, exact byte accounting, bounded cleanup, corruption handling, and idempotent disposal.
6. Implement pure selection-model derivation and connector-port resolution without DOM or Obsidian imports.

### Exit evidence

- Unit, property, fuzz, codec-golden, inverse, revision, attachment, Group, order, resource-limit, corruption, and RecoveryStore fault tests pass at required coverage.
- Every public domain type is deeply immutable and its import direction passes the architecture checker.
- Deterministic 5,000- and 10,000-element scene generators produce schema-valid canonical scenes whose future sidecar encoding fits all simultaneous V1 limits.
- Repeated recovery cycles remain within 8 MiB per note and exact cleanup leaves no actionable host handle without its operation.

Vault writes, SVG, real pointer input, binding inference, and product UI remain outside this phase.

## Phase 2: Note Sessions, Source Coordination, and Sidecars

### Required specifications

- [Architecture](04-architecture.md)
- [Anchors and Layout](05-anchors-and-layout.md), boundary mapping and canonical anchor evidence
- [Sidecar Persistence](07-sidecar-persistence.md)
- [Settings](08-settings.md), storage policy only
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [Obsidian Host Contract](14-obsidian-host-contract.md), Vault and settings boundaries
- [Domain Model and Codecs](15-domain-model-and-codecs.md)
- [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md)
- [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md)

### Deliverables

1. Implement `NoteSessionRegistry`, non-reentrant session queues, immutable publication, owner leases, reference counting, headless flush, and exact lifecycle disposal.
2. Implement `MarkdownSourceCoordinator`, `SourceOffsetMapV1`, cross-pane duplicate admission, checkpoint composition, forced barriers, and bounded source recovery.
3. Implement sidecar path policy, locator validation, synchronous marker callback, first-sidecar-pending state, revision-1 initial create, canonical load and save, compare-and-process, save-generation coalescing, conflicts, and newer-version read-only behavior.
4. Implement external sidecar change handling, note and folder relocation sagas, storage-root persistence, conflict copies, orphan review, host-trash-only removal, and explicit storage-location migration.
5. Implement the storage-policy schema and application port with adjacent default. The full settings screen remains Phase 5.
6. Add sanitized persistence and recovery status models without React ownership of session state.

### Exit evidence

- All Section 3 persistence and fault cases whose required production surfaces are delivered in Phases 0 through 2 pass against fakes and the Phase 0 test Vault. Connector interaction, clipboard, construction, later binding projection, and every other later-surface case remain release-blocking in their explicitly assigned owning phase and do not block the Phase 2 exit before that surface exists.
- First annotation creates no empty sidecar and recovers every crash window exactly as specified.
- Two panes delivering one Markdown transition produce one source generation and checkpoint. Mismatches enter bounded reattachment or conflict without guessed mutation.
- Rename, folder rename, sync overwrite, marker drift, save race, migration interruption, restart, and trash barriers preserve acknowledged data and perform no unsafe overwrite.
- Cold 16 MiB parse, warm single-element save, checkpoint, detach, recovery, and memory budgets pass their phase-applicable matrix cells.

## Phase 3: Retained SVG and Basic Input

### Required specifications

- [Product Scope](01-product-scope.md)
- [Interaction and Tools](02-interaction-and-tools.md), Cursor, Pen, Highlighter, Eraser, Lasso, routing, selection, and history
- [Architecture](04-architecture.md)
- [SVG Rendering](06-svg-rendering.md)
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [Obsidian Host Contract](14-obsidian-host-contract.md)
- [Domain Model and Codecs](15-domain-model-and-codecs.md)
- [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md)
- [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md)

### Deliverables

1. Implement retained SVG layers, incremental spatial and selectable-order indices, geometry and paint bounds, culling, cache limits, view transforms, and imperative node updates outside React.
2. Implement pointer routing, one-preview and one-commit gestures, pointer capture, cancellation, touch selection, native scrolling, right-button routing, long press, and keyboard selection.
3. Implement Pen, freehand and straight Highlighter, whole-element Eraser, Cursor, Lasso, pressure snapshots, constant-width projection, pressure-outline workers, and safe sliced fallback.
4. Integrate every accepted gesture with operation, host-history, recovery, session publication, retained rendering, and coalesced sidecar save.
5. Add minimal development commands for tool activation. Production toolbar and stylebar remain Phase 5.

### Exit evidence

- Basic tool, selection, context-menu, touch, long-stroke, cancellation, Undo or Redo, save, reopen, and disposal scenarios pass on desktop and real mobile cells.
- Pointer sampling, preview, scroll, pure zoom transform, culling, SVG updates, and worker progress produce zero React note-root commits and no per-element React components.
- 5,000-element minimum fixtures pass applicable hit, select, lasso, scroll, memory, worker, recovery, and full-mutation-readiness budgets. Relevant 10,000-element stress rows are recorded without retrospective threshold changes.
- A single-element operation performs no complete-scene scan or rebuild.

## Phase 4: Anchors, Reflow, and View-Local Projection

### Required specifications

- [Interaction and Tools](02-interaction-and-tools.md), automatic and manual binding behavior
- [Architecture](04-architecture.md), layout coordination
- [Anchors and Layout](05-anchors-and-layout.md)
- [SVG Rendering](06-svg-rendering.md)
- [Sidecar Persistence](07-sidecar-persistence.md), binding records and source checkpoints
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [Domain Model and Codecs](15-domain-model-and-codecs.md), ports and canonical geometry
- [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md)
- [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md)

### Deliverables

1. Implement exact block classification, fingerprinting, code-point-safe contexts, boundary associations, offset-map application, and bounded external reattachment.
2. Implement `BindingInferenceProfileV1`, bounded candidate lookup, deterministic highlight, underline, enclosure, text-position, and fixed classification, confidence, and tie-breaking.
3. Implement fragment, transform, and enclosure projection per view, signed margins, variable-width reflow, stale-token rejection, and degraded or orphaned states.
4. Implement manual binding correction, move-and-reanchor batches, Group binding updates, and connector reverse-index invalidation.
5. Preserve canonical geometry during reflow and share only viewport-independent results across panes.

### Exit evidence

- Unicode, context, fingerprint, boundary-association, offset composition, threshold edge, enclosure-margin, stale-token, and reattachment goldens pass.
- Two widths of one note yield separate correct projections from one canonical scene with no sidecar mutation caused by width alone.
- Manual move and correction create one exact reversible operation. Pure zoom creates no inference, history, recovery, or save work.
- Connector port projection and target reflow remain proportional to reverse-index fanout and pass the 1,024/1,025 boundary.
- Binding, range, enclosure, reflow, and external-reattachment performance rows pass their applicable matrix cells.

## Phase 5: Production Toolbar, Stylebar, Commands, and Settings

### Required specifications

- [Product Scope](01-product-scope.md)
- [Interaction and Tools](02-interaction-and-tools.md)
- [Toolbar and Stylebar](03-toolbar-and-stylebar.md)
- [Architecture](04-architecture.md), UI boundary
- [Settings](08-settings.md)
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [Toolbar Mockup](12-toolbar-mockup.md), visual reference only
- [Obsidian Host Contract](14-obsidian-host-contract.md), native UI, settings, commands, and RTL

### Deliverables

1. Implement a small reusable control library for color, width, opacity, pressure, caps, dash, fill, sliders, segmented choices, menus, and mixed selection state.
2. Implement Floating and Docked toolbar, contextual stylebar, responsive overflow, fixed group membership, configurable order, focus restoration, and 44-CSS-pixel compact targets.
3. Implement production controls for completed tools and binding correction. Construction controls are wired to stable ports and become enabled only with Phase 6 implementations; no milestone build may present an action as functional before its command exists.
4. Implement Obsidian commands, host Hotkeys ownership, native Menu and Modal surfaces, safe DOM, Obsidian icons, logical CSS, RTL, visible status, and accessible live regions.
5. Implement the imperative 1.8.7 settings tab, complete validated plugin-global and device-local snapshots, defaults, storage policy, toolbar order, write failure with Retry, guarded external-change reload, diagnostics, and reset.

### Exit evidence

- Toolbar, stylebar, settings, command, focus, keyboard, screen-reader, touch, narrow-width, reduced-motion, default light, default dark, and forced-colors or high-contrast tests pass.
- Tool or style changes rerender only subscribed coarse UI subtrees. Pointer, scene, scroll, culling, and worker changes cause zero unrelated React commits.
- Settings corruption, migration, failed persistence, guarded external notification, settings-tab reopen reload, root rename, and cross-device locator behavior pass.
- The mockup remains non-normative and no product behavior is inferred only from it.

## Phase 6: Shapes, Construction, Connectors, Groups, and Clipboard

### Required specifications

- [Interaction and Tools](02-interaction-and-tools.md)
- [Toolbar and Stylebar](03-toolbar-and-stylebar.md)
- [Anchors and Layout](05-anchors-and-layout.md)
- [SVG Rendering](06-svg-rendering.md)
- [Sidecar Persistence](07-sidecar-persistence.md)
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [Domain Model and Codecs](15-domain-model-and-codecs.md)
- [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md)

### Deliverables

1. Implement Rectangle, Ellipse, Triangle, Diamond, Octagon, Line, Arrow, straight Connector, endpoint caps, and Line or Arrow quadratic curve control.
2. Implement the one Coordinate system tool with 2D or 3D creation choice, semantic vectors, individual axis-length controls, shared move, and rigid rotation.
3. Implement one semantic Table with Rows and Columns creation and selected-object controls, whole-frame move, resize, rotation, and constrained divider editing.
4. Implement linear, area, axis-set, and aggregate selection models, Group operations, z-order, duplicate, cut, copy, paste, target menus, and dependency-closed delete.
5. Integrate construction tools into the Phase 5 toolbar and stylebar without adding per-element React components.

### Exit evidence

- Every tool passes creation, selection, style, transform, constant-width, binding, save, reload, exact Undo or Redo, cancellation, clipboard, and malicious-input tests.
- Line and Arrow curve; Connector remains straight. Every valid port, attachment, move, reflow, delete-disconnect, and Undo path passes without a scene scan.
- Table rows, columns, dividers, minimum tracks, rotation, axes vectors, grid guides, limits, Groups, and order pass exact semantic and composed-path tests.
- Single and aggregate transforms keep style bytes and line widths unchanged, remain atomic, and pass 5,000- and 10,000-element applicable budgets.

## Phase 7: Backgrounds, Whole-Note Zoom, and Reading View

### Required specifications

- [Product Scope](01-product-scope.md)
- [Interaction and Tools](02-interaction-and-tools.md), zoom and read-only mode
- [Toolbar and Stylebar](03-toolbar-and-stylebar.md), background and zoom controls
- [Architecture](04-architecture.md), Reading View and layout ownership
- [Anchors and Layout](05-anchors-and-layout.md), background rhythm
- [SVG Rendering](06-svg-rendering.md)
- [Settings](08-settings.md), appearance and zoom defaults
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [Obsidian Host Contract](14-obsidian-host-contract.md), Reading View and mobile

### Deliverables

1. Implement none, ruled, squared, and dotted backgrounds with block-scoped measured rhythm, whole-view fallback ownership, section-owned overrides, bounded region merging, and truthful unavailable-metric degradation.
2. Implement 50 to 400 percent whole-note zoom through controls and pinch, shared note and overlay transforms, pointer inversion, focus preservation, viewport preservation, and bounded device-local remembered zoom.
3. Complete Reading View section reporting, source evidence, one whole-note overlay, read-only projections, background ownership, section reprocessing, and disposal.
4. Integrate theme, font, writing width, mode, resize, scroll, and pop-out invalidation with revision-bound layout publication.

### Exit evidence

- The complete background formula, ownership, region-limit, mode, width, theme, font, zoom, hit-test, empty-note, and unavailable-metric matrix passes.
- Reading View never mutates scene, Markdown, history, recovery, or sidecars and never duplicates overlays, children, observers, or background regions.
- Pure zoom reuses layout metrics when logical width is unchanged and creates no canonical mutation, reclassification, history, or save work.
- Scroll, zoom, culling, background, presentation, dropped-frame, paint, memory, pop-out, and teardown budgets pass all applicable release cells.

## Phase 8: Release Hardening

### Required specifications

All documents in the [Specification Index](00-readme.md) and every accepted ADR apply.

### Deliverables

1. Freeze complete compatibility and benchmark manifests, fixture digests, performance thresholds, screen-reader matrix, and manual procedures before observing the release-candidate results.
2. Run the complete Per-Commit, Phase-Exit, and Release lanes against one immutable production artifact on named desktop, tablet, iOS, and Android cells.
3. Complete WCAG 2.2 AA manual review, security abuse review, dependency audit, clean-room and license review, privacy and legal-applicability assessment, and 50-cycle lifecycle leak checks.
4. Pass every 5,000-element minimum-capacity and 10,000-element stress workflow, including open, mutation readiness, draw, select, lasso, resize, Table, axes, reflow, save, conflict, recovery, Undo or Redo, unload, paint, dropped frames, and memory.
5. Finalize public `README.md`, compatible `LICENSE`, real publisher metadata, accurate local-data and sidecar disclosures, Community policy evidence, manifest, package, `versions.json` when required, tag, draft release, and the three loadable artifacts.

### Exit evidence

- Every normative requirement in the regenerated traceability manifest has passing automated or approved versioned manual evidence.
- No unresolved, waived, or accepted critical or high security finding, data-loss case, stale conflict, mobile input regression, accessibility blocker, persistent resource leak, uncalibrated critical path, missing provenance record, or failed quality gate remains.
- The release report names changes, exact checks and results, checks not executed with reasons, compatibility cells, residual risks, uncertainty, and the factual legal-applicability assessment.
- A draft release is reviewed manually before publication. Commit, push, tag, and publication remain explicit user-authorized actions.
