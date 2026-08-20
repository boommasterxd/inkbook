# Implementation Roadmap

This roadmap is dependency-ordered. A phase begins only after every prior exit criterion passes. Later work MUST NOT compensate for a failed earlier contract. Every change passes Per-Commit CI, and every phase exit passes the applicable suites in [Quality and Performance](09-quality-and-performance.md). Verification belongs in the existing executable test, build, or release command that owns the behavior. Phase work MUST NOT create requirement inventories, traceability checkers, documentation tests, placeholder manifests, duplicate status systems, generic evidence frameworks, or phase-specific runner hierarchies.

## Status Protocol

Every deliverable and exit item has a stable phase ID and a Markdown checkbox. An implementation change MUST update the affected checkboxes in this file in the same change.

- `[x]` means the complete item exists in the current repository and its referenced automated checks, plus the one designated phase-sanity item where applicable, have passed.
- `[ ]` means the item is absent, partial, stale, regressed, or not yet verified. Partial work remains unchecked and MAY be described after the item without implying completion.
- An automated exit item is checked only after its executable tests pass. A phase-sanity item records the tested production artifact, pass or fail, and an optional short observation.
- A phase is complete only when every `P<n>-D*` deliverable and every `P<n>-E*` exit item in that phase is checked.
- A failed or no-longer-reproducible result resets the affected checkbox to `[ ]`.
- Every code-testable requirement is verified automatically through the existing test and CI commands. Each phase has exactly one concise phase-sanity exit ID from [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios). The sanity scenario runs only after automation passes, uses one representative user-available environment, and never carries performance, coverage, compatibility-matrix, resource, or fault-injection proof.
- Normative changes that alter implementation work update the affected roadmap checkbox and its direct specification links. Existing IDs are not silently renumbered or reused.
- Phase IDs and phase names are planning metadata only. No source, test, configuration, script, fixture, artifact, or documentation file or directory name MAY contain a phase ID, phase number, or phase name. Existing Phase 0 paths are temporary debt owned by `P1-D7`; no new phase-named path may be introduced. Production modules, exported or runtime identifiers, command IDs, UI copy, CSS classes, storage keys, schemas, status messages, and release artifacts MUST use stable product or domain terminology from their introduction. Temporary probes, milestone flags, synthetic payloads, debug registrations, and migration scaffolds MUST have an explicit removal phase or be compile-time excluded from production. Roadmaps, decisions, normal test output, and test descriptions MAY mention phase IDs in their content when necessary for planning clarity. This permission does not require a traceability system.

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

