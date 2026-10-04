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
Progressive retained-node reordering shares the live-root allowance with entrants
and new selection indicators. A discovered order mismatch ends the already proven
run while preserving its successor anchor; it must not retroactively reparent an
unbounded earlier run. Unchanged retained anchors consume no publication capacity.
One explicitly new order entry does not disable progressive viewport work when
no existing element changes order. The element still publishes completely;
unproved deltas, multiple insertions, and actual reorders retain atomic publication.
When mounted updates and viewport reconciliation compete for the frame budget,
each receives the first available slice on alternating frames. Selection-edge
autoscroll resolves the current owner viewport once per frame before preview
writes; it does not retain the rectangle across frames. Pressure contour
stitching uses numeric spatial buckets with unchanged neighbor order, tolerance,
fallback, and serialized contour output.
Canonical budgets and ownership belong in
[Rendering and Performance](../rendering-and-performance.md).

Navigation distinguishes required viewport preparation from background work.
The first required remote contour has an early response; subsequent lookahead
excludes reusable local geometry and retains valid overlapping work. Remote
completion wakes the existing scene scheduler. Spatial preparation serves the
actual viewport before overscan and follows scroll or pan direction while final
SVG paint order remains canonical. Ready cached candidates can pass a suspended
cold candidate, and old-node cleanup does not precede their first preparation.

Bounded detached-node reuse avoids repeated SVG creation and geometry attribute
writes on revisits. Geometry identity and ID/version aliases share one canonical
path-cache entry. Both caches retain independent byte and entry caps, participate
in active-document memory pressure, and release stale geometry and deleted IDs.
The live-root publication cap remains unchanged: node reuse cannot eliminate
native insertion, layout, or paint costs.

A smaller fade-start quota was rejected: the paired selection-delete diagnostic
did not reduce long native tasks and increased layerization work. Keep the
existing deadline-checked fade allowance, full duration, and width-dependent blur.

