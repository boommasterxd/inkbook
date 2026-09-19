# Deterministic Performance Checks

## Decision

Remove real elapsed-time and CPU-time measurement from the automated performance suite, including statistical repetitions, warmups, PR-base comparisons, timing evidence, and tolerance policy. Keep direct work/resource contracts and simulated scheduling in both local and GitHub CI. Retain the existing two hosted performance checks and twenty-minute job safety limits.

This supersedes [PR-base comparison](performance-base-comparison.md), [bounded measurements](performance-bounded-measurements.md), [comparison profiles](performance-comparison-profiles.md), and [timing warnings](performance-timing-warnings.md). Their measurements remain historical evidence, not current instructions.

## Reason

Hosted runner variation produced inconclusive results and repeated timeouts despite bounded comparison plans and removed setup work. The full-input cost diagnostic required about 22.5 minutes of shared comparisons alone before contracts and setup. The user chose to remove timing runs and add missing deterministic coverage instead of adding runners or reducing statistical populations again.

## Consequences

Direct bounds on indexed visits, coordinate reads, fragment/geometry construction, DOM writes, host calls, queues, and owned storage catch covered forms of unnecessary work. Controlled clocks verify scheduling. Large fixtures and meaningful state transitions remain. Heap ceilings remain resource checks with runtime-dependent readings.

A computation can become slower while its observed work counts stay unchanged. Such regressions, including real p99 regressions, are no longer automatically detected. Deterministic work evidence is not a replacement measurement of speed. Physical-device latency targets remain acceptance requirements outside this CI suite.

The canonical implementation and authoring rules are in [Performance CI](../performance-ci.md). A complete hosted run must verify the observed full-plan duration; no constant-time guarantee follows from one run on shared hardware.

## Verification

The complete local `npm run ci` passed: 3,206 quality tests, the required source-coverage thresholds, lint/type/architecture checks, dependency audit, build/package verification, and all 103 performance file/profile executions. Independent review checked the instrumentation boundaries and documentation.

Two disposable-source extra-work mutations were rejected by the deterministic contracts: duplicate static-fragment generation produced 20,000 calls instead of 10,000, and rendering semantically unchanged chrome produced 13 React renders instead of one. Both temporary source copies were removed; tracked production code did not change. These checks demonstrate the observed work protections, not detection of arbitrary computation or latency regressions.

The [complete hosted diagnostic](https://github.com/boommasterxd/inkbook/actions/runs/35349332084) passed on the diagnosis branch: quality took 6m19s, shared performance 3m23s, and all five refresh profiles 1m39s. The parallel run took 6m20s from the first job start to the last completion, with 11m21s summed job execution before billing rounding. Logs confirm all 48 invariant files and five batches of 11 cadence-sensitive files ran. No changed-input selection was involved. This validates the observed full-plan execution below the twenty-minute job ceilings; it is not a guarantee for future runner load, added tests, or queue time.
