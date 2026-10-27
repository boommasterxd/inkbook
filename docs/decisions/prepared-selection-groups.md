# Prepared Selection Groups

## Context

Updating a transform on every mounted selected element repeats SVG attribute and
style work during continuous gestures. The scene can share a transform when its
existing retained nodes form a valid, profitable set of contiguous paint-order
runs. Grouping is a presentation optimization; the Store and saved SVG retain
their complete element identities, geometry, order and connections.

## Ownership and admission

The existing scene scheduler prepares and validates a plan through its shared
deadline. Preparation retains the original selection identity and a version-bound
render-order cursor. It admits at most one contiguous run per render band, keeps
other selected nodes as exceptions, and declines plans whose shared parents plus
local feedback would not save transform surfaces.

Canonical snapshot path costs, including filled arrow nodes, remain bounded by
the existing 256-path preview capacity. A planned grouped snapshot containing a
pressure fill or a filled arrow endpoint declines the whole plan before any group
is activated. Those snapshots need canonical geometry with finite paint width at
a zero scale; preserving an additional return surface has no reserved memory
budget. Physical exceptions may retain these elements because their existing
canonical preview writer remains authoritative. Declined plans use that same
legacy pipeline, including its existing snapshot capacity and selection policy.

## Gesture and commit behavior

The scene owns the prepared ink and selection-indicator parents. The physical
parent matrices stay invertible, including during a zero-scale gesture. Required
per-element residuals use the existing feedback writer and canonical snapshot
pipeline. No additional singular-paint surface, retry queue or rendering engine
is retained.

Move supplies known numeric matrix coefficients and the original selection
identity only when every selected element participates in the affine preview.
Selected connected-line or arrow exceptions retain their existing producer and
per-element path. A ready full-selection Move uses the same group owner and lazy
transform view as Resize; it does not construct another per-element transform
map or materialize new model geometry for pointer feedback.

A preview owner retains at most one computed feedback transform for members
without a canonical snapshot basis. Its key includes request identity, version
and zoom. Individual snapshot bases remain independent; request replacement and
release clear the retained result.

Production matrix metadata composes retained transforms numerically across
overlapping commits. The existing commit handoff, visibility reconciliation and
central canonical drain preserve the last complete preview. Offscreen members
do not build replacement geometry until required for visibility; they must have
current canonical geometry before readmission exposes their paint. Cancellation,
selection changes, stale plans and presentation disposal release their owners.

Prepared inactive nodes retain natural SVG paint. Only transformed run parents
activate their finite local width/dash palette. Camera changes do not rewrite a
selection palette on the SVG root or modify a stylesheet.

## Verification boundary

Deterministic tests observe actual SVG writes and ownership, geometry publication,
snapshot admission, ordering, cancellation, overlapping gestures, viewport reentry
and cleanup under the injected scheduler. They do not establish execution speed.
Native Obsidian verification compares complete persisted documents as well as
input feedback, release, pan, zoom, scrolling and intermediate visible geometry.
Callback timing, browser layout/paint and physical presentation remain distinct
measurements. Grouping does not promise constant-time model commits or browser
paint, change persisted file size, or establish physical mobile-device latency.
