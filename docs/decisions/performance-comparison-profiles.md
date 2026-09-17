# Performance Comparison Profiles

## Decision

Use 120 Hz for recurring cadence-sensitive PR-base timing comparisons in both local and hosted gates. Preserve all five cadence profiles for deterministic contracts and explicit reference execution. Keep invariant comparisons at 120 Hz and budget-only comparisons at 240 Hz. The two existing performance shards, twenty-minute hosted job limits, 20-percent comparison boundary, warning/error rules remain unchanged. Comparison stages now follow the [bounded-plan decision](performance-bounded-measurements.md).

Separate existing benchmark scenarios with different source dependencies into focused files. Keep every scenario, full fixture, warmup, action sample population, statistic, budget, and assertion. File splitting enables the existing conservative input planner to skip genuinely unchanged timing inputs; it must not hide a dependency.

The canonical execution and authoring rules are in [Performance CI](../performance-ci.md).

## Rationale

A hosted control with a behavior-preserving `ElementStore.getRank()` refactor exceeded twenty minutes in both performance shards. The shared shard repeatedly selected expensive export measurements because the same file contained an unrelated store-hydration scenario. Cadence comparisons completed eighteen pairs at 60 and 90 Hz but timed out during 120 Hz. Increasing the timeout alone did not establish a usable bound.

This decision reduces recurring work instead of adding runners. It does not reduce samples inside the retained timing scenarios or replace action tails with averages. The store-hydration scenario remains a complete structural contract, with its existing descriptive phase annotations; those annotations are not new relative timing evidence.

## Consequences and Verification

A cadence slowdown confined to another refresh rate can be missed when deterministic contracts still hold. Simulated scheduling and bounded-work checks are not evidence of execution speed at unmeasured profiles. Physical reference-device obligations remain unchanged.

Validate the resulting selection and runtime with the same hosted Core-file control. Report actual completed comparisons, warnings, failures, runner time, and remaining coverage separately from source-identity skips. Completion of that selected control within twenty minutes would not establish a whole-suite worst-case bound or prove detection of every regression.

## Observed Hosted Result

The [focused Core-file control](https://github.com/boommasterxd/inkbook/actions/runs/35272307186) completed quality in 6m37s and cadence in 16m39s. Cadence selected six files at 120 Hz, retained all five contract profiles, and reported 30 passing plus 10 inconclusive metrics with no detected regression. The shared job still exceeded twenty minutes: independent export measurements were no longer selected, but the eight selected budget files took about 84 seconds per measurement batch and timed out during pair five. The twenty-minute goal is therefore not established for this Core-file control, much less the complete suite.

A separate local single-batch cost diagnostic identified the existing 300 full 10,000-stroke transformations, including warmup, as the largest individual test. This is genuine store-dependent work, so dependency splitting alone cannot eliminate it. No sample-count reduction or further timeout increase is part of this decision.
