# Order-statistics trees

## Status

Accepted.

## Context

Flat render-band arrays and stored numeric ranks made removal of one early element update every later rank and publish unnecessary survivor order deltas. Sparse erasing should not require document-wide order maintenance.

## Decision

Each render band owns one mutable deterministic AVL sequence with an ID-to-node map, parent links, subtree cardinalities, and heights. Rank lookup, positional insertion, and removal visit O(log n) nodes. In-order traversal remains O(n). Initial hydration constructs these structures inside its existing slices and adopts them without rebuilding the order.

The existing public numeric-rank contract remains derived from the tree. Renderer comparisons refresh ranks from the store; mounted nodes retain no stale rank metadata. Removal leaves survivor-relative order unchanged and publishes no survivor order changes. Explicit arrangement and complete reordering may materialize temporary arrays, then rebuild the affected tree. Export still materializes canonical ordered arrays.

## Consequences

The trees replace authoritative arrays and rank maps; they do not coexist with a second authoritative order representation. Their actual traversal and metadata-update boundaries are instrumented and covered by deterministic 10,000-element work contracts. This verifies bounded work, not physical-device latency.

General prepared mutations and removal-history payloads still use complete temporary band snapshots at this stage. A separate compact mutation path can use rank lookup, positional insertion, and removal directly. Full-document export and large arrangement remain proportional to the document size by design.
