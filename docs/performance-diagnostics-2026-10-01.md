# Lossless Loading and Saving Diagnostics

## Result and Scope

The first save of the RPTU 10k drawing takes 25.1–41.8% less time in these paired Obsidian observations. Model readiness improves by 13.6–18.2%, but overall input readiness changes much less: 2.2% on desktop, 2.9% on tablet, and effectively unchanged on phone. Subsequent saves change by only 12–19 ms including the fixed debounce. The small opening and subsequent-save differences cannot establish a reliable speedup from one pair per mode.

All original points, pressure values, element fields, and order remain exact. The disk format and original 10,820,603-byte SVG remain unchanged. No lossy point reduction, file migration, or stress-file regeneration is part of this change.

These are user-requested local diagnostics, not timing gates or a permanent measurement mode. The [deterministic performance CI contract](performance-ci.md) remains unchanged. The [previous report](performance-diagnostics-2026-09-30.md) describes the earlier format and pipeline work; its measurements are not the baseline for this comparison.

## Implemented Work Reuse

| Area             | Production behavior                                                                                                                                                                                                                                    | Contract                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Compact decoding | A one-use root and exact-buffer proof reuses numeric validation and extrema. Semantic fields, aggregate capacity, translated coordinates, and integrity checks remain.                                                                                 | [File format](file-format.md)                                                     |
| Sample encoding  | A session-owned cache retains exact validated compact strings and reuses them while current immutable point identities remain unchanged. It is bounded to 32 MiB and 20,000 entries.                                                                   | [Rendering and performance](rendering-and-performance.md)                         |
| Visible contours | The scene requests at most 256 visible IDs and 4 MiB of canonical worker contours per batch. The shared algorithm and worker shape cache also serve export. Stale, cancelled, oversized, or unavailable results retain the progressive local fallback. | [Validated unlock and output reuse](decisions/validated-unlock-geometry-reuse.md) |
| Preview evidence | An owned safe-static proof can replace the repeated presentation scan only after hashing all freshly read bytes and matching the current proof. Metadata, model, limits, and complete-byte integrity validation remain.                                | [Validated unlock and output reuse](decisions/validated-unlock-geometry-reuse.md) |
| UTF-8 fragments  | Cached output bytes replace retained SVG/metadata strings. Warm output assembly copies unchanged fragments without recoding or decoding them; hashing, complete assembly, preflight, write, and readback remain.                                       | [Rendering and performance](rendering-and-performance.md)                         |

The injected central `WorkScheduler` controls all cooperative handoffs. The contour batch limits constrain transport and retention, not CPU admission. The implementation does not adopt paths from the input SVG as canonical editor geometry.

## Setup and Boundaries

- Baseline source: `7d42adc6a075aded9f8179b4f93295c10eb41581`.
- Measured implementation source: `87af112`.
- Baseline production `main.js` SHA-256: `75c216a0104a811efcf37f378417cf8642cf658ed971ee096a0067012d31fb63`.
- Measured production `main.js` SHA-256: `9a2b0a0cca9803f627f04149629af41bf6bb98210e81f68fa75a5da9506da77a`.
- Original drawing: 10,005 strokes and 487,988 points; SVG SHA-256 `f4710171535e433fdd20b379ca6318f870680e3588988b8a1cb1ba6ec5cb39e7`.
- Flatpak Obsidian 1.13.7; AMD Ryzen AI MAX+ 395; local Node.js 26.7.0.
- Isolated X11 framebuffer: 1920 × 1200 × 24; outer window 1664 × 1080; `--disable-gpu --remote-debugging-port=9222`.
- Desktop/tablet viewport: 1656 × 1076; phone: 360 × 800; light theme background `#ffffff`.
- Desktop clears device metrics and removes `EmulateMobile`. Tablet uses Obsidian's own `is-mobile is-tablet` emulation. Phone additionally uses DevTools mobile metrics and asserts `is-mobile is-phone`.
- Each version and mode uses an independent exact copy, page reload, locked-preview activation, one new stroke and first save, another new stroke and subsequent save, and relocking. Main and worker CPU profiles use 1 ms sampling. No CI work runs concurrently with these observations.

Opening starts before the locked-preview click. Model readiness observes `inkbook-active-preparing`, input readiness observes `data-inkbook-state="active"`, and transition settlement observes `inkbook-active-ready`. These endpoints include scheduling, worker transfer, scene preparation, DOM publication, and browser delays.

Save measurement starts after pointer release and ends at the first post-write `Vault.read()` return. It includes the unchanged 1,000 ms autosave debounce and does **not** measure completion of the following readback validation. Both versions perform exactly two observed Vault reads per save, including preflight and readback. Each run waits afterward and successfully relocks.

