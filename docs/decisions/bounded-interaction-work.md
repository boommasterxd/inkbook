# Bounded Interaction Work

Status: Accepted

## Context

Large documents exposed two different delays: expensive work inside individual
frames and unnecessary frame waits before useful results became visible. Short
preparation slices did not prevent a large synchronous DOM publication. Repeated
validation and reconstruction also revisited unchanged, already owned data.

## Decision

Bound actual geometry and DOM work independently. Publish ready viewport entrants
in ordered batches instead of waiting for every entrant. Initial activation still
waits for its complete readiness contract; partial pressure paths are never
published. Store commits remain atomic, and retained nodes preserve render order.
Pressure contour stitching uses numeric spatial buckets with unchanged neighbor
order, tolerance, fallback, and serialized contour output.
Canonical budgets and ownership belong in
[Rendering and Performance](../rendering-and-performance.md).

For area selection, use proven whole-bounds exclusion as well as acceptance.
Charge small completed and nested predicate steps by their actual bounded work,
capped at the existing batch charge. Expensive domain-geometry batches retain
the conservative charge. Camera-only changes reproject retained selection geometry rather than
fetching all selected elements again. The predicate and scheduling rules belong
in [Editor Tools](../editor-tools.md#select).

Reuse validation only when the authoritative owner proves the unchanged data
identity. An internal style change does not require another scan of an exclusively
owned, unchanged stroke buffer. A transform candidate still passes through the
authoritative model's version-bound preparation and commit. External files,
clipboard content, changed fields, capacity, connections, and operation identity
retain their required checks. Do not treat a shallow frozen wrapper or a claimed
worker derivation as proof of unchanged geometry.

Patch spatial memberships, aggregate capacity, and reverse connection references
for affected records. Complete band-order checks remain where the existing
mutation representation requires them. Cache canonical metadata fragments within
bounded session ownership, while retaining the independent exact canonical hash
that binds worker output to the authoritative document. Recognition may reuse
own-save output only after the existing fresh file identity check confirms it;
external changes still invalidate recognition.

Remove obsolete paths and parameters instead of retaining disabled copies. Keep
one implementation for each responsibility and release bounded caches and pending
work with their owning session or presentation.

## Verification

Deterministic regressions observe real primitive visits, point reads, index work,
DOM publication, frame progression, cache eviction, and cancellation. Initial
mount, viewport changes, selection, transforms, history, and persistence retain
their existing correctness cases. See the
[verification model](../performance-ci.md#unified-verification-model).

Real Obsidian profiling remains necessary for browser DOM, style, paint, and
interaction latency. Passing work bounds does not establish the physical-device
latency targets or eliminate the linear cost of assembling complete saved files.
