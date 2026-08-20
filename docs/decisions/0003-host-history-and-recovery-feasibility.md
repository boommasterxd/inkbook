# ADR 0003: Host History and Recovery Feasibility

Status: Accepted

## Context

Phase 0 must prove that annotation effects can participate in Obsidian's existing CodeMirror history without a second history extension or keymap, and that every dispatched host effect has a durable recovery transition. The same production bundle must preserve these guarantees on desktop and Android while using only public browser storage and worker APIs plus a guarded editor boundary.

## Decision

Inkbook uses one CodeMirror `StateEffect` and one bounded `ViewPlugin` value per concrete editor. The effect is isolated with CodeMirror's public `isolateHistory` annotation and inverted through the public `invertedEffects` facet. A guarded `editor.cm` shape check obtains the concrete `EditorView`; an absent or incompatible shape disables annotation history instead of guessing at host internals. Inkbook does not install another `history()` extension or keymap.

The bridge stores a bounded, revision-free `HostEffectEnvelopeV1` in host history. One owner-pane lease and monotonic per-editor, per-epoch sequence high-water marks reject stale, duplicate, out-of-order, or non-owner deliveries. Forward, Undo, and Redo each derive a fresh revision-bound application intent. Recovery preparation commits before Forward dispatch, and the matching `host-recorded-forward`, `host-recorded-undo`, or `host-recorded-redo` transition commits before annotation scene publication.

The Phase 0 recovery adapter uses the public IndexedDB transaction boundary. It atomically creates the schema, prepares a Forward record, compares the expected state during host-recorded transitions, accounts for exact UTF-8 bytes, enforces the 8 MiB per-note and 32 MiB global limits, rejects corrupt or conflicting records, and handles abort, quota, restart, cleanup, race, backend-unavailable, and disposal cases. Worker computation uses a static payload embedded in `main.js`, bounded queues and bytes, transferable buffers, cooperative cancellation, crash handling, URL revocation, safe fallback, and idempotent disposal.

These boundaries are feasible for an active, continuously loaded plugin instance on desktop and Android. Reading View remains presentation-only. No iOS contract is accepted or tested.

## Unsupported Cases and Fail-Closed Behavior

- A plugin unload or module re-enable cannot give an old reachable CodeMirror `StateEffect` type a stable public identity. If persisted recovery records show that effects may remain reachable, a new controller does not accept annotation mutations. The user must restart Obsidian or clear the relevant host history before later product work may offer an explicit discard workflow.
- An unavailable or incompatible guarded `editor.cm` boundary disables annotation history while native Markdown editing remains available.
- An unavailable or failed IndexedDB boundary blocks annotation host dispatch. Corrupt, conflicting, quota-exceeded, aborted, or disposed recovery transactions do not publish annotation state.
- An unavailable or crashed worker uses the bounded synchronous fallback and releases worker resources. A worker-capable environment is still required for a supported release cell.
- Phase 0 proves the transactional probe contract only. Source checkpoints, sidecar sagas, direction attempts, acknowledgement rebasing, and the complete production `RecoveryStore` remain assigned to Phase 1 or later roadmap items.

## Evidence

The accepted implementation passes deterministic tests for real CodeMirror A-B-C history ordering, branch and sequence rejection, recovery faults and races, worker cancellation and failure, view lifecycle and disposal, input routing, resource limits, and bounded recovery performance. The Phase 0 verification entry point also runs formatting, ESLint, strict TypeScript, coverage, duplication, dead-code, architecture, dependency audit, and the production build. Line coverage remains above the required 85 percent threshold.

Automated CI and scripted host or device probes cover every repeatable verification owned by this decision. `P0-E6` retains only one concise user-facing Phase 0 sanity scenario for newly visible host behavior. It does not replace the automated gate, and this ADR does not substitute for either result.

## Consequences

Phase 1 may rely on the guarded active-instance history bridge and transactional ordering, but it must preserve all fail-closed conditions above. A future host or CodeMirror upgrade must re-run the compatibility matrix and invalidate this decision if the guarded boundary, effect inversion, isolation, worker launch, or IndexedDB behavior changes.

## References

- [Architecture](../specification/04-architecture.md)
- [Sidecar Persistence](../specification/07-sidecar-persistence.md)
- [Testing and Acceptance](../specification/10-testing-and-acceptance.md)
- [Implementation Roadmap](../specification/11-implementation-roadmap.md)
- [Obsidian Host Contract](../specification/14-obsidian-host-contract.md)
- [Operations, Sessions, and Recovery](../specification/16-operations-sessions-and-recovery.md)
