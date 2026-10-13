# Selection Work Reuse

Status: Accepted

## Context

A preview capacity limit also limited live movement of large selections. Repeated
selection geometry, graph traversal, replacement planning, and document-wide
clipboard lookup added work before or during otherwise local interactions.

## Decision

Separate complete feedback on mounted selected paths from bounded canonical
replacement preparation. Reuse scene membership and explicit conservative preview
bounds rather than starting another spatial search for every preview context.
Retain canonical render-band order and per-element path identity; arbitrary
selection groups must not reparent interleaved elements.

Unchanged retained band/rank values reuse the published order without another
rank traversal. Reuse feedback membership across requests with the same ID list;
remounted feedback uses set membership rather than a selection-wide array search.
Account preview elements, bases, and transform bytes incrementally. Cancel unfinished
superseded pressure snapshots at admitted scene updates; retain complete snapshots
as residual bases and reuse measurements only through the bounded owning cache.

Reuse selected-record and single-stroke frame snapshots across chrome, hit testing,
and gesture startup. Own demanded local center and pressure preparation in the
Store, with sample identity and local shape determining compatibility across
placement changes. Prepare connection-cycle exclusion once per gesture source.

Bind replacement and ordering reuse to private immutable producers and the owning
Store revision. Preview preparation must not eagerly build commit-only index,
capacity, record, or history state. Clipboard lookup uses selected IDs and retained
ranks. Paste may reuse derivations only after its own complete validation and
immutable staging; snapshot wrapper metadata before asynchronous preparation.
Combine Paste wire capture and insertion preparation. Only the private sample-copy
producer may witness its own complete frozen numeric arrays; reuse their JSON
structure proof while retaining semantic validation and exact resource limits.
Required public history buffers remain independent copies; private captured-sample
provenance also avoids repeating structural inspection during that copy.

Canonical resource limits, invalidation, scheduling, and trust boundaries belong
in [Rendering and Performance](../rendering-and-performance.md). User-visible
selection behavior belongs in [Editor Tools](../editor-tools.md).

## Consequences

Visible selected elements receive coherent feedback even when their expensive
replacement snapshots are outside the preparation cohort. Constant-width paths
reuse their canonical geometry; pressure snapshots retain the existing residual
feedback and width trade-off described in
[Continuous Selection Resize Feedback](selection-resize-feedback.md).

Work scales with actual mounted feedback, selected records, reached connections,
and changed ranks. Complete immutable band/history snapshots and native browser
SVG operations can remain linear or indivisible. This decision does not promise
constant-time transforms or physical-device latency.

Deterministic tests must observe actual sample reads, graph/index visits,
validation, geometry preparation, DOM writes, cancellation, reuse, and cleanup.
Real Obsidian traces remain necessary to assess browser work and interaction
latency; timing captures are diagnostic artifacts outside normative documentation
and do not replace the automated work/resource contracts.
