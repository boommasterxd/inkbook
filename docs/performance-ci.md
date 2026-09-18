# Deterministic Performance CI

## Unified Verification Model

Performance CI checks bounded work, resources, and scheduling. It does not measure execution speed. The removal of elapsed-time comparisons is recorded in [the decision](decisions/deterministic-performance-checks.md).

| Question                               | Evidence                                                                                                                                                                      | Limitation                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Does an operation do unnecessary work? | Observe actual store/index visits, point reads, geometry builds, fragment builds, DOM writes, document reads, and host calls. Assert upper bounds and unchanged-object reuse. | Uninstrumented computation inside the same counted operation can become slower without detection.                         |
| Are resources bounded?                 | Buffer bytes, cache entries/evictions, owned nodes, retained history, queued tasks, and disposal checks.                                                                      | These counters do not cover every JavaScript allocation. The separate isolated-process heap ceiling is runtime-dependent. |
| Does scheduling behave correctly?      | Controlled frame timestamps, deadlines, input activity, cancellation, and checkpoint yields.                                                                                  | Simulated milliseconds describe ordering and deadlines, not CPU speed or physical input latency.                          |
| Does the product meet latency targets? | Physical-device acceptance described in [Quality and Testing](quality-and-testing.md#reference-profiles).                                                                     | A green CI run does not establish p95/p99, throughput, browser layout/paint, or device responsiveness.                    |

There are no wall-clock or CPU benchmarks, baseline commits, paired comparisons, tolerance percentages, timing warnings, or automatic retries. Production clocks and runtime diagnostic telemetry remain part of the application; tests control scheduling inputs where needed. Test-runner duration summaries and operational job timeouts are not speed-regression assertions.

## Execution

`npm run benchmark` runs the complete classified resource/scheduling suite once per declared profile. The command name is retained for compatibility. `npm run ci` includes the same suite plus all quality checks. Local and GitHub checks fail on failed, skipped, missing, or malformed test results and process errors.

The exhaustive [manifest](../scripts/performance-test-manifest.mjs) is the source of truth for file/profile coverage. Every discovered performance test must be classified exactly once. The [runner](../scripts/performance-test-runner.mjs) validates this mapping and builds the execution plan. The shared shard runs all 48 invariant files once at 120 Hz. The refresh-profile shard runs 11 cadence-sensitive files at each of 60, 90, 120, 144, and 240 Hz, totaling 103 file/profile executions across both shards. Large fixtures remain mandatory; repetitions exist only for meaningful transitions, cache saturation, history retention, or sustained input, not statistical sampling.

## Local and GitHub Parity

The full local command executes the union of both hosted shards. A full `npm run ci` rejects shard-only overrides. No change selection or source-identity shortcut omits contracts, so an all-source change runs the same performance plan as any other change.

GitHub uses two standard `ubuntu-latest` performance runners with Node.js 26. Quality uses Node.js 24. Keep the required names `CI`, `Performance (shared)`, `Performance (refresh profiles)`, `gitleaks`, and `Validate PR Title`. The quality job and each performance shard retain twenty-minute safety limits. Timeouts fail; they are not converted into warnings or treated as evidence of a speed regression.

Pull requests and manual dispatches run the complete gate. Post-merge main pushes do not repeat the tested squash tree. Release tags rerun the gate. No historical anchor, reference promotion, reference checkout, timing artifact, or separate measurement mode exists.

For runtime verification, dispatch the complete workflow on the diagnosis branch and record all job durations and total runner minutes. This establishes the observed duration of the full test plan, not a guaranteed upper bound on hosted hardware performance or queueing delay.

## Coverage and Remaining Gaps

| Area                      | Direct work/resource and scheduling evidence                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store, index, history     | Full 10,000-stroke fixture; bounded local candidate visits with unrelated elements; no full-store scans; unchanged records; atomic publication; reverse-map visits; history retention; cancellation; checkpoint yielding.     |
| Geometry and input        | Maximum 4,096-point strokes, retained-tail/chunk limits, bounded coordinate reads, indexed hit/erase/snap work, and no redundant decimal formatting on ordinary coordinates.                                                  |
| Scene and chrome          | Bounded mounts, cache entries/bytes, geometry builds and DOM writes; one frame/update for coalesced input; retained live tail; zero unintended scans; semantic chrome-render suppression; resize frame work limits; disposal. |
| Obsidian and Live Preview | Bounded line/document/cache accesses, unchanged widgets, cache hits without Vault reads, eviction rereads, owned-surface reuse, and controlled input/frame scheduling.                                                        |
| Clipboard and save        | Full 5,000-element/500,000-point clipboard capacity, bounded scalar reads and payload bytes, unique remapped IDs, one save write, bounded guarded reads, and output verification.                                             |
| Serialization and worker  | Lazy pressure-fragment generation, changed-fragment-only rebuilding, order-only reuse, bounded transfer batches and cache bytes, hydration work, cancellation, fallback byte-work limits between yields, and input pauses.    |
| Memory lifecycle          | Existing isolated-process heap plus array-buffer ceiling, explicit owned-buffer/cache/history bounds, and cleanup. Heap readings depend on the runtime and garbage collector; they are not a deterministic allocation count.  |

The resize pipeline checks all eight existing workloads at every refresh profile: at most 64 immediate plus four progressive full-path builds, four progressive path steps, and 1,024 content geometry attribute writes per frame. The write ceiling allows at most 256 preview paths with one canonical path update and three transform updates for feedback, replacement reset, and residual feedback. These are observed production calls and writes, not estimates derived from the test loop. Work inside one path-build or progressive-step call remains outside these counters.

The fallback pipeline aggregates observed UTF-8 decoding, encoding, and SHA-256 input bytes between actual scheduler yields, including the final slice. Repeated passes count again. The six existing migration, clipboard, export, preflight, and read-back operations retain input-pause checks. Their fixture-specific byte ceilings preserve indivisible encoding/finalization stages; the clipboard ceiling admits its complete canonical flush. They do not establish per-element schema-validation bounds or count internal JSON/XML parser traversal.

Counts at a boundary only protect work observed at that boundary. Arithmetic, regular-expression cost, parsing work, or extra allocation inside one call may escape these assertions. Yield counts alone cannot prove the work between yields is bounded; pair them with direct work/size limits where observable. No replacement claim equates deterministic checks with removed latency coverage.

## Adding or Changing Performance Tests

1. Use full representative or documented maximum-capacity fixtures. Preserve adversarial geometry, stale state, cancellation, and ownership cases.
2. Observe the actual expensive boundary through production instrumentation or a narrow test spy/proxy: query iteration, scalar reads, node writes, fragment generation, host reads/writes, buffer sizes, or pending tasks. Counting a test's own loop does not establish a production work bound.
3. Assert a justified upper bound, not merely that some work occurred or the final result is correct. Where complexity depends on unrelated data, compare multiple sizes while holding the relevant working set fixed. Explain unobserved internal work.
4. Use simulated time only for scheduling, debounce, animation progress, input priority, and cancellation. Never substitute fake elapsed milliseconds for a speed measurement. Retain all supported cadence profiles when they change behavior.
5. Exercise meaningful state transitions: initial/reused/evicted cache entries, both directions of a transform, stale/cancelled transactions, and cleanup. Remove warmups and repetitions used only to collect timing distributions.
6. Register each file in the manifest, keep local/hosted coverage identical, and run the affected contracts followed by the full gate. Validate new work limits against the actual implementation; where practical, a targeted extra-work mutation should make the relevant assertion fail.
7. Do not add elapsed-time assertions, percentile helpers, timing reports, baseline comparisons, sleeps to stabilize measurements, per-test speed tolerances, or larger CI timeouts. Report physical speed as unverified by CI.

The accepted policy and its lost speed-regression coverage are recorded in [Deterministic Performance Checks](decisions/deterministic-performance-checks.md). Product latency targets remain in [Quality and Testing](quality-and-testing.md); CI does not execute their timing protocol.
