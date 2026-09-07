# Pressure Path Capacity

Status: Accepted

## Context

Pressure strokes use consistently wound swept subpaths so tight reversals and self-overlaps remain filled. A single SVG path applies opacity once across those subpaths. Splitting them into separately painted paths would darken overlaps for translucent strokes and require additional envelope grouping semantics.

The former per-path allowance rejected valid strokes near the existing 4,096-sample limit. The sweep approximates each interior quadratic with at most eight hulls and adds at most two endpoint hulls. Each hull uses at most six SVG commands, giving `(4,094 * 8 + 2) * 6 = 196,524` commands. Bounded canonical coordinates and radii keep the corresponding path below 6 MiB.

## Decision

Retain one painted path per pressure stroke and raise only the per-path byte and command allowances to the values in the [static-markup allowlist](../svg-envelope.md#strict-static-markup-allowlist). The byte allowance includes headroom above the derived maximum. Preserve the aggregate path-byte, command, path-count, file, snapshot, element, and point limits.

## Consequences

The validator can retain a larger individual path while total document admission remains bounded by the existing aggregate limits. Parsing continues to yield in bounded byte and command batches, including within a single path; the larger allowance must not turn one stroke into an uninterrupted validation task.

Regression coverage exercises 4,096-sample strokes with tight reversals, wide turns, and extreme coordinates. Boundary tests reject paths exceeding either per-path limit and documents exceeding aggregate limits. The existing maximum-complexity validation benchmark uses the expanded per-path boundary and retains its main-thread slice budget.
