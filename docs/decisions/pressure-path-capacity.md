# Pressure Path Capacity

Status: Accepted

## Context

The original swept pressure geometry produced large paths, and selection feedback remained visibly delayed. Banded centerlines reduced path complexity but visibly stepped the pressure profile. Pressure rendering must preserve smooth width variation, compact geometry, and responsive live feedback.

## Decision

Represent each pressure stroke with one filled path of compact continuous-pressure ribbons inside one opacity group. Preserve the editable sample and style schema without pressure-band quantization. Canonical geometry and interaction scheduling are defined in [Rendering and Performance](../rendering-and-performance.md); exact paint, group grammar, and resource limits are defined in the [static-markup allowlist](../svg-envelope.md#strict-static-markup-allowlist).

Retain the 60,004-path document allowance: three paths for each of 20,000 possible elements plus four background-path slots. Pressure groups each contain exactly one direct path, with at most 20,000 groups across the two paint bands. Preserve all per-path, aggregate path-byte, command, file, snapshot, element, and point limits. Reject nested, empty, or multi-path opacity groups and unlisted group attributes.

Apply the product of style opacity and RGBA alpha once at the group, rounded to four decimal places. The child path uses opaque fill; Theme text uses the canonical fill class. The active scene and export share this paint normalization.

There are no deployed pressure files requiring compatibility. Discarded pre-release pressure representations have no reconstruction or migration fallback; validated snapshots produce only the current continuous-pressure path and group.

## Consequences

Small pressure changes continue to affect the path instead of snapping between width levels. The scene retains one filled path per committed stroke. Compact geometry and bounded live construction reduce the path work needed for writing and selection feedback; pressure samples remain available in editable metadata.

Canonical pressure paths use equivalent relative quadratics and arcs when shorter, reducing repeated large absolute coordinates without changing the contour. Static inspection resolves these coordinates in integer thousandths, checks absolute bounds, and still yields within path and byte batches. Aggregate limits remain authoritative even when the element count or path count separately fits. A document that exceeds any aggregate limit is not admitted.

Regression coverage round-trips 4,096-sample strokes with tight reversals, wide turns, and extreme coordinates. Group tests exercise 20,000 single-path groups, shared group-count limits across paint bands, invalid nesting and extra paths, and exact opacity and paint. The canonical integrity contract verifies 10,000 pressure groups with lazy, bounded fragment generation. It does not measure unlock latency.
