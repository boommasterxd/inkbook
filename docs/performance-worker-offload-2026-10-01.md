# Loading and Saving Worker Diagnostics

## Result

The final build reduces sampled main-thread JavaScript work in all nine observed mode/stage pairs: opening by 4.7–11.9%, first saves by 10.9–21.5%, and subsequent saves by 9.2–25.9%. Overall elapsed times remain nearly unchanged. These changes establish offloading at the tested production boundaries, not a substantial improvement in how long the user waits. Main non-idle samples do not consistently decrease once unattributed browser/program and garbage-collection samples are included.

All original samples and element fields remain exact. The unchanged source is 10,820,603 bytes. There is no quality trade-off or new file-size reduction.

## Scope

Three lossless changes use the existing session-owned document worker:

- Bind a lifecycle-owned preview-proof candidate to the complete fresh file before unlock. The host no longer hashes that file; the executor retains both the candidate-binding and terminal parser hash passes.
- Perform autosave preflight UTF-8 encoding, exact size checking, hashing, and unknown-content canonical validation in the worker. Main-thread host identity and atomic write conflict checks remain. Exact own readback reuses the serializer's actual byte count without another full size scan.
- Prepare visible constant-width strokes through the same bounded worker path as pressure contours. DOM publication and the progressive local fallback remain under the central scheduler.

