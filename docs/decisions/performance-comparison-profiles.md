# Performance Comparison Profiles

> Historical decision, superseded by [Deterministic Performance Checks](deterministic-performance-checks.md). Timing commands and comparison rules below are no longer active.

## Decision

Use 120 Hz for recurring cadence-sensitive PR-base timing comparisons in both local and hosted gates. Preserve all five cadence profiles for deterministic contracts and explicit reference execution. Keep invariant comparisons at 120 Hz and budget-only comparisons at 240 Hz. The two existing performance shards, twenty-minute hosted job limits, 20-percent comparison boundary, warning/error rules remain unchanged. Comparison stages now follow the [bounded-plan decision](performance-bounded-measurements.md).

Separate existing benchmark scenarios with different source dependencies into focused files. Keep every scenario, full fixture, warmup, action sample population, statistic, budget, and assertion. File splitting enables the existing conservative input planner to skip genuinely unchanged timing inputs; it must not hide a dependency.

The canonical execution and authoring rules are in [Performance CI](../performance-ci.md).

## Rationale

Mixed files couple unrelated dependencies: a store-hydration scenario can select expensive export comparisons even when their production inputs are unchanged. Repeating cadence comparisons across all profiles multiplies that work. Increasing the timeout does not bound the comparison workload.

This decision reduces recurring work instead of adding runners. It does not reduce samples inside the retained timing scenarios or replace action tails with averages. The store-hydration scenario remains a complete structural contract, with its existing descriptive phase annotations; those annotations are not new relative timing evidence.

## Consequences and Verification

A cadence slowdown confined to another refresh rate can be missed when deterministic contracts still hold. Simulated scheduling and bounded-work checks are not evidence of execution speed at unmeasured profiles. Physical reference-device obligations remain unchanged.

The historical validation policy required hosted controls of the affected Core inputs, with actual comparisons distinguished from source-identity skips. Completion of a selected control within twenty minutes would not establish a whole-suite worst-case bound or prove detection of every regression.