For area selection, use proven whole-bounds exclusion as well as acceptance.
Reuse a bounded edge index only for factory-owned immutable lasso points. Use
direct scans for small polygons and refine stroke-box edge candidates with
conservative segment clipping so distant diagonal edges do not trigger detailed
stroke geometry. For touched lasso queries, reject pressure-addition preparation
only when error-expanded ideal capsules prove that the additions cannot touch;
translate positioned centers into page coordinates for that guard, and retain
complete preparation for full enclosure. World-space pressure-window caches remain
separate from local stroke geometry. Preserve
even-odd topology and predicate tolerances, and charge actual index and edge work rather than estimating it from
polygon size. Retain projected outline segments across appended input, invalidate
them on camera changes or compaction, and skip unchanged outline updates.
Charge small completed and nested predicate steps by their actual bounded work,
capped at the existing batch charge. Expensive domain-geometry batches retain
the conservative charge. Camera-only changes reproject retained selection geometry rather than
fetching all selected elements again. The predicate and scheduling rules belong
in [Editor Tools](../editor-tools.md#select).

Reuse validation only when the authoritative owner proves the unchanged data
identity. An internal style change does not require another scan of an exclusively
owned, unchanged stroke buffer. Validate its changed fields once and bind reuse
to immutable small headers and the exact current Store source, without retaining
obsolete source history. A transform candidate still passes through the
authoritative model's version-bound preparation and commit. External files,
clipboard content, changed fields, capacity, connections, and operation identity
retain their required checks. Do not treat a shallow frozen wrapper or a claimed
worker derivation as proof of unchanged geometry. Parser-owned runtime copies may reuse
validation only when the derivation matches the exact sample-buffer extrema
proof; external or unproved copies retain their sample checks.

Patch record and rank maps, spatial memberships, aggregate capacity, and
reverse connection references for affected records. For large structural spatial
mutations, prepare a private replacement under the shared scheduler and adopt its
state atomically. Small patches keep local updates. This trades temporary index
structure duplication and a retained-entry traversal for bounded publication; it
does not make every Store commit operation constant-time. Generation and
cancellation checks protect the preparation and its final adoption. External band orders receive
full validation; only Store-produced version-bound removals reuse proven order.
The worker reuses confirmed
order arrays for ordinary element changes, and Paste uses revision-matched model
facts and direct ID queries rather than rebuilding the existing document.
External clipboard data and inserted records retain their required validation.
Host embed paste may reuse only exact own-output readback proof, never safe-markup
recognition alone; fresh file identity and bytes still require checking.
Removed worker contours remain eligible for Undo inside the existing bounded
shape cache, with exact sample comparison only on restoration.

Cache canonical metadata fragments within bounded session ownership, while
retaining the independent exact canonical hash that binds worker output to the
authoritative document. A Store-owned stroke may retain its immutable encoded
samples across placement changes while rebuilding its position-bearing fields.
The vault adapter may pass its exact byte-length check with the immutable guarded
read; an unproved read is checked at the persistence boundary. Obsolete
metadata-digest work stops at cooperative checkpoints before using the result
or the one allowed integrity retry. Recognition may reuse own-save output only
after the existing fresh file identity check confirms it; external changes
still invalidate recognition. Visible presentations reuse the same recognition
request and validated descriptor when the Vault resource and exact content
identity agree. Shared validation preserves its original concurrency limits and
input priority; DOM ownership stays per presentation.

For overlapping viewport edge queries, merge entering IDs into the retained
sorted bands when retained ranks are unchanged. Do not use the DOM-publication
count as a cutoff for a computed edge delta. Keep its publication resumable under
the scheduler and the separate live-root allowance. Preserve complete sorting for
unsupported state, existing spatial-query reuse, and hysteresis.

Avoid asynchronous continuations for synchronous checkpoint decisions. Large
handle commits and the clipboard fallback await only actual scheduler handoffs;
canonical serialization and cancellation boundaries remain unchanged. Exhausted
motion-path or byte capacity is checked before constructing replacement geometry.
The existing eraser blur feedback is retained. Handle cancellation reuses unchanged
selection geometry, and zero-displacement correction does not schedule per-element
work. Large decorative selection-trace removals operate on a temporarily detached
group while preserving retained nodes and sibling order; content publication
limits remain unchanged. After a complete reconciliation scan proves retained
relative order, insert returning elements between retained DOM anchors rather
than reparenting unchanged nodes; retain the full ordering path for actual reorder
and partial detachment. A still-mounted exit returning with an older visibility
generation uses a temporary, once-per-band DOM-position map to prove its retained
order. Progressive publication invalidates that proof; reconciliation disposal
releases it. Completion refreshes the retained proof in the existing visibility
copy, so future full reconciliations can reuse it. Partial work never publishes a
completed proof. A stale generation alone must not move unchanged DOM nodes.
Pressure-window publication shares one identity-bound
memory measurement with its immediate consumer. Warm metadata digest assembly
batches cooperative checkpoints while keeping output-copy slices bounded and
rechecking Store ownership after asynchronous encoding.

Guarded vault reading overlaps asynchronous worker bootstrap during activation.
The initial executor owns that one read; executor recovery reads fresh bytes, and
a cancelled or disposed activation publishes no partial model. The initial
visible-scene readiness barrier remains unchanged.

Confirmed-base preflight may use native SHA-256 after bounded UTF-8 encoding for
files up to 20 MiB, retaining no whole-file cache. Larger content and native
failures keep cooperative streaming hashing. This trades a bounded temporary
byte buffer for reduced main-thread hash computation; it does not bypass exact
base checks or shorten the intentional inactivity debounce. The original 500-millisecond value is superseded by the 1,000-millisecond debounce in the [central scheduling decision](central-work-scheduler.md).

Pressure-union preparation rejects provably separated circle/line carriers before
expensive endpoint and intersection calculations, using conservative roundoff
reserves. Arc parameter checks similarly reject provably off-circle points using
a padded squared-radius band before radial distance and angle work. A single
capsule reuses its existing closed boundary. Keep the exact
union fallback and existing serialized-path budgets for unsafe chain joins; do
not exchange reduced computation for unbounded compound-path output.

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
