# Bounded Performance Measurements

## Decision

Run all candidate capacity, correctness, resource, and scheduling contracts once per classified profile before comparing speed. Use their timing evidence to select exact file/test scenarios for measurement. Repeat only unresolved scenarios after the first decision point; never infer successful coverage from omitted or malformed evidence. Scenarios must own their fixture state.

Use six paired processes initially and at most twelve, with three AB and three BA orders in each stage. Require six of six ratios on the same side of the 1.20 boundary at the first stage, or ten of twelve at the final stage; keep first-stage decisions frozen. Unresolved evidence warns; regression and execution/evidence errors fail. Keep the two existing shards and twenty-minute hosted job ceilings.

The expensive domain transform and maximum-pressure-stroke scenarios use one measured run per process instead of five in measurement mode only. Keep the original warmup, 50 measured 10,000-stroke transforms, 20 measured maximum pressure strokes, and all action samples within each retained run. Full contracts and explicit reference execution retain all five runs and original capacity assertions. Thus the PR statistic for these scenarios is one run's distribution, rather than the worst of five distributions; it is not an average of action times.

The canonical policy is in [Performance CI](../performance-ci.md). More extensive diagnostics are manual; this decision adds no recurring job.

## Rationale and Limits

The previous whole-file six/eighteen-pair scheme nested repeated processes around expensive repeated actions. One inconclusive metric could repeat an entire mixed file. The focused Core-file run still exceeded twenty minutes even after removing unrelated export comparisons.

The new plan reduces work but can leave more uncertainty and miss slowdowns that the longer population would resolve. The per-metric one-sided false-pass union bound is `1/64 + 79/4096 = 0.034912109375`, assuming independent signs with null probability at most one half. This is not a guarantee across all metrics or against merging a real regression: warnings remain nonblocking. No percentage or timeout is widened.

## Verification Requirements

Verify exact scenario matching, failed/skipped/missing evidence, state independence, frozen first-stage decisions, and both decision thresholds. Run unchanged-code controls and targeted slowdowns, including sparse action-tail delays, with the fixed population chosen before measuring. Preserve raw results and report unresolved evidence. A hosted Core-input control must measure actual comparisons; a source-identity skip proves neither noise stability nor runtime. Completion of one selected control does not establish the full-suite worst case.

## Measured Validation

Fresh local Node.js 26 paired controls used the predeclared six/twelve plan and exact scenario selection. The five live-stroke metrics finished with four passes and one inconclusive result after twelve pairs, without a detected regression. Adding 1 ms to two of 120 actual renderer handoffs in an isolated disposable source tree produced a p99 regression after six pairs.

The changed 50-action transform population was separately controlled at 240 Hz: three metrics passed and one remained inconclusive after twelve pairs. Adding 20 ms inside the actual time-sliced transform operation in a disposable source tree produced two regressions after six pairs, including materialization ratios of approximately 1.51 to 1.67. The other metrics were one pass and one inconclusive result. Neither mutation changed the tracked production source. These are targeted local sensitivity checks for clear slowdowns, not proof of reliably detecting a slowdown just above 20 percent or every rare pause.

A replay of earlier stored measurements also retained ten inconclusive unchanged-source profile cases without a regression and detected five sparse 0.25-ms handoff mutations after six pairs. It is retrospective supporting evidence, not a fresh whole-suite control.

The first hosted Core-input control of this plan completed cadence comparisons in 8m30s but still timed out the shared job during its tenth budget pair. Its budget measurement batches fell to approximately 51 seconds initially and 34 seconds for unresolved scenarios, but retained unrelated pressure/geometry scenarios through shared test imports. Those existing scenarios were subsequently separated without changing their action populations or assertions. The unsuccessful run remains part of the evidence; reducing repetition alone did not meet the runtime objective.

The subsequent [hosted Core-input control](https://github.com/boommasterxd/inkbook/actions/runs/35279877389) completed quality in 4m02s, shared performance in 18m38s, and refresh performance in 10m24s. Shared produced 35 passes and 12 inconclusive metrics; refresh produced 24 passes and 13 inconclusive metrics. Neither shard reported a regression or contract/evidence violation. A comment appended only inside the disposable runner's Store file triggered normal changed-input selection without changing executable source; no diagnostic Store change was committed. Both comparisons reached the fixed twelve-pair stage. This validates that selected Core control, with only 1m22s of shared-job headroom, not the all-files worst case or a guarantee against slower hosted runners.
