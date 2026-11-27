# Deterministic Performance Checks

This record describes the original shift from automated timing comparisons to deterministic checks. The [current verification contract](../performance-ci.md) limits permanent performance tests to viewport publication and coalesced pen input and requires direct runtime verification for other affected costs.

## Decision

Remove real elapsed-time and CPU-time measurement from the automated performance suite, including statistical repetitions, warmups, PR-base comparisons, timing evidence, and tolerance policy. Keep direct work/resource contracts and simulated scheduling in both local and GitHub CI. Retain the existing two hosted performance checks and twenty-minute job safety limits.

This supersedes [PR-base comparison](performance-base-comparison.md), [bounded measurements](performance-bounded-measurements.md), [comparison profiles](performance-comparison-profiles.md), and [timing warnings](performance-timing-warnings.md). Those documents retain historical policy and rationale, not current instructions.

## Reason

Shared hosted runners introduce measurement uncertainty, and repeated speed comparisons compete with complete contracts and setup for the twenty-minute job ceiling. The accepted choice removes timing runs and adds missing deterministic coverage instead of adding runners or further reducing statistical populations.

## Consequences

Direct bounds on indexed visits, coordinate reads, fragment and geometry construction, DOM writes, host calls, queues, and owned storage identify excess work at the observed boundaries. Controlled clocks verify scheduling. Retain large fixtures and meaningful state transitions for the work being checked. Measure the heap ceilings on the reference devices.

A computation can become slower while its observed work counts stay unchanged. Such regressions, including real p99 regressions, are no longer automatically detected. Deterministic work evidence is not a replacement measurement of speed. Physical-device latency targets remain acceptance requirements outside this CI suite.

The canonical implementation and authoring rules are in [Performance CI](../performance-ci.md). Complete hosted execution remains subject to the twenty-minute job ceiling; shared hardware provides no constant-time guarantee.

## Verification Boundaries

When a change affects static fragment generation or React chrome rendering, observe duplicate work at the production boundary in running Obsidian. The two permanent CI contracts and the separate physical-device checks remain defined in [Performance Verification](../performance-ci.md).