The [reuse decision](decisions/validated-unlock-geometry-reuse.md), [performance contract](rendering-and-performance.md), and [vault boundary](obsidian-integration.md#vault-file-and-link-apis) define the runtime behavior. Original points, geometry quality, and disk format are unchanged. This is a user-requested local diagnostic, not a timing gate or permanent measurement mode.

## Setup and Measurement Boundaries

- Baseline source: `dbd823bdb1bb4ed37bd2da5e16c3838c4cfa2fd9`.
- Baseline production `main.js` SHA-256: `9a2b0a0cca9803f627f04149629af41bf6bb98210e81f68fa75a5da9506da77a`.
- Final implementation source: `348c7f5`.
- Final production `main.js` SHA-256: `e10cbf942e2e5b9eed716cab48a02a224fdda314c075a1def7802310fbf115ae`.
- Original RPTU SVG: 10,005 strokes, 487,988 points, 10,820,603 bytes; SHA-256 `f4710171535e433fdd20b379ca6318f870680e3588988b8a1cb1ba6ec5cb39e7`.
- Flatpak Obsidian 1.13.7, dedicated QA vault, isolated 1920 × 1200 × 24 X11 framebuffer, software rendering.
- Matching baseline and implementation viewports: desktop/tablet 1592 × 996; phone 360 × 800. Tablet and phone use Obsidian's actual mobile emulation branches; desktop clears emulation and device metrics.
- Each build/mode uses a fresh exact copy, reload, unlock, drawing and first save, another drawing and subsequent save, and relocking. No CI workload runs during profiling.

Opening starts before the locked-preview click. Model readiness observes `inkbook-active-preparing`, input readiness observes `data-inkbook-state="active"`, and settlement observes `inkbook-active-ready`.

Save time starts at the committed pointer release and ends when the worker prewarm control is synchronously dispatched after successful persistence confirmation. This includes actual readback verification and the unchanged 1,000 ms autosave debounce. Both versions use two observed Vault reads per save. The [earlier lossless report](performance-diagnostics-2026-10-01.md) ended at `Vault.read()` return and used different baseline runs; its values are not directly comparable.

Main and worker profiles sample nominally every 1 ms. Main JavaScript samples exclude idle, garbage collection, and unattributed `(program)` samples. Main non-idle samples include the latter two categories and therefore cannot be described as pure JavaScript time or operating-system CPU accounting. Profile windows additionally include instrumentation, drawing, and browser work. Worker windows are independent and are not added to main-thread samples.

One observation per build, mode, and stage does not establish a percentile, latency guarantee, or statistically reliable small speedup. Software rendering, profiling, scheduling, garbage collection, and file caching affect these values. Emulation does not replace physical mobile-device verification.

## Intermediate Regression

The first offload build, `6812b12`, moved confirmed-base hashing from the previous bounded native WebCrypto path to JavaScript SHA in the worker. Across the three paired runs, first-save confirmation became 42.5–78.3 ms slower and subsequent-save confirmation became 49.7–77.3 ms slower, although main-thread JavaScript samples decreased. This unnecessary algorithm change was corrected by reusing the existing bounded native hash helper inside worker preflight. Encoding, exact size checks, and fallback still use the injected central scheduler. Native inputs remain capped at 20 MiB; larger, unavailable, or failed native operations retain bounded streaming SHA. Unlock keeps its existing sliced hash path.

The intermediate profiles and saved copies remain archived separately. The following final measurements use the corrected build.

## Final Paired Observations

Milliseconds, baseline → final. Opening ends at transition settlement; saves end at full persistence confirmation and include the fixed debounce.

| Mode    | Opening           | First save        | Subsequent save   |
| ------- | ----------------- | ----------------- | ----------------- |
| Desktop | 3,968.3 → 3,996.0 | 3,799.4 → 3,788.3 | 1,129.6 → 1,134.4 |
| Tablet  | 3,719.1 → 3,709.2 | 3,918.0 → 3,883.8 | 1,129.4 → 1,134.6 |
| Phone   | 5,643.9 → 5,741.4 | 2,732.5 → 2,780.7 | 1,125.5 → 1,132.2 |

The largest elapsed increase is 97.5 ms for phone opening; the largest reduction is 34.2 ms for the tablet first save. Subsequent saves differ by only +4.8–6.7 ms. These single pairs cannot reliably distinguish small improvements or regressions from observation variance.

Input readiness is 3,712.5 → 3,741.3 ms on desktop, 3,477.6 → 3,466.5 ms on tablet, and 5,355.2 → 5,451.5 ms on phone. Model readiness differs by only −6.7, −10.6, and +14.7 ms respectively. The unchanged initial locked-preview mount also varies in both directions: 1,590.0 → 1,907.5 ms on desktop, 1,579.0 → 1,646.3 ms on tablet, and 1,938.2 → 1,673.1 ms on phone. No consistent improvement in that unchanged path is established.

Sampled main-thread JavaScript milliseconds, excluding idle, program, and GC:

| Mode    | Opening       | First save    | Subsequent save |
| ------- | ------------- | ------------- | --------------- |
| Desktop | 746.0 → 657.5 | 260.1 → 212.6 | 118.1 → 88.6    |
| Tablet  | 703.0 → 629.4 | 265.8 → 208.7 | 119.3 → 108.4   |
| Phone   | 991.5 → 945.2 | 371.0 → 330.6 | 128.9 → 95.6    |

Sampled main-thread non-idle milliseconds, including program and GC:

| Mode    | Opening           | First save    | Subsequent save |
| ------- | ----------------- | ------------- | --------------- |
| Desktop | 1,427.2 → 1,442.0 | 422.0 → 392.6 | 224.5 → 230.9   |
| Tablet  | 1,346.2 → 1,316.5 | 431.2 → 416.0 | 236.7 → 281.4   |
| Phone   | 1,851.9 → 1,868.7 | 654.5 → 576.5 | 272.7 → 273.6   |

The distinction matters: offloaded JavaScript cannot by itself eliminate DOM publication, layout, native browser work, or all garbage collection. The initial locked-preview inspection is unchanged. The authoritative Store manifest is still independently checked on Main. A larger preview offload needs explicit worker lifecycle and priority ownership before session activation; moving the Store check needs an independent authoritative data path that does not simply verify the export worker against itself. Neither larger change is included here.

## Automated Verification

Complete `npm run ci` passed: format, lint, styles/layout, architecture, runtime/test/worker typechecks, 4,505 Unit and Integration tests in 496 files, coverage, zero duplication, production and general dead-code checks, audit at the required threshold, production build, package verification, and all 151 classified performance file/profile executions. Coverage is 91.07% statements, 85.46% branches, 93.04% functions, and 93.87% lines. Four existing moderate development-dependency audit findings remain below the configured high-severity failure threshold.

Deterministic work checks observe no main-thread full-file encoding, hashing, or safe-SVG scan in the confirmed-base preflight boundary, one exact worker-native digest within its capacity, and bounded streaming fallback above it. Unlock proof binding observes both complete hash passes in the executor and none in the host. A maximum-point constant-width stroke uses the real bridge adapter with no main-thread point reads or local geometry builds on worker mount. Tests preserve size/identity checks, external conflicts, stale reads without unnecessary worker replacement, cancellation, Unicode, fallback, contour versions, offset/paint parity, bounded batching, reuse, and cleanup. The independent authoritative Store-to-export manifest check remains on Main.

## Obsidian Verification

All three final saved diagnostic copies passed strict canonical validation. Every original element was compared in order and all 487,988 original points remained exact; each copy contained only two additional diagnostic strokes. Screenshots were visually inspected. Unlock, drawing, both saves, and relocking completed with no collected uncaught exceptions, unhandled rejections, or worker errors. Baseline and final viewport, canvas geometry, and observed path populations matched per mode.

Worker target inspection after relocking confirmed that the active Inkbook worker disappeared. The two idle workers present in baseline and final profiles belonged to Obsidian metadata caching and word counting, not additional Inkbook document sessions.

Original QA configuration, plugin settings, and local storage were restored and checked for exact equality. Device metrics were cleared, owned temporary notes/files were removed after archiving, and the isolated Obsidian/X11 processes were closed. After restoration, the final production `main.js`, `manifest.json`, and `styles.css` were installed in both QA and RPTU; all artifact hashes match `dist/`. The original RPTU drawing hash is unchanged.

## Evidence Location

Exact production builds, summaries, comparisons, CPU profiles, screenshots, saved diagnostic copies, exact-sample verification, and the complete local gate log are retained locally:

```text
/home/ysmelsem/.codex/visualizations/2026/09/30/01a0f3b6-d30c-75a0-ac65-c12a8edfbacf/inkbook-worker-offload-2026-10-01
```
