# Implementation Roadmap

This roadmap is dependency-ordered. A phase begins only after every prior exit criterion passes. Later work MUST NOT compensate for a failed earlier contract. Every change passes Per-Commit CI, and every phase exit passes the applicable suites in [Quality and Performance](09-quality-and-performance.md). Evidence belongs with the real executable test or release result, not in placeholder manifests.

## Status Protocol

Every deliverable and exit item has a stable phase ID and a Markdown checkbox. An implementation change MUST update the affected checkboxes in this file in the same change.

- `[x]` means the complete item exists in the current repository and its referenced automated or manual evidence has passed.
- `[ ]` means the item is absent, partial, stale, regressed, or not yet verified. Partial work remains unchecked and MAY be described after the item without implying completion.
- An exit item is checked only after its complete evidence has been recorded with the exact artifact, host, device, command, and result required by the linked acceptance section.
- A phase is complete only when every `P<n>-D*` deliverable and every `P<n>-E*` exit item in that phase is checked.
- A failed or no-longer-reproducible result resets the affected checkbox to `[ ]`.
- Phase 0 requires the explicit manual desktop and Android review below after the automated probes pass. That review supplements rather than replaces automated evidence.

## Phase 0: Bootstrap and Host Feasibility

### Required specifications

- [Specification Overview](00-readme.md)
- [Architecture](04-architecture.md)
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [References](13-references.md)
- [Obsidian Host Contract](14-obsidian-host-contract.md)
- [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md), limited to the probe envelopes and recovery ordering
- [GitHub and CI](17-github-and-ci.md)
- [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md), limited to source and initial-sidecar probe contracts

### Exact implementation references

