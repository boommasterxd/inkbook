# Bounded Performance Measurements

> Historical decision, superseded by [Deterministic Performance Checks](deterministic-performance-checks.md). Timing commands and comparison rules below are no longer active.

## Decision

Run all candidate capacity, correctness, resource, and scheduling contracts once per classified profile before comparing speed. Use their timing evidence to select exact file/test scenarios. Never infer successful coverage from omitted or malformed evidence. Scenarios must own their fixture state.

Use exactly six paired processes, with three AB and three BA orders declared before measurement. Require six of six ratios strictly below or above the 1.20 boundary to decide pass or regression. Other valid evidence warns; regression and execution/evidence errors fail. There is no automatic second stage. This supersedes the initial six/twelve plan.

The expensive domain transform, maximum-pressure-stroke, and Clipboard scenarios use one measured run per process instead of five in measurement mode only. Keep the original domain warmups and action populations: 50 measured 10,000-stroke transforms and 20 maximum pressure strokes. Clipboard retains 20 measured copies plus 20 pastes, with one complete warmup of each operation in measurement mode and the original twenty in reference mode. Clipboard emits one worst-run p95 per operation; full reference mode retains five runs and equivalent original budgets. Full domain contracts retain all five runs; Clipboard contracts retain five single-action runs, keeping metric identities stable across modes. This reduces temporal coverage, not fixture size. Full and order-only exports use five measured operations each instead of twenty; incremental exports retain all one hundred. The existing p95 estimator becomes the maximum of five full/order-only observations, while reference mode retains 20/100/20 samples. Export warmup and exact acknowledged/prewarmed runtime state remain unchanged.

Remove redundant unmeasured setup: execute the exact-base callback's full save lifecycle once, retaining one callback warmup and five timed real callback invocations with fresh string copies. The callback reads constant closure state and mutates none before the enclosing process completes. Pressure-group static matching uses a deterministic serialization-setup hash because the measured matcher consumes no metadata hash.

The snapping scenario creates only its own dense-target store, without constructing an unused standard-domain store. Maximum viewport strokes construct their final typed points directly, without first allocating and discarding a second point array. Their returned fixtures and measured populations remain unchanged.

Keep the two existing runners and twenty-minute hosted job ceilings. Move Clipboard, exact-base-save-callback, and pressure-group-integrity invariant files to the refresh-profile shard at 120 Hz; the shared shard keeps the other invariant and all budget-only files. The local run executes their exact union. All five cadence contract profiles remain.

The canonical policy is in [Performance CI](../performance-ci.md). More extensive diagnostics are manual; this decision adds no recurring job.

## Rationale and Limits

The previous whole-file six/eighteen-pair scheme nested repeated processes around expensive repeated actions. One inconclusive metric could repeat an entire mixed file. Removing unrelated comparisons alone does not bound the cost of genuinely affected capacity scenarios.

The new plan reduces work but can leave more uncertainty and miss slowdowns that the longer population would resolve. The per-metric one-sided false-pass bound for six unanimous signs is `1/64 = 0.015625`, assuming independent signs with null probability at most one half. This is not a guarantee across all metrics or against merging a real regression: warnings remain nonblocking. No percentage or timeout is widened.

## Verification Requirements

Verify exact scenario matching, failed/skipped/missing evidence, state independence, exact six-pair decisions, and disjoint hosted coverage equal to the complete local run. Run unchanged-code controls and targeted slowdowns, including sparse action-tail delays, with the fixed population chosen before measuring. Preserve raw results and report unresolved evidence. A hosted Core-input control must measure actual comparisons; a source-identity skip proves neither noise stability nor runtime. Completion of one selected control does not establish the full-suite worst case.
