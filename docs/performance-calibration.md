# Hosted Performance Calibration

## Scope

The unscaled performance budgets in [Quality and Testing](quality-and-testing.md) remain the product targets. Passing tests on a development workstation or hosted runner does not establish rendering latency on the required desktop and mobile reference devices.

The current local development machine is a Framework Desktop with 16 physical cores and 32 threads, as reported by its owner. Its successful unscaled runs are development evidence only. Neither core-count ratios nor these local timings determine a multiplier for slower devices. Main-thread responsiveness also depends on single-thread performance, rendering, and host scheduling.

## Measurement Protocol

The `CI` workflow accepts the optional `calibrate` boolean on manual dispatch. It retains the complete normal gate and additionally runs three independent samples of each performance shard on fresh standard `ubuntu-latest` runners with Node.js 26. Each sample runs every classified benchmark and all applicable refresh rates, serially within its runner. Diagnostic samples collect all file failures; ordinary required checks retain fail-fast behavior. No sample is retried or excluded from calibration.

Timing assertions retain their original measurement expressions, quantiles, warm-up, sample counts, strict or inclusive comparison, soft-assertion behavior, and reference budgets. The explicit timing helper buffers the measured value, unscaled reference, effective limit, ratio, test identity, and refresh rate. It emits one report after the test file, outside measured operations. Missing or malformed reports fail the run. Correctness, memory, size, and count assertions remain unchanged.

Each shard uploads `metadata.json` and `measurements.json` as a workflow artifact for 30 days. Metadata includes the commit, source tree, lockfile hash, dirty status, Node version, runner image, CPU model, available CPUs, memory, and the selected execution plan. A calibration must use one clean commit and identical dependencies for every sample. Artifact completeness is checked against the full classified plan before deriving limits.

## Selection Rule

The selection rule is fixed before inspecting hosted measurements:

1. Use every finite elapsed-time measurement from all three samples, including failed assertions.
2. Divide each measurement by its unchanged unscaled reference budget.
3. Take the greatest observed ratio, add 25 percent headroom, and round upward to the next 0.25 multiplier step, with a minimum of 1.
4. Never increase the existing multiplier of 5 through this calibration. If the rule requires more than 5, investigate the operation or measurement before changing the gate.
5. Validate the selected fixed multiplier in a separate complete normal CI run on fresh runners. A failure is investigated rather than automatically increasing the factor or retrying until green.

The headroom is an explicit engineering reserve, not a statistical confidence guarantee. Three hosted samples cannot characterize every runner or predict weaker physical-device performance. The factor is a regression threshold for this hosted baseline; it never becomes an automatic runtime adjustment or a device-performance claim. Recalibration requires review and retained evidence.

## Evidence

Hosted measurements and the selected multiplier will be recorded here after the calibration run. The earlier factor of 5 had no retained empirical calibration in this repository.
