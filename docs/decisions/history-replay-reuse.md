# History Replay Reuse

Status: Accepted.

## Context

Undo of a deletion previously rebuilt Store records, copied stroke samples, recalculated bounds, and discarded previously prepared scene contours. These costs remain material for the 10,000-stroke document even when preparation yields under the central scheduler.

## Decision

Each Store privately associates an applied mutation with its original and replacement records. Only changed records are retained. Public transition data remains a separate input boundary: replay validates it again and compares it exactly with a private record before reusing that record's immutable element and bounds. Mutated samples, foreign transitions, changed shape fields, payload overflow, and stale preparation retain their normal rejection or reconstruction behavior. No public flag grants trusted replay.

Eligible restoration creates current commit-time version wrappers around existing owned samples and bounds. Capacity, connections, spatial-index preparation, cancellation, and atomic publication retain their existing paths. Both synchronous removal registration and prepared mutation commits use the same private ownership mechanism. Additional private record and direction-map ownership counts conservatively toward the existing history payload limit; it does not create an unbounded cache. Weak transition ownership permits history eviction and disposal to release the retained records.

The scene removes deleted ID/version aliases immediately. Immutable canonical stroke contours may remain retired within the existing path LRU, including retained sample and bookkeeping bytes. Reuse requires the same eligible immutable sample identity and canonical shape fields; offset placement remains separate from local contour identity. A new committed geometry version never authorizes a stale active alias. Mutable external arrays and incompatible geometry remain cache misses. No removed DOM node is retained for this reuse.

Optional removal visuals can use existing mounted canonical path parts instead of reconstructing their geometry. The visual still owns its own bounded nodes and preserves the stroke's local-to-world placement.

Eviction, memory pressure, disabled retention, and disposal release aliases, identity lookups, and contour ownership through the existing cache lifecycle. Main-thread and worker ownership remain independent. Cooperative preparation continues to use the injected central `WorkScheduler`; reuse introduces no scheduling loop or deadline.

## Verification

Deterministic tests observe sample/bounds identity, record construction, canonical path builds, cache bytes, aliases, mutation rejection, cancellation, and eviction. Capacity scenarios use the complete 10,000-stroke fixture. Correct restoration and bounded work are distinct assertions; passing them does not establish physical-device latency.

Remaining validation and exact comparison may still read public transition samples. This decision removes redundant copying and derivation, not the external validation boundary. The canonical resource limits remain in [Rendering and Performance](../rendering-and-performance.md) and history behavior remains in [Features](../features.md#undo-and-redo).