- `P0-D1`: [Host Contract Sections 1 to 3](14-obsidian-host-contract.md#1-compatibility-baseline), [Quality Sections 1 to 3](09-quality-and-performance.md#1-code-quality-requirements), and [Toolchain Decision](../decisions/0002-toolchain-and-build.md#decision).
- `P0-D2`: [Host Contract Sections 1 to 3](14-obsidian-host-contract.md#1-compatibility-baseline), [Quality Sections 1 to 3](09-quality-and-performance.md#1-code-quality-requirements), and [Toolchain Decision](../decisions/0002-toolchain-and-build.md#decision).
- `P0-D3`: [GitHub and CI Sections 1 to 4 and 6](17-github-and-ci.md#1-repository) and [Testing Section 8.8](10-testing-and-acceptance.md#88-android-and-release).
- `P0-D4`: [Testing Sections 1 and 7](10-testing-and-acceptance.md#1-test-layers) and [Quality Section 2.1](09-quality-and-performance.md#21-per-commit-ci).
- `P0-D5`: [Architecture Sections 4 to 7](04-architecture.md#4-plugin-lifecycle), [Host Contract Sections 3 to 6](14-obsidian-host-contract.md#3-startup-ownership-and-disposal), and [Testing Sections 8.2, 8.3, and 8.5](10-testing-and-acceptance.md#82-startup-and-lifecycle).
- `P0-D6`: [Interaction Sections 1, 5, 6, and 7](02-interaction-and-tools.md#1-input-routing-invariants), [Host Contract Sections 5 and 10](14-obsidian-host-contract.md#5-editor-and-codemirror-contract), and [Testing Sections 2.4, 2.10, 5, 8.4, and 8.8](10-testing-and-acceptance.md#24-touch-routing).
- `P0-D7`: [Architecture Sections 6 and 9](04-architecture.md#6-editor-integration), [Operations Sections 1 and 4 to 6](16-operations-sessions-and-recovery.md#1-operation-identity-and-common-contract), and [Testing Sections 2.3, 3, and 8.4](10-testing-and-acceptance.md#23-unified-undo-and-redo).
- `P0-D8`: [Architecture Section 3.7](04-architecture.md#37-worker-scheduler), [SVG Section 9](06-svg-rendering.md#9-worker-and-ui-framework-boundaries), [Host Contract Section 10](14-obsidian-host-contract.md#10-android-and-worker-compatibility), and [Testing Sections 6, 8.2, and 8.8](10-testing-and-acceptance.md#6-performance-acceptance).
- `P0-D9`: [Sidecar Section 9](07-sidecar-persistence.md#9-recovery), [Operations Section 6](16-operations-sessions-and-recovery.md#6-recovery-records-and-store), [Host Contract Section 10](14-obsidian-host-contract.md#10-android-and-worker-compatibility), and [Testing Sections 3 and 8.8](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P0-D10`: [Quality Sections 4 to 6](09-quality-and-performance.md#4-performance-workload), [Testing Sections 6 and 8.1](10-testing-and-acceptance.md#6-performance-acceptance), [Host Contract Sections 2 and 3](14-obsidian-host-contract.md#2-package-and-manifest), and [GitHub and CI Section 5](17-github-and-ci.md#5-automated-performance-results).
- `P0-E1`: [Quality Sections 2 and 3](09-quality-and-performance.md#2-required-quality-lanes), [Testing Sections 8.1 and 8.8](10-testing-and-acceptance.md#81-package-and-compatibility), [Host Contract Sections 2 and 11](14-obsidian-host-contract.md#2-package-and-manifest), and [GitHub and CI Sections 1, 3, and 4](17-github-and-ci.md#1-repository).
- `P0-E2`: [Testing Sections 2.3, 3, and 8.4](10-testing-and-acceptance.md#23-unified-undo-and-redo), [Operations Sections 5 and 6](16-operations-sessions-and-recovery.md#5-host-history-effect-lifecycle), and [Host-History Decision](../decisions/0003-host-history-and-recovery-feasibility.md#decision).
- `P0-E3`: [Testing Sections 8.2, 8.3, and 8.5](10-testing-and-acceptance.md#82-startup-and-lifecycle) and [Host Contract Sections 3 to 6](14-obsidian-host-contract.md#3-startup-ownership-and-disposal).
- `P0-E4`: [Testing Sections 3, 8.2, and 8.8](10-testing-and-acceptance.md#3-persistence-and-fault-tests), [Host Contract Section 10](14-obsidian-host-contract.md#10-android-and-worker-compatibility), and [Operations Section 6](16-operations-sessions-and-recovery.md#6-recovery-records-and-store).
- `P0-E5`: [Host-History Decision](../decisions/0003-host-history-and-recovery-feasibility.md#decision), [Testing Section 2.3](10-testing-and-acceptance.md#23-unified-undo-and-redo), and [Operations Sections 5 and 6](16-operations-sessions-and-recovery.md#5-host-history-effect-lifecycle).
- `P0-E6`: [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) and [Quality Section 2.2](09-quality-and-performance.md#22-phase-exit-validation).
- `P0-E7`: [Quality Sections 4 to 6](09-quality-and-performance.md#4-performance-workload), [Testing Sections 6 and 8.1](10-testing-and-acceptance.md#6-performance-acceptance), [Host Contract Sections 2 and 3](14-obsidian-host-contract.md#2-package-and-manifest), and [GitHub and CI Section 5](17-github-and-ci.md#5-automated-performance-results).

### Deliverables

- [x] **P0-D1:** Maintain a minimal desktop- and Android-capable plugin with `package.json`, one npm-generated lockfile, the selected Node.js 26 runtime, npm, strict `tsconfig.json`, `manifest.json`, `src/main.ts`, `src/styles.css`, and the ignored `dist/` production staging directory.
- [x] **P0-D2:** Record the rolling-current version policy and exact compatible resolutions in `docs/decisions/0002-toolchain-and-build.md`. Keep only tools used by an executable build or test.
- [x] **P0-D3:** Maintain the private GitHub repository, Dependabot, least-privilege base workflows, required checks, branch and tag rulesets, gitleaks updater, and draft-release foundation from [GitHub and CI](17-github-and-ci.md).
- [x] **P0-D4:** Maintain the automation-first test foundation under `test/`: deterministic host, CodeMirror, DOM, storage, worker, lifecycle, virtual-time, fault, race, recovery, disposal, and misuse tests. `npm run ci` is the phase-verification entry point; no separate runner or written manual substitute is required.
- [x] **P0-D5:** Build production-shaped attachment probes for Live Preview, Source, Reading View, split panes, deferred leaves, non-Markdown leaves, Bases, desktop pop-outs, layout readiness, lifecycle ownership, and unload.
- [x] **P0-D6:** Build the actual two-pointer zoom recognizer, secondary-button routing, plugin-element touch selection, native context-menu preservation, CodeMirror virtualization, native text selection, IME, and software-keyboard probes. Automated regression coverage anchors probe scaling at its visible center without position drift, and the exact rebuilt production package was confirmed through the Phase 0 sanity scenario.
- [x] **P0-D7:** Build one isolated invertible annotation-effect bridge in existing host history using bounded `HostEffectEnvelopeV1` handles to stable revision-free history entries, monotonic per-editor and per-epoch host transaction sequences with retained high-water marks, fresh revision-bound dispatches for Forward, Undo, and Redo, one owner-pane lease, epoch handoff, and no second history extension or keymap. Probe unload and re-enable while a host effect remains reachable: the plugin MUST either restore the complete actionable history state before accepting that effect or prove the effect unreachable and fail closed.
- [x] **P0-D8:** Build a static worker payload inside `main.js` with launch, transfer, cancellation, crash, URL revocation, unavailable-worker fallback, and disposal probes.
- [x] **P0-D9:** Build the transactional IndexedDB recovery probe with schema creation, atomic prepare and host-recorded transition, abort, quota, restart, corruption, cleanup, and disposal.
- [x] **P0-D10:** Keep performance and resource verification inside existing tests and the production build: bounded worker queues and bytes, IndexedDB budgets, retained-view limits, synchronous current-sample zoom, deterministic fallback slicing, disposal, and package construction. Later phases follow the same subsystem-local approach. Do not add a separate performance framework or plugin-wide resource ledger without measured cross-subsystem pressure that local limits cannot bound.

### Exit evidence

- [x] **P0-E1:** The reviewed lockfile resolves the newest stable mutually compatible toolchain and dependency versions. All three required GitHub checks protect `main`, and the package contains only `main.js`, `manifest.json`, and `styles.css` while passing CI.
- [x] **P0-E2:** Markdown A, annotation B, and Markdown C undo and redo in exact host order on every selected desktop and Android cell. Branching, delayed duplicate Forward after Undo, delayed duplicate Inverse after Redo, rapid Undo or Redo, pane conflict, epoch handoff, recovery failure, disposal, unload with a reachable effect, re-enable, and restart fail safely.
- [x] **P0-E3:** Each concrete Obsidian editor owns exactly one bounded ViewPlugin value; Reading View children and the one view overlay dispose without duplication.
- [x] **P0-E4:** Worker and IndexedDB contracts pass on every supported environment. The unavailable-worker fallback is safe but does not substitute for a required worker-capable release environment.
- [x] **P0-E5:** A reviewed `docs/decisions/0003-host-history-and-recovery-feasibility.md` records the proven public or guarded host boundary and exact unsupported cases.
- [x] **P0-E6:** The Phase 0 scenario in [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) passed on the exact production package with `main.js` SHA-256 `ac708f53fb2ff579b92c757ba4d60ff9454e4165609fd6933e54a2cc473c4d90`: native Markdown remained usable, the transient input probe appeared, and zoom kept the probe center fixed.
- [x] **P0-E7:** The existing automated suite and production build pass all Phase 0 structural performance and resource contracts. Physical timing claims remain deferred until the corresponding product path exists and a controllable automated host can measure it. Simulation is not physical-device proof.

If unified host history, transactional recovery, required view attachment, or Android worker launch cannot be proven, broad feature implementation stops. The architecture, supported modes, device matrix, or minimum Obsidian version must change explicitly before Phase 1.

## Phase 1: Canonical Domain, Operations, and Recovery

### Required specifications

- [Architecture](04-architecture.md)
- [Anchors and Layout](05-anchors-and-layout.md), serialized binding and anchor records only
- [Sidecar Persistence](07-sidecar-persistence.md), schema and limits only
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [Obsidian Host Contract](14-obsidian-host-contract.md), production package, lifecycle, and user-interface boundaries only
- [Domain Model and Codecs](15-domain-model-and-codecs.md)
- [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md)

### Exact implementation references

- `P1-D1`: [Domain Sections 1 to 6](15-domain-model-and-codecs.md#1-scalar-and-identity-types) and [Anchors Section 2](05-anchors-and-layout.md#2-binding-types).
- `P1-D2`: [Domain Sections 8 and 9](15-domain-model-and-codecs.md#8-delta-varint-v1-wire-format), [Sidecar Sections 3, 4, and 10](07-sidecar-persistence.md#3-top-level-schema), and [Testing Sections 3 and 4](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P1-D3`: [Operations Sections 1 to 6](16-operations-sessions-and-recovery.md#1-operation-identity-and-common-contract), [Source Coordination Sections 1 to 3](18-source-coordination-and-persistence-operations.md#1-source-offset-maps-and-multi-pane-admission), and [Testing Section 3](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P1-D4`: [Operations Sections 1 to 6](16-operations-sessions-and-recovery.md#1-operation-identity-and-common-contract), [Source Coordination Sections 1 to 3](18-source-coordination-and-persistence-operations.md#1-source-offset-maps-and-multi-pane-admission), and [Testing Section 3](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P1-D5`: [Operations Section 6](16-operations-sessions-and-recovery.md#6-recovery-records-and-store), [Sidecar Section 9](07-sidecar-persistence.md#9-recovery), and [Testing Section 3](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P1-D6`: [Domain Sections 4 and 6](15-domain-model-and-codecs.md#4-object-ports-and-attached-linear-endpoints), [SVG Section 4.1](06-svg-rendering.md#41-selection-geometry), and [Testing Sections 2.11, 2.12, and 4](10-testing-and-acceptance.md#211-lines-tables-and-axes).
- `P1-D7`: [Host Contract Sections 2, 3, and 7](14-obsidian-host-contract.md#2-package-and-manifest), [Quality Sections 2.1, 3, 4, and 5](09-quality-and-performance.md#21-per-commit-ci), and [Testing Sections 7, 8.1, 8.2, and 8.6](10-testing-and-acceptance.md#7-coverage-and-test-completeness).
- `P1-E1`: [Quality Sections 2.2 and 3](09-quality-and-performance.md#22-phase-exit-validation) and [Testing Sections 3, 4, and 7](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P1-E2`: [Architecture Sections 1 and 2](04-architecture.md#1-architectural-goals), [Quality Section 3](09-quality-and-performance.md#3-architecture-gates), and [Testing Sections 4 and 7](10-testing-and-acceptance.md#4-geometry-and-rendering-tests).
- `P1-E3`: [Domain Sections 6 and 9](15-domain-model-and-codecs.md#6-groups-object-order-and-scene-state), [Quality Sections 4 to 6](09-quality-and-performance.md#4-performance-workload), and [Testing Sections 4 and 6](10-testing-and-acceptance.md#4-geometry-and-rendering-tests).
- `P1-E4`: [Operations Section 6](16-operations-sessions-and-recovery.md#6-recovery-records-and-store), [Quality Section 6](09-quality-and-performance.md#6-resource-efficiency), and [Testing Section 3](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P1-E5`: [Host Contract Sections 2, 3, and 7](14-obsidian-host-contract.md#2-package-and-manifest), [Quality Sections 2.1, 3, and 5](09-quality-and-performance.md#21-per-commit-ci), and [Testing Sections 7, 8.1, 8.2, and 8.6](10-testing-and-acceptance.md#7-coverage-and-test-completeness).
- `P1-E6`: [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) and [Quality Section 2.2](09-quality-and-performance.md#22-phase-exit-validation).

### Deliverables

- [x] **P1-D1:** Implement branded IDs, revisions, points, vectors, styles, geometries, bindings, ports, attachments, elements, Groups, object order, note appearance, persistent path-copy `RuntimeSceneStateV1`, and flat codec-only `SerializedSceneStateV1` in framework-independent domain modules.
- [x] **P1-D2:** Implement complete validation in the specified order, canonical RFC 8785 serialization, SHA-256 boundaries, and exact `delta-varint-v1` encoding and decoding.
- [x] **P1-D3:** Implement the closed revision-free patch union, sparse Group replacements, fresh dispatch envelopes, stable history entries, metadata-free batch members, exact non-revision inverse derivation, monotonic component-generation rules without ABA, dependency closure, operation-specific order placement, attached Line and Arrow endpoint authority, and Group leaf-block order equality.
- [x] **P1-D4:** Implement the pure command-admission function, closed errors, session snapshot types, host-effect lifecycle, recovery attempts, source-checkpoint records, and relocation or removal record codecs.
- [x] **P1-D5:** Turn the Phase 0 IndexedDB probe into the production `RecoveryStore` adapter with transactional compare-and-swap, exact byte accounting, bounded cleanup, corruption handling, and idempotent disposal.
- [x] **P1-D6:** Implement pure selection-model derivation and object-port resolution for attached Line and Arrow endpoints without DOM or Obsidian imports.
- [x] **P1-D7:** Replace the Phase 0 probe composition root with the production feature composition. Rename retained phase-named source and mirrored test paths to stable functional names, remove probe commands, Notices, marker UI, probe CSS, and synthetic payloads from the production bundle, and preserve only reusable history, recovery, worker, lifecycle, and gesture code with its focused regression tests.

### Exit evidence

- [x] **P1-E1:** Unit, property, fuzz, codec-golden, inverse, revision, attachment, Group, order, resource-limit, corruption, and RecoveryStore fault tests pass at required coverage.
- [x] **P1-E2:** Every public domain type is deeply immutable and its import direction passes the architecture checker.
- [x] **P1-E3:** Deterministic 5,000- and 10,000-element scene generators produce schema-valid canonical scenes whose future sidecar encoding fits all simultaneous V1 limits, while one-element and one-Group publications path-copy only affected runtime-store branches and allocate no flat scene-array spine.
- [x] **P1-E4:** Repeated recovery cycles remain within 8 MiB per note and exact cleanup leaves no actionable host handle without its operation.
- [x] **P1-E5:** Existing source search, architecture, dead-code, test, and build checks find no phase-named production or test path. Direct inspection of the exact three-file production package finds no probe command, Notice, overlay, menu, style, synthetic payload, debug registration, or Phase 0 identifier. Reusable subsystem regressions pass from neutral paths, and unload leaves no owned listener, observer, timer, worker, port, queue turn, pointer capture, framework root, or view adapter. No separate artifact scanner or diagnostics build is required.
- [x] **P1-E6:** After every automated Phase 1 gate passes, complete only the Phase 1 no-regression scenario in [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) and report pass or fail.

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
- `P2-D3`: [Sidecar Sections 1 to 6 and 8 to 10](07-sidecar-persistence.md#1-storage-decision), [Source Coordination Section 2](18-source-coordination-and-persistence-operations.md#2-initial-sidecar-and-save-acknowledgement), and [Testing Sections 2.1, 2.2, 3, and 8.7](10-testing-and-acceptance.md#21-native-markdown).
- `P2-D4`: [Sidecar Sections 6 to 8](07-sidecar-persistence.md#6-conflict-handling), [Source Coordination Section 3](18-source-coordination-and-persistence-operations.md#3-relocation-and-removal-records), and [Testing Sections 3 and 8.7](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P2-D5`: [Settings Section 6](08-settings.md#6-storage-and-recovery), [Host Contract Sections 8 and 9](14-obsidian-host-contract.md#8-settings-contract), and [Testing Section 8.7](10-testing-and-acceptance.md#87-settings-and-vault).
- `P2-D6`: [Operations Sections 3 and 4](16-operations-sessions-and-recovery.md#3-revision-rules-and-command-results), [Quality Section 7.2](09-quality-and-performance.md#72-verification-and-data-minimization), and [Testing Sections 3 and 5](10-testing-and-acceptance.md#3-persistence-and-fault-tests).
- `P2-E1`: [Testing Section 3](10-testing-and-acceptance.md#3-persistence-and-fault-tests) and [Testing Section 8.7](10-testing-and-acceptance.md#87-settings-and-vault).
- `P2-E2`: [Testing Section 2.2](10-testing-and-acceptance.md#22-first-annotation), [Sidecar Sections 2 and 5](07-sidecar-persistence.md#2-yaml-presence-marker), and [Source Coordination Section 2](18-source-coordination-and-persistence-operations.md#2-initial-sidecar-and-save-acknowledgement).
- `P2-E3`: [Testing Sections 2.6 and 3](10-testing-and-acceptance.md#26-anchor-reflow), [Anchors Section 4](05-anchors-and-layout.md#4-markdown-edits-and-reflow), and [Source Coordination Section 1](18-source-coordination-and-persistence-operations.md#1-source-offset-maps-and-multi-pane-admission).
- `P2-E4`: [Testing Sections 3 and 8.7](10-testing-and-acceptance.md#3-persistence-and-fault-tests), [Sidecar Sections 6 to 8](07-sidecar-persistence.md#6-conflict-handling), and [Source Coordination Section 3](18-source-coordination-and-persistence-operations.md#3-relocation-and-removal-records).
- `P2-E5`: [Quality Sections 5 and 6](09-quality-and-performance.md#5-performance-gates) and [Testing Section 6](10-testing-and-acceptance.md#6-performance-acceptance).
- `P2-E6`: [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios), [Testing Section 3](10-testing-and-acceptance.md#3-persistence-and-fault-tests), and [Quality Section 2.2](09-quality-and-performance.md#22-phase-exit-validation).

### Deliverables

- [ ] **P2-D1:** Implement the production `NoteSessionRegistry`, bounded non-reentrant per-session queues, simple registry-wide session and queued-turn caps, immutable affected-ID publication, owner leases, reference counting, overlay suspension or readmission, headless flush, and exact lifecycle disposal. Each subsystem owns its count and byte limits; no generic cross-subsystem resource coordinator is introduced without measured aggregate pressure that these local limits cannot bound.
- [ ] **P2-D2:** Implement `MarkdownSourceCoordinator`, `SOURCE_COORDINATION_LIMITS_V1`, `SourceOffsetMapV1`, cross-pane duplicate admission, bounded composed-map graph, lazy history materialization, forced barriers, and bounded source recovery.
- [ ] **P2-D3:** Implement sidecar path policy, locator validation, synchronous marker callback, first-sidecar-pending state, revision-1 initial create, canonical load and save, global persistence permits, decoded-memory admission, compare-and-process, save-generation coalescing, conflicts, and newer-version read-only behavior.
- [ ] **P2-D4:** Implement external sidecar change handling, note and folder relocation sagas, storage-root persistence, conflict copies, orphan review, host-trash-only removal, and explicit storage-location migration.
- [ ] **P2-D5:** Implement the storage-policy schema and application port with adjacent default. The full settings screen remains Phase 5.
- [ ] **P2-D6:** Add sanitized persistence and recovery status models without React ownership of session state.

### Exit evidence

- [ ] **P2-E1:** All [Testing Section 3 persistence and fault cases](10-testing-and-acceptance.md#3-persistence-and-fault-tests) whose required production surfaces are delivered in Phases 0 through 2 pass against fakes and the Phase 0 test Vault. Endpoint attachment interaction, clipboard, construction, later binding projection, and every other later-surface case remain release-blocking in their explicitly assigned owning phase and do not block the Phase 2 exit before that surface exists.
- [ ] **P2-E2:** First annotation creates no empty sidecar and recovers every crash window exactly as specified.
- [ ] **P2-E3:** Two panes delivering one Markdown transition produce one source generation and checkpoint. Mismatches enter bounded reattachment or conflict without guessed mutation.
- [ ] **P2-E4:** Rename, folder rename, sync overwrite, marker drift, save race, migration interruption, restart, and trash barriers preserve acknowledged data and perform no unsafe overwrite.
- [ ] **P2-E5:** Cold 16 MiB parse, decoded-memory admission, multi-note blocked-I/O save scheduling, warm single-element save, source limits, checkpoint, queue saturation, detach, recovery, and memory budgets pass in every applicable automated suite.
- [ ] **P2-E6:** After every automated Phase 2 gate passes, complete only the Phase 2 two-pane reopen scenario in [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) and report pass or fail.

## Phase 3: Retained SVG and Basic Input

### Required specifications

- [Product Scope](01-product-scope.md)
- [Interaction and Tools](02-interaction-and-tools.md), Cursor, Pen, Highlighter, Eraser, Lasso, routing, selection, and history
- [Architecture](04-architecture.md)
- [Anchors and Layout](05-anchors-and-layout.md), annotation-aware bottom scroll extent
- [SVG Rendering](06-svg-rendering.md)
- [Quality and Performance](09-quality-and-performance.md)
- [Testing and Acceptance](10-testing-and-acceptance.md)
- [Obsidian Host Contract](14-obsidian-host-contract.md)
- [Domain Model and Codecs](15-domain-model-and-codecs.md)
- [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md)
- [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md)

### Exact implementation references

- `P3-D1`: [Product Scope Section 2](01-product-scope.md#2-core-user-capabilities), [Anchors Section 10](05-anchors-and-layout.md#10-annotation-aware-bottom-scroll-extent), [SVG Sections 1 to 6, 8, and 9](06-svg-rendering.md#1-decision), [Host Contract Section 5](14-obsidian-host-contract.md#5-editor-and-codemirror-contract), [Testing Sections 2.13, 4, 6, and 8.4](10-testing-and-acceptance.md#213-annotation-aware-bottom-scroll-extent), and [Quality Sections 4 to 6](09-quality-and-performance.md#4-performance-workload).
- `P3-D2`: [Interaction Section 1](02-interaction-and-tools.md#1-input-routing-invariants), [Interaction Section 3](02-interaction-and-tools.md#3-selection-and-manipulation), [Interaction Sections 5 and 7](02-interaction-and-tools.md#5-context-menus), [Anchors Section 9](05-anchors-and-layout.md#9-zoom-and-layout), [Host Contract Sections 4, 5, and 10](14-obsidian-host-contract.md#4-native-workspace-and-view-boundaries), [Testing Sections 2.4 and 2.5](10-testing-and-acceptance.md#24-touch-routing), [Testing Section 2.12](10-testing-and-acceptance.md#212-selection-models-and-constant-width-resize), and [Testing Sections 5 and 8.4](10-testing-and-acceptance.md#5-accessibility-tests).
- `P3-D3`: [Interaction Section 2](02-interaction-and-tools.md#2-tool-set), [SVG Sections 3, 7, 9, and 11](06-svg-rendering.md#3-stroke-representation), and [Testing Sections 2.4, 2.5, 4, and 6](10-testing-and-acceptance.md#24-touch-routing).
- `P3-D4`: [Architecture Section 9](04-architecture.md#9-publication-order), [Sidecar Sections 5 and 9](07-sidecar-persistence.md#5-save-protocol), [Operations Sections 1 to 6](16-operations-sessions-and-recovery.md#1-operation-identity-and-common-contract), and [Testing Sections 2.2, 2.3, and 3](10-testing-and-acceptance.md#22-first-annotation).
- `P3-D5`: [Host Contract Section 5](14-obsidian-host-contract.md#5-editor-and-codemirror-contract), [Settings Section 8](08-settings.md#8-commands-and-hotkeys), and [Testing Section 8.4](10-testing-and-acceptance.md#84-editor-integration).
- `P3-E1`: [Testing Sections 2.3 to 2.5](10-testing-and-acceptance.md#23-unified-undo-and-redo), [Testing Section 2.12](10-testing-and-acceptance.md#212-selection-models-and-constant-width-resize), [Testing Sections 3, 4, and 8.8](10-testing-and-acceptance.md#3-persistence-and-fault-tests), [Anchors Section 9](05-anchors-and-layout.md#9-zoom-and-layout), and [Host Contract Sections 4, 5, and 10](14-obsidian-host-contract.md#4-native-workspace-and-view-boundaries).
- `P3-E2`: [Testing Section 2.4](10-testing-and-acceptance.md#24-touch-routing), [Testing Section 2.12](10-testing-and-acceptance.md#212-selection-models-and-constant-width-resize), [Testing Sections 4 and 6](10-testing-and-acceptance.md#4-geometry-and-rendering-tests), [SVG Sections 7, 9, and 10](06-svg-rendering.md#7-gesture-rendering), and [Quality Sections 4 and 5](09-quality-and-performance.md#4-performance-workload).
- `P3-E3`: [Product Scope Section 2](01-product-scope.md#2-core-user-capabilities), [Testing Sections 2.12, 2.13, and 6](10-testing-and-acceptance.md#212-selection-models-and-constant-width-resize), and [Quality Sections 4 to 6](09-quality-and-performance.md#4-performance-workload).
- `P3-E4`: [Testing Sections 2.12, 2.13, 4, and 6](10-testing-and-acceptance.md#212-selection-models-and-constant-width-resize), [SVG Sections 4.1 to 7](06-svg-rendering.md#41-selection-geometry), and [Quality Sections 4 to 6](09-quality-and-performance.md#4-performance-workload).
- `P3-E5`: [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios), [Testing Sections 2.1, 2.3, and 2.4](10-testing-and-acceptance.md#21-native-markdown), and [Quality Section 2.2](09-quality-and-performance.md#22-phase-exit-validation).

### Deliverables

- [ ] **P3-D1:** Implement retained SVG layers, incremental spatial, stroke-segment, selectable-order, and annotation-bottom indices, `OVERSCAN_PROFILE_V1`, bounded candidate continuations, geometry and paint bounds, annotation-aware bottom scroll extent, culling, cache limits, view transforms, and imperative node updates outside React.
- [ ] **P3-D2:** Extend the product-named gesture and input components preserved by `P1-D7` into the one production pointer-routing path with one-preview and one-commit gestures, pointer capture, cancellation, touch selection, native scrolling, bounded vertical selection-move edge autoscroll, right-button routing, long press, and keyboard selection. Do not introduce a second recognizer, event-ownership path, or gesture state machine for behavior already retained from Phase 1.
- [ ] **P3-D3:** Implement Pen, freehand and straight Highlighter, whole-element Eraser, Cursor, Lasso, pressure snapshots, constant-width projection, pressure-outline workers, and safe sliced fallback.
- [ ] **P3-D4:** Integrate every accepted gesture with operation, host-history, recovery, session publication, retained rendering, and coalesced sidecar save.
- [ ] **P3-D5:** Add only the minimal temporary development commands needed to activate completed tools through the same application command ports that production UI will use. They own no parallel tool state or execution path and MUST be replaced and removed by `P5-D4`. Production toolbar and stylebar remain Phase 5.

### Exit evidence

- [ ] **P3-E1:** Basic tool, selection, context-menu, selection-move edge-autoscroll, touch-priority, cancellation, long-stroke, Undo or Redo, save, reopen, and disposal scenarios pass through deterministic host fakes plus browser and input simulation. Packaged-host or device automation is required only for an implemented contract that these layers cannot observe and when a stable control surface exists.
- [ ] **P3-E2:** Pointer sampling, preview, edge autoscroll, scroll, pure zoom transform, culling, SVG updates, and worker progress produce zero React note-root commits and no per-element React components and satisfy their explicit presented-frame and view-frame rows.
- [ ] **P3-E3:** Compact deterministic 5,000-element generators pass applicable hit, select, lasso, selection-move edge-autoscroll, annotation-bottom reachability, scroll, memory, worker, recovery, and full-mutation-readiness assertions. Relevant 10,000-element stress-row assertions pass without retrospective threshold changes; no checked-in dataset or generated evidence manifest is required.
- [ ] **P3-E4:** A single-element move with edge autoscroll, including an annotation-bottom update, performs no complete-scene scan or rebuild and retains at most one scheduled frame and latest pointer sample.
- [ ] **P3-E5:** After every automated Phase 3 gate passes, complete only the Phase 3 draw, Undo or Redo, and reopen scenario in [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) and report pass or fail.

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
- `P4-D3`: [Anchors Sections 4, 6, 8, and 10](05-anchors-and-layout.md#4-markdown-edits-and-reflow), [SVG Sections 2, 5, and 8](06-svg-rendering.md#2-scene-layers), and [Testing Sections 2.6, 2.7, 2.13, and 4](10-testing-and-acceptance.md#26-anchor-reflow).
- `P4-D4`: [Anchors Sections 2.2 and 5](05-anchors-and-layout.md#22-object-attachments), [Operations Section 2](16-operations-sessions-and-recovery.md#2-closed-annotation-operation-union), and [Testing Sections 2.6, 2.7, 2.11, and 3](10-testing-and-acceptance.md#26-anchor-reflow).
- `P4-D5`: [Architecture Sections 5 and 8](04-architecture.md#5-note-sessions-and-multiple-views), [Anchors Sections 4 and 6](05-anchors-and-layout.md#4-markdown-edits-and-reflow), and [Testing Section 2.7](10-testing-and-acceptance.md#27-automatic-binding-and-variable-width).
- `P4-E1`: [Testing Sections 2.6, 2.7, 3, and 4](10-testing-and-acceptance.md#26-anchor-reflow) and [Anchors Sections 2.1 and 4](05-anchors-and-layout.md#21-anchor-canonicalization-v1).
- `P4-E2`: [Testing Sections 2.7 and 2.13](10-testing-and-acceptance.md#27-automatic-binding-and-variable-width), [Architecture Sections 5 and 8](04-architecture.md#5-note-sessions-and-multiple-views), and [Anchors Sections 4, 6, and 10](05-anchors-and-layout.md#4-markdown-edits-and-reflow).
- `P4-E3`: [Testing Sections 2.6, 2.7, and 3](10-testing-and-acceptance.md#26-anchor-reflow), [Anchors Sections 3 to 5 and 9](05-anchors-and-layout.md#3-initial-binding-inference), and [Operations Section 2](16-operations-sessions-and-recovery.md#2-closed-annotation-operation-union).
- `P4-E4`: [Testing Sections 2.6, 2.11, 3, and 4](10-testing-and-acceptance.md#26-anchor-reflow), [Anchors Sections 2.2 and 6](05-anchors-and-layout.md#22-object-attachments), and [Domain Section 4](15-domain-model-and-codecs.md#4-object-ports-and-attached-linear-endpoints).
- `P4-E5`: [Quality Section 5](09-quality-and-performance.md#5-performance-gates) and [Testing Sections 2.13 and 6](10-testing-and-acceptance.md#213-annotation-aware-bottom-scroll-extent).
- `P4-E6`: [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios), [Testing Sections 2.6 and 2.7](10-testing-and-acceptance.md#26-anchor-reflow), and [Quality Section 2.2](09-quality-and-performance.md#22-phase-exit-validation).

### Deliverables

- [ ] **P4-D1:** Implement exact block classification, fingerprinting, code-point-safe contexts, boundary associations, offset-map application, and bounded external reattachment.
- [ ] **P4-D2:** Implement `BindingInferenceProfileV1`, bounded candidate lookup, deterministic highlight, underline, enclosure, text-position, and fixed classification, confidence, and tie-breaking.
- [ ] **P4-D3:** Implement viewport-only fragment, transform, and enclosure projection per view, fragment and byte admission, signed margins, variable-width reflow, projection-derived bottom-scroll updates, stale-token rejection, and degraded, orphaned, or projection-overflow states.
- [ ] **P4-D4:** Implement manual binding correction, move-and-reanchor batches, Group binding updates, and attached-endpoint reverse-index invalidation.
- [ ] **P4-D5:** Preserve canonical geometry during reflow and share only viewport-independent results across panes.

### Exit evidence

- [ ] **P4-E1:** Unicode, context, fingerprint, boundary-association, offset composition, threshold edge, enclosure-margin, stale-token, and reattachment goldens pass.
- [ ] **P4-E2:** Two widths of one note yield separate correct projections and annotation-aware bottom extents from one canonical scene with no sidecar mutation caused by width alone.
- [ ] **P4-E3:** Manual move and correction create one exact reversible operation. Pure zoom creates no inference, history, recovery, or save work.
- [ ] **P4-E4:** Attached Line and Arrow endpoint projection and target reflow remain proportional to reverse-index fanout and pass the 1,024/1,025 boundary.
- [ ] **P4-E5:** Binding, range, enclosure, reflow, annotation-bottom aggregate, and external-reattachment performance assertions pass in every applicable automated suite.
- [ ] **P4-E6:** After every automated Phase 4 gate passes, complete only the Phase 4 text-edit and projection scenario in [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) and report pass or fail.

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

- `P5-D1`: [Toolbar Sections 1 to 4](03-toolbar-and-stylebar.md#1-surface-model), [Settings Section 4](08-settings.md#4-tool-defaults), and [Testing Sections 2.9 and 5](10-testing-and-acceptance.md#29-toolbar-and-stylebar).
- `P5-D2`: [Toolbar Sections 1 to 3 and 5 to 7](03-toolbar-and-stylebar.md#1-surface-model), [Settings Sections 2 and 2.2](08-settings.md#2-general), and [Testing Sections 2.9 and 5](10-testing-and-acceptance.md#29-toolbar-and-stylebar).
- `P5-D3`: [Toolbar Sections 2 to 4](03-toolbar-and-stylebar.md#2-toolbar-contents), [Interaction Sections 2, 3, and 7](02-interaction-and-tools.md#2-tool-set), [Settings Sections 3 to 5](08-settings.md#3-input-and-stylus), and [Testing Sections 2.9 and 5](10-testing-and-acceptance.md#29-toolbar-and-stylebar).
- `P5-D4`: [Host Contract Section 7](14-obsidian-host-contract.md#7-host-native-user-interface), [Settings Section 8](08-settings.md#8-commands-and-hotkeys), and [Testing Sections 2.9, 5, and 8.6](10-testing-and-acceptance.md#29-toolbar-and-stylebar).
- `P5-D5`: [Settings Sections 1 to 9](08-settings.md#1-settings-principles), [Host Contract Section 8](14-obsidian-host-contract.md#8-settings-contract), and [Testing Section 8.7](10-testing-and-acceptance.md#87-settings-and-vault).
- `P5-E1`: [Testing Sections 2.9, 5, 8.6, and 8.7](10-testing-and-acceptance.md#29-toolbar-and-stylebar).
- `P5-E2`: [Quality Section 5](09-quality-and-performance.md#5-performance-gates) and [Testing Section 6](10-testing-and-acceptance.md#6-performance-acceptance).
- `P5-E3`: [Testing Section 8.7](10-testing-and-acceptance.md#87-settings-and-vault).
- `P5-E4`: [Toolbar Section 8](03-toolbar-and-stylebar.md#8-mockup-contract) and [Toolbar Mockup Non-Goals](12-toolbar-mockup.md#non-goals).
- `P5-E5`: [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios), [Testing Sections 2.9 and 5](10-testing-and-acceptance.md#29-toolbar-and-stylebar), and [Quality Section 2.2](09-quality-and-performance.md#22-phase-exit-validation).

### Deliverables

- [ ] **P5-D1:** Implement a small reusable control library for color, width, independent outline and fill opacity, pressure, caps, dash, fill, sliders, segmented choices, menus, and mixed selection state.
- [ ] **P5-D2:** Implement the retained per-view toolbar host, independent always-visible Show or Hide toggle, Floating and Docked toolbar, contextual stylebar, responsive overflow, fixed group membership, configurable order, focus restoration, and 44-CSS-pixel compact targets.
- [ ] **P5-D3:** Implement production controls for completed tools and binding correction. Construction controls are wired to stable ports and become enabled only with Phase 6 implementations; no milestone build may present an action as functional before its command exists.
- [ ] **P5-D4:** Replace and remove every temporary development command from `P3-D5`, then implement each specified Obsidian command exactly once through the existing application command ports, with host Hotkeys ownership, native Menu and Modal surfaces, safe DOM, Obsidian icons, logical CSS, RTL, visible status, and accessible live regions. No development command, duplicate registration, or parallel tool-activation path remains.
- [ ] **P5-D5:** Extend the storage-policy schema and application port delivered by `P2-D5` into the one complete validated plugin-global and device-local settings snapshot. Implement the imperative 1.8.7 settings tab, defaults, toolbar order, write failure with Retry, guarded external-change reload, diagnostics, and reset without creating a second settings store, storage-policy schema, or persistence path.

### Exit evidence

- [ ] **P5-E1:** Toolbar, stylebar, settings, command, focus, keyboard, screen-reader, touch, narrow-width, reduced-motion, default light, default dark, and forced-colors or high-contrast tests pass. Source search and direct package inspection find no temporary development command or duplicate tool-activation registration.
- [ ] **P5-E2:** Tool or style changes rerender only subscribed coarse UI subtrees. Pointer, scene, scroll, culling, and worker changes cause zero unrelated React commits.
- [ ] **P5-E3:** Settings corruption, migration, failed persistence, guarded external notification, settings-tab reopen reload, root rename, and cross-device locator behavior pass through the single settings snapshot and the reused `P2-D5` storage-policy port, with no parallel schema or store.
- [ ] **P5-E4:** The mockup remains non-normative and no product behavior is inferred only from it.
- [ ] **P5-E5:** After every automated Phase 5 gate passes, complete only the Phase 5 toolbar, style or setting, and focus scenario in [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) and report pass or fail.

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
- `P6-D2`: [Product Scope Section 2.2](01-product-scope.md#22-construction-objects), [Interaction Section 2.3](02-interaction-and-tools.md#23-tool-specific-behavior), [Toolbar Section 4.6](03-toolbar-and-stylebar.md#46-axes-and-tables), [Domain Sections 3 and 5](15-domain-model-and-codecs.md#3-geometry-records), and [Testing Section 2.11](10-testing-and-acceptance.md#211-lines-tables-and-axes).
- `P6-D3`: [Product Scope Section 2.2](01-product-scope.md#22-construction-objects), [Interaction Section 2.3](02-interaction-and-tools.md#23-tool-specific-behavior), [Toolbar Section 4.6](03-toolbar-and-stylebar.md#46-axes-and-tables), [Domain Sections 3 and 5](15-domain-model-and-codecs.md#3-geometry-records), and [Testing Section 2.11](10-testing-and-acceptance.md#211-lines-tables-and-axes).
- `P6-D4`: [Interaction Sections 3 to 5](02-interaction-and-tools.md#3-selection-and-manipulation), [Domain Sections 4, 6, and 7](15-domain-model-and-codecs.md#4-object-ports-and-attached-linear-endpoints), [Operations Section 2](16-operations-sessions-and-recovery.md#2-closed-annotation-operation-union), and [Testing Sections 2.11, 2.12, 3, 4, and 5](10-testing-and-acceptance.md#211-lines-tables-and-axes).
- `P6-D5`: [Toolbar Sections 2 to 4](03-toolbar-and-stylebar.md#2-toolbar-contents), [SVG Section 9](06-svg-rendering.md#9-worker-and-ui-framework-boundaries), and [Testing Sections 2.9 and 6](10-testing-and-acceptance.md#29-toolbar-and-stylebar).
- `P6-E1`: [Testing Sections 2.11, 2.12, 3, 4, and 5](10-testing-and-acceptance.md#211-lines-tables-and-axes) and [Interaction Sections 2 and 3](02-interaction-and-tools.md#2-tool-set).
- `P6-E2`: [Testing Sections 2.11, 2.12, 3, and 4](10-testing-and-acceptance.md#211-lines-tables-and-axes), [Anchors Section 2.2](05-anchors-and-layout.md#22-object-attachments), and [Domain Section 4](15-domain-model-and-codecs.md#4-object-ports-and-attached-linear-endpoints).
- `P6-E3`: [Testing Sections 2.11, 2.12, 3, and 4](10-testing-and-acceptance.md#211-lines-tables-and-axes), [Domain Sections 3, 5, and 6](15-domain-model-and-codecs.md#3-geometry-records), and [Operations Section 2](16-operations-sessions-and-recovery.md#2-closed-annotation-operation-union).
- `P6-E4`: [Quality Section 5](09-quality-and-performance.md#5-performance-gates) and [Testing Section 6](10-testing-and-acceptance.md#6-performance-acceptance).
- `P6-E5`: [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios), [Testing Sections 2.11 and 2.12](10-testing-and-acceptance.md#211-lines-tables-and-axes), and [Quality Section 2.2](09-quality-and-performance.md#22-phase-exit-validation).

### Deliverables

- [ ] **P6-D1:** Implement Rectangle, Ellipse, Triangle, Diamond, Octagon, Line, Arrow, endpoint caps, optional stable-port attachment for either linear endpoint, and Line or Arrow quadratic curve control.
- [ ] **P6-D2:** Implement the one Coordinate system tool with 2D or 3D creation choice, semantic vectors, individual axis-length controls, shared move, and rigid rotation.
- [ ] **P6-D3:** Implement one semantic Table with Rows and Columns creation and selected-object controls, whole-frame move, resize, rotation, and constrained divider editing.
- [ ] **P6-D4:** Extend the single pure selection-model and object-port service delivered by `P1-D6` for construction elements and route required automatic binding through the existing Phase 4 binding-inference service. Add Group operations, z-order, duplicate, cut, copy, worker-batched bulk paste, target menus, and dependency-closed delete without introducing a second selection model, port resolver, or binding-inference path.
- [ ] **P6-D5:** Integrate construction tools into the Phase 5 toolbar and stylebar without adding per-element React components.

### Exit evidence

- [ ] **P6-E1:** Every tool passes creation, selection, style, transform, constant-width, binding, save, reload, exact Undo or Redo, cancellation, clipboard, and malicious-input tests.
- [ ] **P6-E2:** Line and Arrow may remain straight or curve while either endpoint is free or attached. Every valid port, attachment, maximum-fanout target move, reflow, delete-detach, and Undo path passes without a scene scan.
- [ ] **P6-E3:** Table rows, columns, dividers, minimum tracks, rotation, axes vectors, grid guides, limits, Groups, and order pass exact semantic and composed-path tests through the single selection, port-resolution, and binding-inference services.
- [ ] **P6-E4:** Single and aggregate transforms keep style bytes and line widths unchanged, remain atomic, and pass 5,000- and 10,000-element applicable budgets.
- [ ] **P6-E5:** After every automated Phase 6 gate passes, complete only the Phase 6 shape, attachment, move, and Undo scenario in [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) and report pass or fail.

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
- `P7-D2`: [Interaction Section 1](02-interaction-and-tools.md#1-input-routing-invariants), [Interaction Section 6](02-interaction-and-tools.md#6-whole-note-zoom), [Anchors Section 9](05-anchors-and-layout.md#9-zoom-and-layout), [Host Contract Sections 4 and 5](14-obsidian-host-contract.md#4-native-workspace-and-view-boundaries), [Settings Section 5](08-settings.md#5-note-appearance-and-zoom), [Testing Section 2.4](10-testing-and-acceptance.md#24-touch-routing), and [Testing Section 2.10](10-testing-and-acceptance.md#210-zoom).
- `P7-D3`: [Architecture Section 7](04-architecture.md#7-reading-view-integration), [Anchors Sections 8 and 10](05-anchors-and-layout.md#8-reading-view-resolution), [Host Contract Section 6](14-obsidian-host-contract.md#6-reading-view-contract), and [Testing Sections 2.13, 8.3, and 8.5](10-testing-and-acceptance.md#213-annotation-aware-bottom-scroll-extent).
- `P7-D4`: [Architecture Sections 4 and 8](04-architecture.md#4-plugin-lifecycle), [Anchors Section 10](05-anchors-and-layout.md#10-annotation-aware-bottom-scroll-extent), [Host Contract Sections 3 to 6](14-obsidian-host-contract.md#3-startup-ownership-and-disposal), and [Testing Sections 2.8, 2.13, and 8.2 to 8.5](10-testing-and-acceptance.md#28-background-alignment).
- `P7-E1`: [Testing Sections 2.7, 2.8, and 2.10](10-testing-and-acceptance.md#27-automatic-binding-and-variable-width), [Anchors Sections 7 and 9](05-anchors-and-layout.md#7-background-alignment), and [Settings Section 5](08-settings.md#5-note-appearance-and-zoom).
- `P7-E2`: [Testing Sections 2.8, 2.13, and 8.5](10-testing-and-acceptance.md#28-background-alignment), [Architecture Section 7](04-architecture.md#7-reading-view-integration), [Anchors Section 10](05-anchors-and-layout.md#10-annotation-aware-bottom-scroll-extent), and [Host Contract Section 6](14-obsidian-host-contract.md#6-reading-view-contract).
- `P7-E3`: [Testing Section 2.4](10-testing-and-acceptance.md#24-touch-routing), [Testing Section 2.10](10-testing-and-acceptance.md#210-zoom), [Anchors Section 9](05-anchors-and-layout.md#9-zoom-and-layout), [Interaction Section 1](02-interaction-and-tools.md#1-input-routing-invariants), [Interaction Section 6](02-interaction-and-tools.md#6-whole-note-zoom), [Host Contract Sections 4 and 5](14-obsidian-host-contract.md#4-native-workspace-and-view-boundaries), and [Quality Section 5](09-quality-and-performance.md#5-performance-gates).
- `P7-E4`: [Interaction Section 1](02-interaction-and-tools.md#1-input-routing-invariants), [Interaction Section 6](02-interaction-and-tools.md#6-whole-note-zoom), [Host Contract Sections 4 and 5](14-obsidian-host-contract.md#4-native-workspace-and-view-boundaries), [Quality Section 5](09-quality-and-performance.md#5-performance-gates), [Testing Section 2.4](10-testing-and-acceptance.md#24-touch-routing), [Testing Section 2.10](10-testing-and-acceptance.md#210-zoom), and [Testing Sections 2.13 and 6](10-testing-and-acceptance.md#213-annotation-aware-bottom-scroll-extent).
- `P7-E5`: [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios), [Testing Sections 2.8 and 2.10](10-testing-and-acceptance.md#28-background-alignment), and [Quality Section 2.2](09-quality-and-performance.md#22-phase-exit-validation).

### Deliverables

- [ ] **P7-D1:** Implement none, ruled, squared, and dotted backgrounds with block-scoped measured rhythm, whole-view fallback ownership, section-owned overrides, bounded region merging, and truthful unavailable-metric degradation.
- [ ] **P7-D2:** Extend the retained two-pointer recognizer and the existing Phase 3 view-transform and input path with 50 to 400 percent whole-note zoom through controls and pinch, shared note and overlay transforms, native horizontal and vertical one-finger pan over available ranges, pointer inversion, focus preservation, viewport preservation, and bounded device-local remembered zoom. Do not create a second recognizer, scroll owner, or transform pipeline.
- [ ] **P7-D3:** Complete Reading View section reporting, source evidence, one whole-note overlay and annotation scroll-extent carrier, read-only projections, background ownership, section reprocessing, and disposal.
- [ ] **P7-D4:** Integrate theme, font, writing width, mode, resize, scroll, annotation-bottom, viewport-height, and pop-out invalidation with revision-bound layout publication.

### Exit evidence

- [ ] **P7-E1:** The complete background formula, ownership, region-limit, mode, width, theme, font, zoom, hit-test, empty-note, and unavailable-metric matrix passes.
- [ ] **P7-E2:** Reading View never mutates scene, Markdown, history, recovery, or sidecars and never duplicates overlays, children, observers, background regions, or annotation scroll-extent carriers.
- [ ] **P7-E3:** Pure zoom reuses layout metrics and the existing recognizer and view-transform path when logical width is unchanged, native one-finger pan covers each available horizontal and vertical range through the host scroll surface, and neither path creates canonical mutation, reclassification, history, recovery, or save work. Source and runtime inspection find exactly one gesture-recognition and transform pipeline for these behaviors.
- [ ] **P7-E4:** Native one-finger pan, scroll, annotation-bottom updates, zoom, culling, background, presentation, dropped-frame, paint, memory, pop-out, and teardown budgets pass at the lowest faithful automated layer. A physical claim remains unverified when no stable physical automation exists; that limitation does not block structural and simulation checks or require a generic device-runner framework.
- [ ] **P7-E5:** After every automated Phase 7 gate passes, complete only the Phase 7 background, zoom, and Reading View scenario in [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) and report pass or fail.

## Phase 8: Release Hardening

### Required specifications

All documents in the [Specification Index](00-readme.md) and every accepted ADR apply.

### Exact implementation references

- `P8-D1`: [Quality Sections 2.3, 4, and 5](09-quality-and-performance.md#23-release-validation) and [Testing Sections 6 and 7](10-testing-and-acceptance.md#6-performance-acceptance).
- `P8-D2`: [Quality Sections 2.3, 4, and 5](09-quality-and-performance.md#23-release-validation), [Testing Sections 6 to 8](10-testing-and-acceptance.md#6-performance-acceptance), and [GitHub and CI Section 5](17-github-and-ci.md#5-automated-performance-results).
- `P8-D3`: [Quality Sections 7 to 10](09-quality-and-performance.md#7-security-and-privacy) and [Testing Sections 5, 7, and 8](10-testing-and-acceptance.md#5-accessibility-tests).
- `P8-D4`: [Quality Sections 4 to 6](09-quality-and-performance.md#4-performance-workload) and [Testing Section 6](10-testing-and-acceptance.md#6-performance-acceptance).
- `P8-D5`: [Host Contract Sections 2 and 11](14-obsidian-host-contract.md#2-package-and-manifest), [GitHub and CI Sections 3 to 5](17-github-and-ci.md#3-workflows), and [Testing Sections 8.1 and 8.8](10-testing-and-acceptance.md#81-package-and-compatibility).
- `P8-D6`: [Quality Sections 1 to 3, 6, and 10](09-quality-and-performance.md#1-code-quality-requirements), [Host Contract Sections 2, 3, 7, and 11](14-obsidian-host-contract.md#2-package-and-manifest), and [Testing Sections 7, 8.1, 8.2, and 8.6](10-testing-and-acceptance.md#7-coverage-and-test-completeness).
- `P8-E1`: [Testing Section 7](10-testing-and-acceptance.md#7-coverage-and-test-completeness) and [Quality Section 10](09-quality-and-performance.md#10-release-definition-of-done).
- `P8-E2`: [Quality Sections 5 to 10](09-quality-and-performance.md#5-performance-gates), [Testing Sections 3 to 8](10-testing-and-acceptance.md#3-persistence-and-fault-tests), and [Host Contract Section 12](14-obsidian-host-contract.md#12-verification-ownership).
- `P8-E3`: [Quality Sections 7 to 10](09-quality-and-performance.md#7-security-and-privacy), [Testing Section 7](10-testing-and-acceptance.md#7-coverage-and-test-completeness), and [Host Contract Section 12](14-obsidian-host-contract.md#12-verification-ownership).
- `P8-E4`: [Host Contract Section 11](14-obsidian-host-contract.md#11-public-release-and-community-directory), [GitHub and CI Sections 3 and 4](17-github-and-ci.md#3-workflows), and [Testing Section 8.8](10-testing-and-acceptance.md#88-android-and-release).
- `P8-E5`: [Quality Sections 2.3, 3, 6, and 10](09-quality-and-performance.md#23-release-validation), [Host Contract Sections 2, 3, 7, and 11](14-obsidian-host-contract.md#2-package-and-manifest), and [Testing Sections 7, 8.1, 8.2, and 8.6](10-testing-and-acceptance.md#7-coverage-and-test-completeness).
- `P8-E6`: [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios), [Testing Sections 8.1 and 8.8](10-testing-and-acceptance.md#81-package-and-compatibility), and [Quality Section 2.2](09-quality-and-performance.md#22-phase-exit-validation).

### Deliverables

- [ ] **P8-D1:** Review the test-local thresholds, compact deterministic fixture generators, supported automated targets, screen-reader automation boundary, and the single Phase 8 sanity scenario before running the release candidate. Do not create or freeze a separate profile, digest manifest, or requirement inventory.
- [ ] **P8-D2:** Run `npm run ci` and every applicable existing integration, performance, accessibility, simulator, emulator, packaged-host, or device suite against one production artifact. Use host or device suites only where a stable control surface exists and simpler automation cannot establish the implemented contract. Normal command output, the production package, and release checksums are sufficient; no generated release-evidence schema or runner hierarchy is required.
- [ ] **P8-D3:** Automatically verify every machine-observable WCAG 2.2 AA rule, keyboard and focus flow, security abuse case, dependency and license condition, and 50-cycle lifecycle leak check. Perform separate specialist judgment only for non-programmatically observable accessibility, privacy, legal-applicability, and perceptual questions; it is not a user-run software test matrix.
- [ ] **P8-D4:** Pass every 5,000-element minimum-capacity and 10,000-element stress workflow, including open, mutation readiness, draw, select, lasso, resize, Table, axes, reflow, save, conflict, recovery, Undo or Redo, unload, paint, dropped frames, and memory.
- [ ] **P8-D5:** Finalize public `README.md`, compatible `LICENSE`, real publisher metadata, accurate local-data and sidecar disclosures, current Community policy compliance, manifest, package, `versions.json` when required, tag, draft release, and the three loadable artifacts. Review the actual files and official rules directly; do not create a separate policy-evidence document.
- [ ] **P8-D6:** Complete a final productization pass over the complete repository and production dependency graph. Remove every phase-named file and directory, obsolete probe, synthetic payload, temporary command or UI, milestone or phase flag, debug registration, temporary migration scaffold, dead adapter, and temporary re-export. Preserve only compatibility adapters and data migrations explicitly required by the supported host and schema contracts, under stable product or domain names. A diagnostics capability remains only when it is an explicitly specified product feature; all other developer harnesses are compile-time excluded from the release artifact.

### Exit evidence

- [ ] **P8-E1:** Every automatable implemented capability has passing executable tests. Non-programmatically observable uncertainty is explicitly reported and is limited to the one phase-sanity scenario or a separate specialist release review; it cannot create additional routine user procedures.
- [ ] **P8-E2:** No unresolved critical or high security finding, data-loss case, stale conflict, Android input regression, accessibility blocker, persistent resource leak, uncalibrated critical path, or failed quality gate remains.
- [ ] **P8-E3:** The concise release report names changes, executed commands and results, checks not executed with reasons, residual risks, and material compatibility or legal uncertainty. It summarizes real outputs and does not introduce a new report schema or checked-in evidence structure.
- [ ] **P8-E4:** A draft release is reviewed before publication. Commit, push, tag, and publication remain explicit user-authorized actions. This authorization is governance, not test evidence or the Phase 8 sanity scenario.
- [ ] **P8-E5:** Existing source search, architecture, dead-code, tests, and direct inspection of the exact production package find no phase-named path and no phase, probe, milestone, synthetic, temporary-debug, or obsolete migration-scaffold residue reachable or visible in production. Commands, menus, Notices, styles, storage, and diagnostics expose only specified product behavior, and unload leaves zero owned listeners, observers, timers, workers, ports, queue turns, pointer captures, framework roots, and view adapters. No bespoke repository scanner, installed-package scanner, or global resource ledger is required.
- [ ] **P8-E6:** After every automated Phase 8 gate passes, complete only the Phase 8 release-candidate create, save, and reopen scenario in [Testing Section 9](10-testing-and-acceptance.md#9-phase-sanity-scenarios) and report pass or fail.
