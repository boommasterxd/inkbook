# Performance Timing Warnings

## Decision

Use the common 20-percent ratio-only comparison and outcome table in [Performance CI](../performance-ci.md#comparison-policy), identically locally and on GitHub. Remove the absolute relevance floor. Keep valid unresolved timing results as visible nonblocking warnings, never as successful timing evidence. Detected regressions and invalid or missing evidence still fail. Preserve p99, deterministic contracts, reference-device budgets, PR-base-only comparisons, existing sample populations and bounded stages.

## Reason

The earlier absolute floor reduced inconclusive results in local live-stroke controls but weakened sensitivity to short operations. Replaying twice the recorded handoff values passed the floor-based rule in all five profiles; this was an algebraic sensitivity check, not a measured source mutation. The available complete-suite reports were contracts-only executions with source-identity skips and did not validate a universal floor. Widening an allowed slowdown does not resolve measurement uncertainty.

## Consequences

A change with genuinely slower code may merge when valid timing evidence remains inconclusive. A nonzero exit is reserved for blocking violations or execution/evidence failures; successful exit no longer asserts every timing comparison passed. Reports retain uncertainty explicitly. The existing relative margin still permits smaller regressions, and there is no historical drift reference.

No benchmark, warmup, sample population or retry is added. More noisy comparisons can use the existing final stage after the floor is removed, so the change does not guarantee shorter execution. The job ceilings are twenty minutes; timeouts are failures, not warnings. Local and hosted commands use the same contracts and comparator, with runtime reproduction described in [Local and GitHub Parity](../performance-ci.md#local-and-github-parity).

## Evidence Scope

Stored local Node.js 26 live-stroke controls cover one file with five metrics across all five profiles. Replaying the stored populations with the 20-percent rule yields no regression on unchanged source and an inconclusive overall comparison in each profile. At 90, 120 and 144 Hz the full eighteen pairs are available; these unresolved comparisons warn. Only six pairs exist at 60 and 240 Hz: a live gate would continue to eighteen, so their final decisions and added-stage runtime are not established by this replay. Sparse source mutations adding 0.25 ms to two of 120 handoffs are classified as handoff regressions in all five profiles. This retrospective replay does not calibrate every scenario or hosted runner or demonstrate detection of an actual 20-percent source slowdown. The 20-percent boundary replaces the earlier 50-percent allowance; it is a chosen regression budget, not an estimate of noise. No production optimization was justified by an unchanged-source regression in these stored results. A future unchanged-source failure requires investigation of both measurement conditions and the actual work; making an operation faster does not itself prove noise has been resolved. New timing scenarios require the controls, negative evidence and limitations documented in [Adding or Changing Performance Tests](../performance-ci.md#adding-or-changing-performance-tests).
