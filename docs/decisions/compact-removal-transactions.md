# Compact removal transactions

## Status

Accepted.

## Context

The general mutation planner rebuilds document-wide records, order, capacity, spatial-index, and connection state. That is suitable for large staged replacements, but removing a few elements should reuse unrelated state. Dense ordering ranks previously prevented that; the [order-statistics trees](order-statistics-trees.md) remove this prerequisite.

## Decision

Removal and its history traversal use compact mutations: removed IDs, changed elements, and insertion placements for restored elements. The preparer captures original ranks only for removed elements, derives connection detachments, and validates capacity, index insertion, placement, history retention, and document version before publication. The commit consumes a single-use token and rechecks cancellation. Unchanged records, order nodes, and index regions are reused.

The synchronous commit has a bounded eligibility envelope, specified in [Rendering and Performance](../rendering-and-performance.md#compact-removal-transactions). Oversized or unsupported compact mutations expand into the existing cancellable full-state preparation, with band traversal split across scheduler checkpoints. This deliberate fallback avoids replacing one document-wide preparation cost with an unbounded in-place commit.

Pure removal does not change survivor-relative ordering and needs no complete order payload for the document worker. Autosave obtains a band list only when its coalesced export actually requests that band. Restoring removed elements supplies their affected band order when required for worker synchronization; exporting the complete SVG remains document-sized work.

## Consequences

Small removal, Undo, and Redo avoid full-document order snapshots and derived-state rebuilds. Large batches and spatial-overflow edits can still take document-sized preparation work. The fallback publishes its complete delta synchronously, so large edits and their listeners are not covered by the compact commit work bound. This change does not claim constant-time removal, zero allocation, or physical-device latency guarantees. Work/resource tests cover preparation and publication separately, including cancellation, stale tokens, connected targets, and resource-bound fallbacks.
