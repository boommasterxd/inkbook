# Performance Verification

## Unified Verification Model

Use direct measurements in running Obsidian to verify speed and resource usage.
The two permanent CI contracts observe work and scheduling at production
boundaries with isolated inputs. Simulated frame deadlines exercise admission
and ordering. Execution speed, browser style, layout, paint, and device input
are measured in the real application.

| Required check                   | Core contract                                                                                                                          | Refresh profiles             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `Performance (shared)`           | Publish all 10,000 strokes from the element store in order, using one spatial query, bounded root writes per frame, and scene cleanup. | 120 Hz                       |
| `Performance (refresh profiles)` | With 10,000 stored elements, publish the latest coalesced pen tip at most once per frame.                                              | 60, 90, 120, 144, and 240 Hz |

The viewport case places all 10,000 strokes inside the tested viewport and counts
up to 384 published SVG roots per frame, including fragment children.
The pen case uses the live input and scene paths and checks the rendered tip
after the next frame. The
[performance manifest](../scripts/performance-test-manifest.mjs) assigns each
discovered contract exactly once. Its runner rejects missing, duplicate, or
unclassified files.

## Direct Runtime Verification

The implementing agent owns the performance check for each change that affects
runtime cost or responsiveness.

1. Reproduce the changed interaction in running Obsidian. Record the fixture,
   artifact, host mode, viewport, device, and refresh profile. Use the
   [10,000-stroke fixture and reference profiles](quality-and-testing.md#performance-acceptance-dataset)
   for large-document costs. For viewport changes, check boundary crossings,
   offscreen reentry, zoom or resize, and affected focus or selection.
2. Capture a baseline with the same setup before optimizing. Use Obsidian
   DevTools or the platform profiler to capture the actual hot path. Choose
   CPU profiles or performance traces for frame, layout, paint, and input
   stalls. Take allocation or heap profiles when retention or memory is
   affected. Use production counters for candidate visits, geometry builds,
   SVG writes, host I/O, queues, or retained buffers as relevant.
3. Identify the costly work in the capture and fix in-scope bottlenecks.
   Preserve the [central scheduler](rendering-and-performance.md#central-work-scheduling),
   complete document behavior, and cancellation and cleanup. Repeat the same
   interaction with the same fixture, host mode, viewport, device, and refresh
   profile. Compare the affected work or timings with the baseline and the
   applicable [product budgets](quality-and-testing.md#performance-budgets).
4. Report the observed effect, the verification setup, and remaining
   instrumentation or physical-device gaps. Keep trace and profile evidence in
   the working context. Follow the
   [native release checks](manual-release-checks.md) for hardware acceptance.

## Local and GitHub Parity

`npm run benchmark` and `npm run test:performance` run both performance contracts
at all assigned profiles. `npm run ci` includes the same checks and the complete
quality gate. `npm test`, the complete quality gate, and hosted quality share the
[validated test runner](../scripts/run-validated-tests.mjs). It compares a fresh
Vitest JSON report against its expected Unit and Integration files and rejects
missing, duplicate, failed, malformed, or unexpectedly skipped results.

The full local commands reject an `INKBOOK_PERFORMANCE_SUITE` value other than
`all` and any defined `INKBOOK_PERFORMANCE_REFRESH_RATE`, including the empty
string. Use `node scripts/run-ci.mjs shared` or `node scripts/run-ci.mjs cadence`
for an active hosted or locally reproduced selection. Follow the
[selection contract](ci-selection.md) for test selection, no-work results, and
the full fallback. Manual dispatches and releases run the complete gate.

Performance batches run serially with isolated test state. The runner limits
a batch to twenty minutes and 32 MiB of combined output. It terminates its
owned process group on POSIX, or the direct child on Windows. Missing results,
unexpected skips, timeouts, and unconfirmed shutdown fail verification.

## Maintaining the Core Contracts

Keep the two permanent contracts focused on these critical outcomes. For a
changed work bound, observe the actual production operation and verify that a
targeted increase would break the assertion where practical. Count publication
and resources directly. Use simulated time for scheduling and retain the five
cadence profiles for the pen case. Avoid elapsed-time thresholds, percentiles,
warmups, or repeated measurement in CI.

## Coverage and Remaining Gaps

These contracts observe the viewport and live-pen boundaries described above.
Other work and resource limits remain product requirements. Verify affected
geometry, caches, workers, and persistence directly using the local procedure.
A CPU profile, trace, or work counter captures only the operation it observes.
Physical-device latency remains governed by the reference-device measurement
protocol even when CI passes.