Profiling, software rendering, filesystem caching, and ordinary process variation affect these one-pair observations. They are not latency guarantees, percentile results, or physical mobile-device measurements. Several changes are measured together; these runs do not isolate the contribution of each optimization. Initial offscreen overscan progresses after visible readiness, so path counts captured later are not a fixed visible population.

## Opening

Milliseconds, baseline → measured implementation.

| Mode    | Locked preview mount | Model ready       | Input ready       | Input wait reduction | Transition settled |
| ------- | -------------------- | ----------------- | ----------------- | -------------------- | ------------------ |
| Desktop | 1,640.3 → 1,628.3    | 1,195.2 → 1,027.1 | 3,894.3 → 3,808.5 | 2.20%                | 4,158.6 → 4,059.5  |
| Tablet  | 1,565.1 → 1,698.9    | 1,162.4 → 1,004.4 | 3,696.1 → 3,588.5 | 2.91%                | 3,938.9 → 3,836.6  |
| Phone   | 1,935.9 → 1,617.8    | 1,236.0 → 1,011.5 | 4,905.9 → 4,901.5 | 0.09%                | 5,169.0 → 5,149.3  |

The model endpoint improves by 168.1, 158.0, and 224.5 ms respectively. The remaining visible preparation and publication interval does not improve in these pairs, so earlier model readiness does not translate into a similar reduction in total opening time. Locked-preview mount varies in both directions, including a 133.8 ms increase on tablet; no consistent preview-mount improvement is established.

## Saving

Milliseconds from commit to observed readback return, including debounce.

| Mode    | First save        | Reduction | Subsequent save   | Reduction | Reads per save |
| ------- | ----------------- | --------- | ----------------- | --------- | -------------- |
| Desktop | 5,389.6 → 3,772.3 | 30.01%    | 1,137.7 → 1,118.9 | 1.65%     | 2 → 2          |
| Tablet  | 5,118.1 → 3,834.5 | 25.08%    | 1,136.2 → 1,119.1 | 1.51%     | 2 → 2          |
| Phone   | 5,142.6 → 2,992.2 | 41.82%    | 1,134.9 → 1,123.3 | 1.02%     | 2 → 2          |

The first-save reduction is 1.28–2.15 seconds in these observations. Subtracting the fixed debounce leaves first-save intervals of 4,389.6 → 2,772.3 ms on desktop, 4,118.1 → 2,834.5 ms on tablet, and 4,142.6 → 1,992.2 ms on phone. These intervals still include scheduling and host I/O; they are not CPU time. First-save results depend on which contours the viewport and background preparation have already cached; these observations do not isolate that dependency.

## Verification and Evidence

Complete `npm run ci` passed: format, lint, styles/layout, architecture, runtime/test/worker typechecks, 4,455 Unit and Integration tests across 494 files, coverage, duplication, both dead-code checks, dependency audit at the required threshold, build, package verification, and all classified performance contracts. Coverage is 91.06% statements, 85.41% branches, 93.08% functions, and 93.87% lines. Performance execution covers 71 invariant files and 16 cadence-sensitive files at each of 60, 90, 120, 144, and 240 Hz, totaling 151 file/profile executions. Four existing moderate development-dependency audit findings remain below the configured high-severity failure threshold.

Deterministic regressions observe decoder point accesses, encoder point accesses, safe-static writes and retained input, contour builds and batch counts, UTF-8 encoder bytes, cache capacity, cancellation, identity mismatch, invalid input, and cleanup. The 10,000-element contour fixture prepares exactly 3,000 visible contours in 12 requests, and an actual 300-element delta reconciliation uses two requests without local contour builds. The 11,000-element warm export fixture encodes less than 16 KiB of new UTF-8 data after one changed element. These are work/resource assertions rather than speed claims.

The three saved diagnostic copies passed strict canonical parsing. Every one of the original 10,005 elements was compared in order, including all 487,988 points, against the unchanged original snapshot; only the two new diagnostic strokes were additional. All three modes retained their baseline root geometry: 700 px width on desktop/tablet and 300 px on phone. Screenshots were visually inspected. Drawing, both saves, and relocking succeeded with no collected main-thread uncaught errors or unhandled rejections; measured implementation workers additionally reported no uncaught exceptions.

The measured production artifacts are installed in both RPTU and QA vaults, with all three artifact hashes matching `dist/`. Original QA app, theme, and workspace configuration was restored; emulation and device metrics were cleared, temporary test files were removed after archiving, and the isolated Obsidian/X11 processes were closed. The original RPTU drawing hash remains unchanged.

Raw summaries, comparison and exact-sample verification results, main/worker `.cpuprofile` files, screenshots, exact production artifacts, and the one-off drivers are retained locally:

```text
/home/ysmelsem/.codex/visualizations/2026/09/30/01a0f3b6-d30c-75a0-ac65-c12a8edfbacf/inkbook-lossless-performance-2026-10-01
```
