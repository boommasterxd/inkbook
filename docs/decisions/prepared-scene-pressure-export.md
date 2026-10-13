# Reusing Prepared Scene Pressure Paths in Export

## Status

Accepted. This extends the bounded path-cache contract in
[Rendering and Performance](../rendering-and-performance.md#path-caches).

## Problem

The active scene can prepare a pressure contour that the document worker later
rebuilds for its first canonical export. Moving this duplicate calculation into
shorter scheduler slices does not remove its cost. Searching every stored stroke
or comparing its samples again on the main thread would introduce another
expensive preparation pass.

## Decision

Enumerate the Store-owned prepared-path cache, not the complete document.
Only current, internally generated local pressure paths may become export hints.
The existing Store path LRU retains an exact weak sample-identity witness and
immutable local shape fields for each local entry. It checks these against the
current owned record; the host attaches hints only when its current document
revision matches the export plan. Old geometry ports cannot read or publish after
their captured version changes. Placement changes preserve a compatible local
entry; changed samples or shape fields and removal invalidate it. A geometry-neutral
Store delta can rebind an exact old witness to a new owned sample buffer after the
Store has proved equal sample values and unchanged local shape fields. This adds
no sample comparison in cache publication and accepts no public trust flag. Local witnesses
add 192 bytes to each entry within the existing 1,024-entry and 4-MiB limits.
Version-bound world entries remain separate and never supply local export hints.
The bounded request carries the current revision and local shape header with the
path. The first accepted export
per worker epoch can seed unchanged baseline contours even on an incremental
request; later incremental requests select changed IDs only. An epoch change
reopens that initial handoff. Nonzero offsets are eligible only through the
explicit local path port and its owned shape witness. Both producer and receiver
derive the header from `strokeLocalGeometry`, including its localized rotation
pivot. World-space selection windows remain separate. Lazy enumeration visits at most 1,024 current cache
entries and retains at most 4 MiB in one handoff.

The worker checks request/revision agreement, supported shape fields, path syntax,
and transport limits before seeding its existing shape cache. It does not possess
an independently matching Store geometry version. Correct geometric provenance
therefore relies on the internal producer's version and revision checks, rather
than claiming that syntax validation proves equality with stroke samples.
Missing, ineligible, stale, or malformed hints use the ordinary geometry builder.
External SVG markup never supplies these hints. Mandatory saved-output checks and
readback remain unchanged.

The handoff reuses existing bounded cache ownership and imposes its own entry and
byte limits. It does not introduce a second document geometry store, share mutable
objects between threads, or persist derived contours in the editable snapshot.
The source cache, transferred request, and worker cache have separate lifetimes.

## Consequences and Verification

Reuse saves computation only for eligible contours still retained when export is
prepared. It adds bounded string transport and syntax checking; it does not make
cold geometry for uncached strokes free. Resource tests must observe actual shape
builds, transmitted bytes, cache invalidation and release, and output equivalence.
Same-length point edits and delayed export plans must not reuse stale contours.
Physical-device latency and the temporary combined main-thread/worker heap peak
during actual structured-clone transport require separate verification. The
deterministic fallback tests do not measure that cross-thread peak.