- `P0-D1` and `P0-D2`: [Host Contract Sections 1 to 3](14-obsidian-host-contract.md#1-compatibility-baseline), [Quality Sections 1 to 3](09-quality-and-performance.md#1-code-quality-requirements), and [Toolchain Decision](../decisions/0002-toolchain-and-build.md#decision).
- `P0-D3`: [GitHub and CI Sections 1 to 5](17-github-and-ci.md#1-repository) and [Testing Section 8.8](10-testing-and-acceptance.md#88-android-and-release).
- `P0-D4`: [Testing Sections 1 and 7](10-testing-and-acceptance.md#1-test-layers) and [Quality Section 2.1](09-quality-and-performance.md#21-per-commit-ci).
- `P0-D5`: [Architecture Sections 4 to 7](04-architecture.md#4-plugin-lifecycle), [Host Contract Sections 3 to 6](14-obsidian-host-contract.md#3-startup-ownership-and-disposal), and [Testing Sections 8.2, 8.3, and 8.5](10-testing-and-acceptance.md#82-startup-and-lifecycle).
- `P0-D6`: [Interaction Sections 1, 5, 6, and 7](02-interaction-and-tools.md#1-input-routing-invariants), [Host Contract Sections 5 and 10](14-obsidian-host-contract.md#5-editor-and-codemirror-contract), and [Testing Sections 2.4, 2.10, 5, 8.4, and 8.8](10-testing-and-acceptance.md#24-touch-routing).
- `P0-D7`: [Architecture Sections 6 and 9](04-architecture.md#6-editor-integration), [Operations Sections 1 and 4 to 6](16-operations-sessions-and-recovery.md#1-operation-identity-and-common-contract), and [Testing Sections 2.3, 3, and 8.4](10-testing-and-acceptance.md#23-unified-undo-and-redo).
- `P0-D8`: [Architecture Section 3.7](04-architecture.md#37-worker-scheduler), [SVG Section 9](06-svg-rendering.md#9-worker-and-ui-framework-boundaries), [Host Contract Section 10](14-obsidian-host-contract.md#10-android-and-worker-compatibility), and [Testing Sections 6, 8.2, and 8.8](10-testing-and-acceptance.md#6-performance-acceptance).
- `P0-D9`: [Sidecar Section 9](07-sidecar-persistence.md#9-recovery), [Operations Section 6](16-operations-sessions-and-recovery.md#6-recovery-records-and-store), [Host Contract Section 10](14-obsidian-host-contract.md#10-android-and-worker-compatibility), and [Testing Sections 3 and 8.8](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P0-E1` to `P0-E6`: [Quality Sections 2 and 3](09-quality-and-performance.md#2-required-quality-lanes), [Testing Sections 2.3, 3, and 8.1 to 8.8](10-testing-and-acceptance.md#23-unified-undo-and-redo), [Host Contract Sections 2, 10, and 11](14-obsidian-host-contract.md#2-package-and-manifest), and [GitHub and CI Sections 1, 3, and 4](17-github-and-ci.md#1-repository).

### Deliverables

- [x] **P0-D1:** Maintain a minimal desktop- and Android-capable plugin with `package.json`, one npm-generated lockfile, the selected Node.js 26 runtime, npm, strict `tsconfig.json`, `manifest.json`, `src/main.ts`, `src/styles.css`, and the ignored `dist/` production staging directory.
- [x] **P0-D2:** Record the rolling-current version policy and exact compatible resolutions in `docs/decisions/0002-toolchain-and-build.md`. Keep only tools used by an executable build or test.
- [x] **P0-D3:** Maintain the private GitHub repository, Dependabot, least-privilege workflows, required checks, branch and tag rulesets, gitleaks updater, and draft release flow from [GitHub and CI](17-github-and-ci.md).
- [x] **P0-D4:** Keep deterministic host fakes and smoke tests under `test/`; create additional test directories only with the real suites that use them.
- [ ] **P0-D5:** Build production-shaped attachment probes for Live Preview, Source, Reading View, split panes, deferred leaves, non-Markdown leaves, Bases, desktop pop-outs, layout readiness, lifecycle ownership, and unload.
- [ ] **P0-D6:** Build the actual two-pointer zoom recognizer, secondary-button routing, plugin-element touch selection, native context-menu preservation, CodeMirror virtualization, native text selection, IME, and software-keyboard probes.
- [ ] **P0-D7:** Build one isolated invertible annotation-effect bridge in existing host history using bounded `HostEffectEnvelopeV1` handles to stable revision-free history entries, monotonic per-editor and per-epoch host transaction sequences with retained high-water marks, fresh revision-bound dispatches for Forward, Undo, and Redo, one owner-pane lease, epoch handoff, and no second history extension or keymap. Probe unload and re-enable while a host effect remains reachable: the plugin MUST either restore the complete actionable history state before accepting that effect or prove the effect unreachable and fail closed.
- [ ] **P0-D8:** Build a static worker payload inside `main.js` with launch, transfer, cancellation, crash, URL revocation, unavailable-worker fallback, and disposal probes.
- [ ] **P0-D9:** Build the transactional IndexedDB recovery probe with schema creation, atomic prepare and host-recorded transition, abort, quota, restart, corruption, cleanup, and disposal.

### Exit evidence

- [ ] **P0-E1:** The reviewed lockfile resolves the newest stable mutually compatible toolchain and dependency versions. All three required GitHub checks protect `main`, and the package contains only `main.js`, `manifest.json`, and `styles.css` while passing CI.
- [ ] **P0-E2:** Markdown A, annotation B, and Markdown C undo and redo in exact host order on every selected desktop and Android cell. Branching, delayed duplicate Forward after Undo, delayed duplicate Inverse after Redo, rapid Undo or Redo, pane conflict, epoch handoff, recovery failure, disposal, unload with a reachable effect, re-enable, and restart fail safely.
- [ ] **P0-E3:** Each concrete Obsidian editor owns exactly one bounded ViewPlugin value; Reading View children and the one view overlay dispose without duplication.
- [ ] **P0-E4:** Worker and IndexedDB contracts pass on every supported environment. The unavailable-worker fallback is safe but does not substitute for a required worker-capable release environment.
- [ ] **P0-E5:** A reviewed `docs/decisions/0003-host-history-and-recovery-feasibility.md` records the proven public or guarded host boundary and exact unsupported cases.
- [ ] **P0-E6:** After all automated Phase 0 evidence passes, the user installs the exact production package in dedicated desktop and Android test Vaults, records the bundle digest plus Obsidian, operating-system, hardware, and Android-device versions, and manually verifies enable, reload, disable, re-enable, Live Preview, Source, Reading View, split panes, mixed Markdown and annotation Undo or Redo order, annotation touch selection, native one-finger scroll, two-finger note zoom, software-keyboard entry, restart, and truthful fail-closed status.

If unified host history, transactional recovery, required view attachment, or Android worker launch cannot be proven, broad feature implementation stops. The architecture, supported modes, device matrix, or minimum Obsidian version must change explicitly before Phase 1.

## Phase 1: Canonical Domain, Operations, and Recovery

### Required specifications

- [Architecture](04-architecture.md)
- [Anchors and Layout](05-anchors-and-layout.md), serialized binding and anchor records only
- [Sidecar Persistence](07-sidecar-persistence.md), schema and limits only
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [Domain Model and Codecs](15-domain-model-and-codecs.md)
- [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md)

### Exact implementation references

- `P1-D1`: [Domain Sections 1 to 6](15-domain-model-and-codecs.md#1-scalar-and-identity-types) and [Anchors Section 2](05-anchors-and-layout.md#2-binding-types).
- `P1-D2`: [Domain Sections 8 and 9](15-domain-model-and-codecs.md#8-delta-varint-v1-wire-format), [Sidecar Sections 3, 4, and 10](07-sidecar-persistence.md#3-top-level-schema), and [Testing Sections 3 and 4](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P1-D3` and `P1-D4`: [Operations Sections 1 to 6](16-operations-sessions-and-recovery.md#1-operation-identity-and-common-contract), [Source Coordination Sections 1 to 3](18-source-coordination-and-persistence-operations.md#1-source-offset-maps-and-multi-pane-admission), and [Testing Section 3](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P1-D5`: [Operations Section 6](16-operations-sessions-and-recovery.md#6-recovery-records-and-store), [Sidecar Section 9](07-sidecar-persistence.md#9-recovery), and [Testing Section 3](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P1-D6`: [Domain Sections 4 and 6](15-domain-model-and-codecs.md#4-object-ports-and-attached-linear-endpoints), [SVG Section 4.1](06-svg-rendering.md#41-selection-geometry), and [Testing Sections 2.11, 2.12, and 4](10-testing-and-acceptance.md#211-lines-tables-and-axes).
- `P1-E1` to `P1-E4`: [Architecture Sections 1 and 2](04-architecture.md#1-architectural-goals), [Quality Sections 2.2, 3, 4, and 6](09-quality-and-performance.md#22-phase-exit-validation), and [Testing Sections 3, 4, 6, and 7](10-testing-and-acceptance.md#3-persistence-and-fault-tests).

### Deliverables

- [ ] **P1-D1:** Implement branded IDs, revisions, points, vectors, styles, geometries, bindings, ports, attachments, elements, Groups, object order, note appearance, and immutable `SceneStateV1` in framework-independent domain modules.
- [ ] **P1-D2:** Implement complete validation in the specified order, canonical RFC 8785 serialization, SHA-256 boundaries, and exact `delta-varint-v1` encoding and decoding.
- [ ] **P1-D3:** Implement the closed revision-free patch union, fresh dispatch envelopes, stable history entries, metadata-free batch members, exact non-revision inverse derivation, monotonic component-generation rules without ABA, dependency closure, operation-specific order placement, attached Line and Arrow endpoint authority, and Group leaf-block order equality.
- [ ] **P1-D4:** Implement the pure command-admission function, closed errors, session snapshot types, host-effect lifecycle, recovery attempts, source-checkpoint records, and relocation or removal record codecs.
- [ ] **P1-D5:** Turn the Phase 0 IndexedDB probe into the production `RecoveryStore` adapter with transactional compare-and-swap, exact byte accounting, bounded cleanup, corruption handling, and idempotent disposal.
- [ ] **P1-D6:** Implement pure selection-model derivation and object-port resolution for attached Line and Arrow endpoints without DOM or Obsidian imports.

### Exit evidence

- [ ] **P1-E1:** Unit, property, fuzz, codec-golden, inverse, revision, attachment, Group, order, resource-limit, corruption, and RecoveryStore fault tests pass at required coverage.
- [ ] **P1-E2:** Every public domain type is deeply immutable and its import direction passes the architecture checker.
- [ ] **P1-E3:** Deterministic 5,000- and 10,000-element scene generators produce schema-valid canonical scenes whose future sidecar encoding fits all simultaneous V1 limits.
- [ ] **P1-E4:** Repeated recovery cycles remain within 8 MiB per note and exact cleanup leaves no actionable host handle without its operation.

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

### Exact implementation references

- `P2-D1`: [Architecture Section 5](04-architecture.md#5-note-sessions-and-multiple-views), [Operations Section 4](16-operations-sessions-and-recovery.md#4-note-session-state-and-admission), and [Testing Sections 2.3, 3, 8.2, and 8.3](10-testing-and-acceptance.md#23-unified-undo-and-redo).
- `P2-D2`: [Anchors Section 4](05-anchors-and-layout.md#4-markdown-edits-and-reflow), [Source Coordination Section 1](18-source-coordination-and-persistence-operations.md#1-source-offset-maps-and-multi-pane-admission), [Architecture Section 9](04-architecture.md#9-publication-order), and [Testing Sections 2.6 and 3](10-testing-and-acceptance.md#26-anchor-reflow).
- `P2-D3` and `P2-D4`: [Sidecar Sections 1 to 10](07-sidecar-persistence.md#1-storage-decision), [Source Coordination Sections 2 and 3](18-source-coordination-and-persistence-operations.md#2-initial-sidecar-and-save-acknowledgement), and [Testing Sections 2.1, 2.2, 3, and 8.7](10-testing-and-acceptance.md#21-native-markdown).
- `P2-D5`: [Settings Section 6](08-settings.md#6-storage-and-recovery), [Host Contract Sections 8 and 9](14-obsidian-host-contract.md#8-settings-contract), and [Testing Section 8.7](10-testing-and-acceptance.md#87-settings-and-vault).
- `P2-D6`: [Operations Sections 3 and 4](16-operations-sessions-and-recovery.md#3-revision-rules-and-command-results), [Quality Section 7.2](09-quality-and-performance.md#72-verification-and-data-minimization), and [Testing Sections 3 and 5](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P2-E1` to `P2-E4`: [Testing Sections 3 and 8.7](10-testing-and-acceptance.md#3-persistence-and-fault-tests). `P2-E5`: [Quality Sections 5 and 6](09-quality-and-performance.md#5-performance-gates) and [Testing Section 6](10-testing-and-acceptance.md#6-performance-acceptance).

### Deliverables

- [ ] **P2-D1:** Implement `NoteSessionRegistry`, non-reentrant session queues, immutable publication, owner leases, reference counting, headless flush, and exact lifecycle disposal.
- [ ] **P2-D2:** Implement `MarkdownSourceCoordinator`, `SourceOffsetMapV1`, cross-pane duplicate admission, checkpoint composition, forced barriers, and bounded source recovery.
- [ ] **P2-D3:** Implement sidecar path policy, locator validation, synchronous marker callback, first-sidecar-pending state, revision-1 initial create, canonical load and save, compare-and-process, save-generation coalescing, conflicts, and newer-version read-only behavior.
- [ ] **P2-D4:** Implement external sidecar change handling, note and folder relocation sagas, storage-root persistence, conflict copies, orphan review, host-trash-only removal, and explicit storage-location migration.
- [ ] **P2-D5:** Implement the storage-policy schema and application port with adjacent default. The full settings screen remains Phase 5.
- [ ] **P2-D6:** Add sanitized persistence and recovery status models without React ownership of session state.

### Exit evidence

- [ ] **P2-E1:** All [Testing Section 3 persistence and fault cases](10-testing-and-acceptance.md#3-persistence-and-fault-tests) whose required production surfaces are delivered in Phases 0 through 2 pass against fakes and the Phase 0 test Vault. Endpoint attachment interaction, clipboard, construction, later binding projection, and every other later-surface case remain release-blocking in their explicitly assigned owning phase and do not block the Phase 2 exit before that surface exists.
- [ ] **P2-E2:** First annotation creates no empty sidecar and recovers every crash window exactly as specified.
- [ ] **P2-E3:** Two panes delivering one Markdown transition produce one source generation and checkpoint. Mismatches enter bounded reattachment or conflict without guessed mutation.
- [ ] **P2-E4:** Rename, folder rename, sync overwrite, marker drift, save race, migration interruption, restart, and trash barriers preserve acknowledged data and perform no unsafe overwrite.
- [ ] **P2-E5:** Cold 16 MiB parse, warm single-element save, checkpoint, detach, recovery, and memory budgets pass on every applicable supported environment.

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

### Exact implementation references

- `P3-D1`: [SVG Sections 1 to 6, 8, and 9](06-svg-rendering.md#1-decision), [Testing Sections 4 and 6](10-testing-and-acceptance.md#4-geometry-and-rendering-tests), and [Quality Sections 4 to 6](09-quality-and-performance.md#4-performance-workload).
- `P3-D2`: [Interaction Sections 1, 3, 5, and 7](02-interaction-and-tools.md#1-input-routing-invariants), [Host Contract Sections 5 and 10](14-obsidian-host-contract.md#5-editor-and-codemirror-contract), and [Testing Sections 2.4, 2.5, 5, and 8.4](10-testing-and-acceptance.md#24-touch-routing).
- `P3-D3`: [Interaction Section 2](02-interaction-and-tools.md#2-tool-set), [SVG Sections 3, 7, 9, and 11](06-svg-rendering.md#3-stroke-representation), and [Testing Sections 2.4, 2.5, 4, and 6](10-testing-and-acceptance.md#24-touch-routing).
- `P3-D4`: [Architecture Section 9](04-architecture.md#9-publication-order), [Sidecar Sections 5 and 9](07-sidecar-persistence.md#5-save-protocol), [Operations Sections 1 to 6](16-operations-sessions-and-recovery.md#1-operation-identity-and-common-contract), and [Testing Sections 2.2, 2.3, and 3](10-testing-and-acceptance.md#22-first-annotation).
- `P3-D5`: [Host Contract Section 5](14-obsidian-host-contract.md#5-editor-and-codemirror-contract), [Settings Section 8](08-settings.md#8-commands-and-hotkeys), and [Testing Section 8.4](10-testing-and-acceptance.md#84-editor-integration).
- `P3-E1` to `P3-E4`: [Testing Sections 2.3 to 2.5, 3, 4, 6, and 8.8](10-testing-and-acceptance.md#23-unified-undo-and-redo) and [Quality Sections 4 to 6](09-quality-and-performance.md#4-performance-workload).

### Deliverables

- [ ] **P3-D1:** Implement retained SVG layers, incremental spatial and selectable-order indices, geometry and paint bounds, culling, cache limits, view transforms, and imperative node updates outside React.
- [ ] **P3-D2:** Implement pointer routing, one-preview and one-commit gestures, pointer capture, cancellation, touch selection, native scrolling, right-button routing, long press, and keyboard selection.
- [ ] **P3-D3:** Implement Pen, freehand and straight Highlighter, whole-element Eraser, Cursor, Lasso, pressure snapshots, constant-width projection, pressure-outline workers, and safe sliced fallback.
- [ ] **P3-D4:** Integrate every accepted gesture with operation, host-history, recovery, session publication, retained rendering, and coalesced sidecar save.
- [ ] **P3-D5:** Add minimal development commands for tool activation. Production toolbar and stylebar remain Phase 5.

### Exit evidence

- [ ] **P3-E1:** Basic tool, selection, context-menu, touch, long-stroke, cancellation, Undo or Redo, save, reopen, and disposal scenarios pass on desktop and real Android cells.
- [ ] **P3-E2:** Pointer sampling, preview, scroll, pure zoom transform, culling, SVG updates, and worker progress produce zero React note-root commits and no per-element React components.
- [ ] **P3-E3:** 5,000-element minimum fixtures pass applicable hit, select, lasso, scroll, memory, worker, recovery, and full-mutation-readiness budgets. Relevant 10,000-element stress rows are recorded without retrospective threshold changes.
- [ ] **P3-E4:** A single-element operation performs no complete-scene scan or rebuild.

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

### Exact implementation references

- `P4-D1`: [Anchors Sections 2.1 and 4](05-anchors-and-layout.md#21-anchor-canonicalization-v1), [Source Coordination Section 1](18-source-coordination-and-persistence-operations.md#1-source-offset-maps-and-multi-pane-admission), and [Testing Sections 2.6, 2.7, 3, and 4](10-testing-and-acceptance.md#26-anchor-reflow).
- `P4-D2`: [Anchors Section 3](05-anchors-and-layout.md#3-initial-binding-inference) and [Testing Sections 2.7 and 4](10-testing-and-acceptance.md#27-automatic-binding-and-variable-width).
- `P4-D3`: [Anchors Sections 4, 6, and 8](05-anchors-and-layout.md#4-markdown-edits-and-reflow), [SVG Sections 2 and 8](06-svg-rendering.md#2-scene-layers), and [Testing Sections 2.6, 2.7, and 4](10-testing-and-acceptance.md#26-anchor-reflow).
- `P4-D4`: [Anchors Sections 2.2 and 5](05-anchors-and-layout.md#22-object-attachments), [Operations Section 2](16-operations-sessions-and-recovery.md#2-closed-annotation-operation-union), and [Testing Sections 2.6, 2.7, 2.11, and 3](10-testing-and-acceptance.md#26-anchor-reflow).
- `P4-D5`: [Architecture Sections 5 and 8](04-architecture.md#5-note-sessions-and-multiple-views), [Anchors Sections 4 and 6](05-anchors-and-layout.md#4-markdown-edits-and-reflow), and [Testing Section 2.7](10-testing-and-acceptance.md#27-automatic-binding-and-variable-width).
- `P4-E1` to `P4-E4`: [Testing Sections 2.6, 2.7, 3, and 4](10-testing-and-acceptance.md#26-anchor-reflow). `P4-E5`: [Quality Section 5](09-quality-and-performance.md#5-performance-gates) and [Testing Section 6](10-testing-and-acceptance.md#6-performance-acceptance).

### Deliverables

- [ ] **P4-D1:** Implement exact block classification, fingerprinting, code-point-safe contexts, boundary associations, offset-map application, and bounded external reattachment.
- [ ] **P4-D2:** Implement `BindingInferenceProfileV1`, bounded candidate lookup, deterministic highlight, underline, enclosure, text-position, and fixed classification, confidence, and tie-breaking.
- [ ] **P4-D3:** Implement fragment, transform, and enclosure projection per view, signed margins, variable-width reflow, stale-token rejection, and degraded or orphaned states.
- [ ] **P4-D4:** Implement manual binding correction, move-and-reanchor batches, Group binding updates, and attached-endpoint reverse-index invalidation.
- [ ] **P4-D5:** Preserve canonical geometry during reflow and share only viewport-independent results across panes.

### Exit evidence

- [ ] **P4-E1:** Unicode, context, fingerprint, boundary-association, offset composition, threshold edge, enclosure-margin, stale-token, and reattachment goldens pass.
- [ ] **P4-E2:** Two widths of one note yield separate correct projections from one canonical scene with no sidecar mutation caused by width alone.
- [ ] **P4-E3:** Manual move and correction create one exact reversible operation. Pure zoom creates no inference, history, recovery, or save work.
- [ ] **P4-E4:** Attached Line and Arrow endpoint projection and target reflow remain proportional to reverse-index fanout and pass the 1,024/1,025 boundary.
- [ ] **P4-E5:** Binding, range, enclosure, reflow, and external-reattachment performance rows pass on every applicable supported environment.

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

### Exact implementation references

- `P5-D1` to `P5-D3`: [Toolbar Sections 1 to 7](03-toolbar-and-stylebar.md#1-surface-model), [Interaction Sections 2, 3, and 7](02-interaction-and-tools.md#2-tool-set), [Settings Sections 2 to 5](08-settings.md#2-general), and [Testing Sections 2.9 and 5](10-testing-and-acceptance.md#29-toolbar-and-stylebar).
- `P5-D4`: [Host Contract Section 7](14-obsidian-host-contract.md#7-host-native-user-interface), [Settings Section 8](08-settings.md#8-commands-and-hotkeys), and [Testing Sections 2.9, 5, and 8.6](10-testing-and-acceptance.md#29-toolbar-and-stylebar).
- `P5-D5`: [Settings Sections 1 to 9](08-settings.md#1-settings-principles), [Host Contract Section 8](14-obsidian-host-contract.md#8-settings-contract), and [Testing Section 8.7](10-testing-and-acceptance.md#87-settings-and-vault).
- `P5-E1`: [Testing Sections 2.9, 5, 8.6, and 8.7](10-testing-and-acceptance.md#29-toolbar-and-stylebar). `P5-E2`: [Quality Section 5](09-quality-and-performance.md#5-performance-gates) and [Testing Section 6](10-testing-and-acceptance.md#6-performance-acceptance).
- `P5-E3`: [Testing Section 8.7](10-testing-and-acceptance.md#87-settings-and-vault). `P5-E4`: [Toolbar Section 8](03-toolbar-and-stylebar.md#8-mockup-contract) and [Toolbar Mockup Non-Goals](12-toolbar-mockup.md#non-goals).

### Deliverables

- [ ] **P5-D1:** Implement a small reusable control library for color, width, independent outline and fill opacity, pressure, caps, dash, fill, sliders, segmented choices, menus, and mixed selection state.
- [ ] **P5-D2:** Implement the retained per-view toolbar host, independent always-visible Show or Hide toggle, Floating and Docked toolbar, contextual stylebar, responsive overflow, fixed group membership, configurable order, focus restoration, and 44-CSS-pixel compact targets.
- [ ] **P5-D3:** Implement production controls for completed tools and binding correction. Construction controls are wired to stable ports and become enabled only with Phase 6 implementations; no milestone build may present an action as functional before its command exists.
- [ ] **P5-D4:** Implement Obsidian commands, host Hotkeys ownership, native Menu and Modal surfaces, safe DOM, Obsidian icons, logical CSS, RTL, visible status, and accessible live regions.
- [ ] **P5-D5:** Implement the imperative 1.8.7 settings tab, complete validated plugin-global and device-local snapshots, defaults, storage policy, toolbar order, write failure with Retry, guarded external-change reload, diagnostics, and reset.

### Exit evidence

- [ ] **P5-E1:** Toolbar, stylebar, settings, command, focus, keyboard, screen-reader, touch, narrow-width, reduced-motion, default light, default dark, and forced-colors or high-contrast tests pass.
- [ ] **P5-E2:** Tool or style changes rerender only subscribed coarse UI subtrees. Pointer, scene, scroll, culling, and worker changes cause zero unrelated React commits.
- [ ] **P5-E3:** Settings corruption, migration, failed persistence, guarded external notification, settings-tab reopen reload, root rename, and cross-device locator behavior pass.
- [ ] **P5-E4:** The mockup remains non-normative and no product behavior is inferred only from it.

## Phase 6: Shapes, Construction, Attachments, Groups, and Clipboard

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

### Exact implementation references

- `P6-D1`: [Interaction Section 2.3](02-interaction-and-tools.md#23-tool-specific-behavior), [Domain Sections 3 to 5](15-domain-model-and-codecs.md#3-geometry-records), [SVG Sections 4 and 6](06-svg-rendering.md#4-shapes-and-construction-objects), and [Testing Sections 2.11, 2.12, and 4](10-testing-and-acceptance.md#211-lines-tables-and-axes).
- `P6-D2` and `P6-D3`: [Product Scope Section 2.2](01-product-scope.md#22-construction-objects), [Interaction Section 2.3](02-interaction-and-tools.md#23-tool-specific-behavior), [Toolbar Section 4.6](03-toolbar-and-stylebar.md#46-axes-and-tables), [Domain Sections 3 and 5](15-domain-model-and-codecs.md#3-geometry-records), and [Testing Section 2.11](10-testing-and-acceptance.md#211-lines-tables-and-axes).
- `P6-D4`: [Interaction Sections 3 to 5](02-interaction-and-tools.md#3-selection-and-manipulation), [Domain Sections 4, 6, and 7](15-domain-model-and-codecs.md#4-object-ports-and-attached-linear-endpoints), [Operations Section 2](16-operations-sessions-and-recovery.md#2-closed-annotation-operation-union), and [Testing Sections 2.11, 2.12, 3, 4, and 5](10-testing-and-acceptance.md#211-lines-tables-and-axes).
- `P6-D5`: [Toolbar Sections 2 to 4](03-toolbar-and-stylebar.md#2-toolbar-contents), [SVG Section 9](06-svg-rendering.md#9-worker-and-ui-framework-boundaries), and [Testing Sections 2.9 and 6](10-testing-and-acceptance.md#29-toolbar-and-stylebar).
- `P6-E1` to `P6-E3`: [Testing Sections 2.11, 2.12, 3, and 4](10-testing-and-acceptance.md#211-lines-tables-and-axes). `P6-E4`: [Quality Section 5](09-quality-and-performance.md#5-performance-gates) and [Testing Section 6](10-testing-and-acceptance.md#6-performance-acceptance).

### Deliverables

- [ ] **P6-D1:** Implement Rectangle, Ellipse, Triangle, Diamond, Octagon, Line, Arrow, endpoint caps, optional stable-port attachment for either linear endpoint, and Line or Arrow quadratic curve control.
- [ ] **P6-D2:** Implement the one Coordinate system tool with 2D or 3D creation choice, semantic vectors, individual axis-length controls, shared move, and rigid rotation.
- [ ] **P6-D3:** Implement one semantic Table with Rows and Columns creation and selected-object controls, whole-frame move, resize, rotation, and constrained divider editing.
- [ ] **P6-D4:** Implement linear, area, axis-set, and aggregate selection models, Group operations, z-order, duplicate, cut, copy, paste, target menus, and dependency-closed delete.
- [ ] **P6-D5:** Integrate construction tools into the Phase 5 toolbar and stylebar without adding per-element React components.

### Exit evidence

- [ ] **P6-E1:** Every tool passes creation, selection, style, transform, constant-width, binding, save, reload, exact Undo or Redo, cancellation, clipboard, and malicious-input tests.
- [ ] **P6-E2:** Line and Arrow may remain straight or curve while either endpoint is free or attached. Every valid port, attachment, move, reflow, delete-detach, and Undo path passes without a scene scan.
- [ ] **P6-E3:** Table rows, columns, dividers, minimum tracks, rotation, axes vectors, grid guides, limits, Groups, and order pass exact semantic and composed-path tests.
- [ ] **P6-E4:** Single and aggregate transforms keep style bytes and line widths unchanged, remain atomic, and pass 5,000- and 10,000-element applicable budgets.

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
- [Obsidian Host Contract](14-obsidian-host-contract.md), Reading View and Android

### Exact implementation references

- `P7-D1`: [Anchors Section 7](05-anchors-and-layout.md#7-background-alignment), [Toolbar Section 4.8](03-toolbar-and-stylebar.md#48-background), [Settings Section 5](08-settings.md#5-note-appearance-and-zoom), and [Testing Section 2.8](10-testing-and-acceptance.md#28-background-alignment).
- `P7-D2`: [Interaction Section 6](02-interaction-and-tools.md#6-whole-note-zoom), [Anchors Section 9](05-anchors-and-layout.md#9-zoom-and-layout), [Settings Section 5](08-settings.md#5-note-appearance-and-zoom), and [Testing Section 2.10](10-testing-and-acceptance.md#210-zoom).
- `P7-D3`: [Architecture Section 7](04-architecture.md#7-reading-view-integration), [Anchors Section 8](05-anchors-and-layout.md#8-reading-view-resolution), [Host Contract Section 6](14-obsidian-host-contract.md#6-reading-view-contract), and [Testing Sections 8.3 and 8.5](10-testing-and-acceptance.md#83-workspace-and-views).
- `P7-D4`: [Architecture Sections 4 and 8](04-architecture.md#4-plugin-lifecycle), [Host Contract Sections 3 and 4](14-obsidian-host-contract.md#3-startup-ownership-and-disposal), and [Testing Sections 2.8 and 8.2 to 8.5](10-testing-and-acceptance.md#28-background-alignment).
- `P7-E1` to `P7-E3`: [Testing Sections 2.7, 2.8, 2.10, and 8.5](10-testing-and-acceptance.md#27-automatic-binding-and-variable-width). `P7-E4`: [Quality Section 5](09-quality-and-performance.md#5-performance-gates) and [Testing Section 6](10-testing-and-acceptance.md#6-performance-acceptance).

### Deliverables

- [ ] **P7-D1:** Implement none, ruled, squared, and dotted backgrounds with block-scoped measured rhythm, whole-view fallback ownership, section-owned overrides, bounded region merging, and truthful unavailable-metric degradation.
- [ ] **P7-D2:** Implement 50 to 400 percent whole-note zoom through controls and pinch, shared note and overlay transforms, pointer inversion, focus preservation, viewport preservation, and bounded device-local remembered zoom.
- [ ] **P7-D3:** Complete Reading View section reporting, source evidence, one whole-note overlay, read-only projections, background ownership, section reprocessing, and disposal.
- [ ] **P7-D4:** Integrate theme, font, writing width, mode, resize, scroll, and pop-out invalidation with revision-bound layout publication.

### Exit evidence

- [ ] **P7-E1:** The complete background formula, ownership, region-limit, mode, width, theme, font, zoom, hit-test, empty-note, and unavailable-metric matrix passes.
- [ ] **P7-E2:** Reading View never mutates scene, Markdown, history, recovery, or sidecars and never duplicates overlays, children, observers, or background regions.
- [ ] **P7-E3:** Pure zoom reuses layout metrics when logical width is unchanged and creates no canonical mutation, reclassification, history, or save work.
- [ ] **P7-E4:** Scroll, zoom, culling, background, presentation, dropped-frame, paint, memory, pop-out, and teardown budgets pass all applicable release cells.

## Phase 8: Release Hardening

### Required specifications

All documents in the [Specification Index](00-readme.md) and every accepted ADR apply.

### Exact implementation references

- `P8-D1` and `P8-D2`: [Quality Sections 2.3, 4, and 5](09-quality-and-performance.md#23-release-validation) and [Testing Sections 6 to 8](10-testing-and-acceptance.md#6-performance-acceptance).
- `P8-D3`: [Quality Sections 7 to 10](09-quality-and-performance.md#7-security-and-privacy) and [Testing Sections 5, 7, and 8](10-testing-and-acceptance.md#5-accessibility-tests).
- `P8-D4`: [Quality Sections 4 to 6](09-quality-and-performance.md#4-performance-workload) and [Testing Section 6](10-testing-and-acceptance.md#6-performance-acceptance).
- `P8-D5`: [Host Contract Sections 2 and 11](14-obsidian-host-contract.md#2-package-and-manifest), [GitHub and CI Sections 3 to 5](17-github-and-ci.md#3-workflows), and [Testing Sections 8.1 and 8.8](10-testing-and-acceptance.md#81-package-and-compatibility).
- `P8-E1` to `P8-E4`: [Testing Section 7](10-testing-and-acceptance.md#7-coverage-and-test-completeness), [Quality Sections 7 to 10](09-quality-and-performance.md#7-security-and-privacy), [Host Contract Sections 11 and 12](14-obsidian-host-contract.md#11-public-release-and-community-directory), and [GitHub and CI Sections 3 and 4](17-github-and-ci.md#3-workflows).

### Deliverables

- [ ] **P8-D1:** Freeze the real benchmark fixtures, performance thresholds, supported host and device list, screen-reader coverage, and manual procedures before observing release-candidate results.
- [ ] **P8-D2:** Run CI and every applicable integration, performance, accessibility, and real-device suite against one production artifact on named desktop and Android environments, including Android tablet and phone cells.
- [ ] **P8-D3:** Complete WCAG 2.2 AA manual review, security abuse review, dependency audit, license review, privacy and legal-applicability assessment, and 50-cycle lifecycle leak checks.
- [ ] **P8-D4:** Pass every 5,000-element minimum-capacity and 10,000-element stress workflow, including open, mutation readiness, draw, select, lasso, resize, Table, axes, reflow, save, conflict, recovery, Undo or Redo, unload, paint, dropped frames, and memory.
- [ ] **P8-D5:** Finalize public `README.md`, compatible `LICENSE`, real publisher metadata, accurate local-data and sidecar disclosures, Community policy evidence, manifest, package, `versions.json` when required, tag, draft release, and the three loadable artifacts.

### Exit evidence

- [ ] **P8-E1:** Every implemented capability has passing automated tests or an explicit manual acceptance procedure where automation is not practical.
- [ ] **P8-E2:** No unresolved critical or high security finding, data-loss case, stale conflict, Android input regression, accessibility blocker, persistent resource leak, uncalibrated critical path, or failed quality gate remains.
- [ ] **P8-E3:** The release report names changes, exact checks and results, checks not executed with reasons, compatibility cells, residual risks, uncertainty, and the factual legal-applicability assessment.
- [ ] **P8-E4:** A draft release is reviewed manually before publication. Commit, push, tag, and publication remain explicit user-authorized actions.
