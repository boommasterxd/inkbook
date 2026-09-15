# Hosted Performance Calibration

## Scope

The unscaled performance budgets in [Quality and Testing](quality-and-testing.md) remain the product targets. Passing tests on a development workstation or hosted runner does not establish rendering latency on the required desktop and mobile reference devices.

The current local development machine is a Framework Desktop with 16 physical cores and 32 threads, as reported by its owner. Its successful unscaled runs are development evidence only. Neither core-count ratios nor these local timings determine a multiplier for slower devices. Main-thread responsiveness also depends on single-thread performance, rendering, and host scheduling.

## Measurement Protocol

The `CI` workflow accepts the optional `calibrate` boolean on manual dispatch. It retains the complete normal gate and additionally runs three independent samples of each performance shard on fresh standard `ubuntu-latest` runners with Node.js 26. Each sample runs every classified benchmark and all applicable refresh rates, serially within its runner. Diagnostic samples collect all file failures; ordinary required checks retain fail-fast behavior. No sample is retried or excluded from calibration.

Timing assertions retain their original measurement expressions, quantiles, warm-up, sample counts, strict or inclusive comparison, soft-assertion behavior, and reference budgets. The explicit timing helper buffers the measured value, unscaled reference, effective limit, ratio, test identity, and refresh rate. It emits one report after the test file, outside measured operations. Missing or malformed reports fail the run. Correctness, memory, size, and count assertions remain unchanged.

Each shard uploads `metadata.json` and `measurements.json` as a workflow artifact for 30 days. Metadata includes the commit, source tree, lockfile hash, dirty status, Node version, runner image, CPU model, available CPUs, memory, and the selected execution plan. A calibration must use one clean commit and identical dependencies for every sample. Artifact completeness is checked against the full classified plan before deriving limits.

To collect and summarize the artifacts:

```bash
gh workflow run ci.yml --ref <branch> -f calibrate=true
gh run download <run-id> --pattern 'calibration-*' --dir <artifact-root>
node scripts/summarize-performance-calibration.mjs <artifact-root>
```

## Selection Rule

The selection rule is fixed before inspecting hosted measurements:

1. Retain every finite elapsed-time measurement from all three samples, including failed assertions. A failed, incomplete, or inconsistent cohort blocks adoption of a new limit; no failing sample is silently dropped.
2. Divide each measurement by its unchanged unscaled reference budget.
3. Take the greatest observed ratio, add 25 percent headroom, and round upward to the next 0.25 multiplier step, with a minimum of 1.
4. Never increase the existing multiplier of 5 through this calibration. If the rule requires more than 5, investigate the operation or measurement before changing the gate.
5. Validate the selected fixed multiplier in a separate complete normal CI run on fresh runners. A failure is investigated rather than automatically increasing the factor or retrying until green.

The ratio, headroom, and rounding rule was fixed before collecting measurements. The global result governs adoption. After inspecting the measurements, the report also applies the same rule separately to the two pre-existing CI shards for diagnosis. These exploratory per-shard candidates do not change the gate; adopting them would require an explicit policy change and independent validation.

The headroom is an explicit engineering reserve, not a statistical confidence guarantee. Three hosted samples cannot characterize every runner or predict weaker physical-device performance. The factor is a regression threshold for this hosted baseline; it never becomes an automatic runtime adjustment or a device-performance claim. Recalibration requires review and retained evidence.

## Evidence

The [calibration run](https://github.com/boommasterxd/inkbook/actions/runs/34989636630) measured commit `ee23b2ce8bfc5f499ee1715398e1e60b18c30367` on 2026-09-15. All six diagnostic samples and the complete normal gate passed. The separate [initial PR run](https://github.com/boommasterxd/inkbook/actions/runs/34989638152) also passed under the existing factor of 5.

[Retained evidence](../.github/performance/hosted-calibration.json) contains all six runner metadata records and all 1,125 timing values grouped into 375 metric identities. Each shared sample covered 40 file/profile executions; each cadence sample covered 50. The runners reported Ubuntu image `20260907.300.1`, Node `v26.8.2`, AMD EPYC 7763, **2 available logical CPUs**, and approximately 8 GB memory. The CPU model name's 64-core count does not describe the runner's available capacity.

| Shard                          | Greatest measured/reference ratio | Candidate with 25% reserve |
| ------------------------------ | --------------------------------: | -------------------------: |
| Shared                         |                            4.9893 |                       6.25 |
| Cadence (exploratory grouping) |                            2.5493 |                       3.25 |
| Complete cohort                |                            4.9893 |                       6.25 |

The limiting operation was the alternating 5,000-element arrangement benchmark: **59.871437 ms** against an unscaled 12 ms reference and the existing hosted 60 ms limit. It passed with only 0.128563 ms remaining. Consequently the selection rule **blocks adoption**: its required 6.25 exceeds the existing ceiling of 5. The summarizer writes the evidence with `adoptionBlocked: true` and exits unsuccessfully. Factor 5 remains unchanged; it is not certified to provide the intended reserve. The earlier factor had no retained empirical calibration in this repository. No sample was removed or retried, and no threshold was loosened.

A complete local run on the Framework Desktop passed quality checks but failed two unchanged 240 Hz timing limits of 2.291667 ms: rotated stroke scale materialization (`typed=false`) took 2.998797 ms, and full worker request packing took 2.458317 ms. An earlier complete local run passed. This variability is not proof that competing repository checks were the only cause. The local exclusion guard prevents overlapping guarded commands, but cannot isolate unrelated processes or remove runtime and scheduler variability.

The current evidence supports investigation of the arrangement peak and the two local overruns before selecting replacement limits. Neither a lower global hosted factor nor a higher allowance is justified by this cohort. Physical weaker-device performance remains unverified.
