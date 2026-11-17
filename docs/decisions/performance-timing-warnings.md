# Performance Timing Warnings

> Historical decision, superseded by [Deterministic Performance Checks](deterministic-performance-checks.md). Timing commands and comparison rules below are no longer active.

## Decision

The historical policy used a common 20-percent ratio-only comparison, identically locally and on GitHub. Remove the absolute relevance floor. Keep valid unresolved timing results as visible nonblocking warnings, never as successful timing evidence. Detected regressions and invalid or missing evidence still fail. Preserve p99, deterministic contracts, reference-device budgets, PR-base-only comparisons, the action populations and stages specified by the [bounded-plan decision](performance-bounded-measurements.md).

## Reason

An absolute relevance floor weakens sensitivity to short operations by allowing large relative slowdowns below that floor. Source-identity skips and contracts-only execution cannot justify a universal timing floor. Widening an allowed slowdown does not resolve measurement uncertainty.

## Consequences

A change with genuinely slower code may merge when valid timing evidence remains inconclusive. A nonzero exit is reserved for blocking violations or execution/evidence failures; successful exit no longer asserts every timing comparison passed. Reports retain uncertainty explicitly. The existing relative margin still permits smaller regressions, and there is no historical drift reference.

No benchmark, warmup, sample population or retry is added. More noisy comparisons can use the existing final stage after the floor is removed, so the change does not guarantee shorter execution. The job ceilings are twenty minutes; timeouts are failures, not warnings. Local and hosted commands used the same contracts and comparator.

## Evidence Boundaries

The 20-percent boundary replaced the earlier 50-percent allowance as a chosen regression budget, not an estimate of noise. Unchanged-source failures require investigation of both measurement conditions and actual work; making an operation faster does not itself resolve noise. The historical authoring policy required controls, negative evidence, and explicit limitations for new timing scenarios. Neither retrospective controls nor source-identity skips establish full-suite completion, hosted stability, or detection of every small or rare slowdown.
