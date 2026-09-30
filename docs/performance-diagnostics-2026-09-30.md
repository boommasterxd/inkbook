# Loading, Saving, and Compact Metadata Diagnostics

## Result and Scope

The 10k RPTU drawing opens for input 32.5–34.5% sooner in these paired Obsidian runs. Its complete SVG is 39.49% smaller. Own saves perform two actual Vault reads instead of four, including the mandatory preflight and readback. First-save latency improves less than opening latency: cold preparation remains substantial.

This report covers loading, locked-preview activation, persistence, and disk format. These are one-off local diagnostics requested for this change, not timing gates, statistical acceptance results, or a permanent measurement mode. The deterministic [performance CI contract](performance-ci.md) remains unchanged.

## Implementation

| Area               | Final behavior                                                                                                                                                                                                                 | Contract                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| JSON structure     | A single-use proof from the bounded parser avoids a second generic tree traversal. Semantic schema and range checks remain mandatory.                                                                                          | [File format](file-format.md)                                    |
| Worker adoption    | The validated transport checks identity, order, buffer ownership, aliases, and limits without rescanning validated numeric samples.                                                                                            | [Validated unlock](decisions/validated-unlock-geometry-reuse.md) |
| Bounds             | Worker model construction reuses validated local stroke bounds; offset and rotation cases preserve their coordinate spaces.                                                                                                    | [Rendering and performance](rendering-and-performance.md)        |
| Checkpoints        | An immediately admitted checkpoint returns without a Promise. Pressure preparation groups bounded operations; the central scheduler retains admission, deadlines, cancellation, and input priority.                            | [Central scheduling](decisions/central-work-scheduler.md)        |
| Initial scene      | Input waits for every required visible element, including transition-layout changes. Initial offscreen overscan follows input readiness.                                                                                       | [Rendering and performance](rendering-and-performance.md)        |
| Load pipeline      | One bounded adoption batch overlaps worker suffix inspection. Staging is unpublished until both validation and adoption succeed.                                                                                               | [Validated unlock](decisions/validated-unlock-geometry-reuse.md) |
| Save notifications | Actual verified readback reaches lifecycle and recognition. An early modify event waits only for the current save, then rechecks ownership; external or failed writes retain fresh classification.                             | [Obsidian integration](obsidian-integration.md)                  |
| Save preparation   | Band order copies follow actual order changes. Prepared path hints are collected lazily inside their retention limits and reused on the first save.                                                                            | [Prepared export](decisions/prepared-scene-pressure-export.md)   |
| Disk samples       | All writers and integrity paths use `json-varint-v1`: scaled integer deltas, minimal varints, and strict Base64. Decoding produces the existing `Float64Array` model used by tools, shapes, clipboard, rendering, and history. | [Compact metadata](decisions/compact-stroke-metadata.md)         |

Existing JSON files remain readable; no automatic vault migration was introduced. Stress files were explicitly regenerated as requested.

## Setup and Measurement Boundaries

- Baseline source: `72725e23fbf9c6fa954bc776fdbc9bfee33caa8a`.
- Final measured source: `b56e1ed5eb0fc0474fa56614c06a985b7c3479a6`.
- Baseline production `main.js` SHA-256: `7277805de4f5f110a66598aaac3a36605e67eed88d846095cae237ee4ef35a23`.
- Final production `main.js` SHA-256: `75c216a0104a811efcf37f378417cf8642cf658ed971ee096a0067012d31fb63`.
- Locally installed Flatpak Obsidian 1.13.7; AMD Ryzen AI MAX+ 395, 16 cores / 32 threads; local Node.js 26.7.0.
- Isolated X11 framebuffer: 1920 × 1200 × 24; native window: 1664 × 1080; `--disable-gpu --remote-debugging-port=9222`.
- Desktop and tablet content viewport: 1664 × 1032. Phone viewport: 360 × 800. Light theme background: `#ffffff`.
- Desktop removes `EmulateMobile`; tablet uses Obsidian's mobile emulation with `is-mobile is-tablet`; phone additionally uses DevTools mobile metrics with `is-mobile is-phone`. Classes and viewport were asserted in every run.
- Each mode used an independent copy of the same drawing, the same note body, a page reload, a locked-preview click, one new stroke, a subsequent new stroke, and relocking. Chrome CPU sampling at 1 ms was enabled for main thread and document workers in both versions.
- Opening starts immediately before the click. Model readiness observes `inkbook-active-preparing`; input readiness observes `data-inkbook-state="active"`; transition settlement observes `inkbook-active-ready`.
- Save timing starts after trusted pointer release and ends at the first observed post-write `Vault.read()` return. It includes the unchanged 1,000 ms debounce. It does **not** time completion of the following readback validation. Actual reads and writes were observed at Vault method boundaries. Baseline reads can overlap and were not tagged by call purpose; the driver chooses the first completed read after `Vault.process()` returns. Final runs have exactly one post-write read, the mandatory readback. Each run also waited after readback and successfully relocked.

Both versions ran one measured sequence per mode. Profiling, software rendering, filesystem caching, and ordinary process variation affect these results. Percentage changes below are observations from those pairs, not guaranteed speedups or p95/p99 results. No real Android or iOS hardware was tested.

## Opening Results

Milliseconds, baseline → final; positive reductions mean less waiting.

| Mode    | Locked preview mount | Model ready       | Input ready       | Input wait reduction | Transition settled |
| ------- | -------------------- | ----------------- | ----------------- | -------------------- | ------------------ |
| Desktop | 1,727.9 → 1,636.2    | 2,057.5 → 1,166.6 | 5,371.8 → 3,628.5 | 32.45%               | 5,612.9 → 3,897.5  |
| Tablet  | 1,719.7 → 1,805.6    | 2,082.3 → 1,157.6 | 5,256.9 → 3,480.4 | 33.79%               | 5,498.2 → 3,750.1  |
| Phone   | 2,320.6 → 1,944.2    | 2,141.4 → 1,162.5 | 7,654.3 → 5,014.6 | 34.49%               | 7,895.6 → 5,292.7  |

Model readiness improves by 43.30%, 44.41%, and 45.71%, respectively. Locked-preview mount improves by 5.31% on desktop and 16.22% on phone; tablet mount is 5.00% slower in this pair. A single observation cannot distinguish a small regression from run-to-run variation.

## Save Results

Milliseconds from commit to the first observed post-write read return, including debounce.

| Mode    | First save        | Reduction | Subsequent save   | Reduction | Actual reads per save |
| ------- | ----------------- | --------- | ----------------- | --------- | --------------------- |
| Desktop | 5,488.1 → 5,215.9 | 4.96%     | 1,230.8 → 1,134.5 | 7.82%     | 4 → 2                 |
| Tablet  | 5,487.1 → 5,208.3 | 5.08%     | 1,201.1 → 1,137.0 | 5.34%     | 4 → 2                 |
| Phone   | 5,472.8 → 5,111.7 | 6.60%     | 1,236.7 → 1,133.7 | 8.33%     | 4 → 2                 |

Subtracting the fixed debounce from the same observations gives the following remaining latency. These values still include preparation, scheduling, host I/O, and any unobserved event-loop delay; they are not CPU time.

| Mode    | First save excluding debounce | Reduction | Subsequent save excluding debounce | Reduction |
| ------- | ----------------------------- | --------- | ---------------------------------- | --------- |
| Desktop | 4,488.1 → 4,215.9             | 6.06%     | 230.8 → 134.5                      | 41.72%    |
| Tablet  | 4,487.1 → 4,208.3             | 6.21%     | 201.1 → 137.0                      | 31.87%    |
| Phone   | 4,472.8 → 4,111.7             | 8.07%     | 236.7 → 133.7                      | 43.51%    |

The preliminary real run exposed a third read that previously occurred before asynchronous readback verification finished. The final build fixes that race and the final measurements show two reads in every mode and both save stages. Neither mandatory read was removed.

## Regenerated Stress Files

Exact UTF-8 bytes, without filesystem compression.

| File                | Elements | Stroke points | Original bytes | New bytes  | Reduction | Revision |
| ------------------- | -------- | ------------- | -------------- | ---------- | --------- | -------- |
| `1000-strokes.svg`  | 1,000    | 48,887        | 1,738,568      | 1,077,052  | 38.05%    | 2 → 3    |
| `5000-strokes.svg`  | 5,000    | 243,807       | 8,890,220      | 5,397,689  | 39.29%    | 0 → 1    |
| `10000-strokes.svg` | 10,005   | 487,988       | 17,883,151     | 10,820,603 | 39.49%    | 23 → 24  |

The existing 10k drawing includes five additional strokes; they were preserved. Every regenerated snapshot was compared against its original with only revision normalized, including every point value, element field, and ordering entry. Canonical revalidation succeeded. The 10k metadata payload decreases from 13,440,718 to 6,378,160 bytes, or 52.55%; the standalone SVG presentation remains included.

The three new SVGs are installed in both `/home/ysmelsem/Google Drive/RPTU/Inkbook Performance Tests` and `/home/ysmelsem/.local/share/inkbook-qa/vault/Inkbook Performance Tests`. Corresponding Markdown notes and the test index are present in both vaults. Both vaults use production plugin artifacts with hashes matching the measured `dist/` build. Original RPTU source hashes were rechecked immediately before replacement; backups were retained.

## Verification and Evidence

The final runtime tree passed complete `npm run ci`, including format, zero-warning lint, styles/layout, cycle-free architecture, runtime/test/worker typechecks, Unit and Integration coverage, duplication, both dead-code gates, dependency audit at the required high threshold, build/package verification, and every classified performance file/profile. Coverage: statements 91.10%, branches 85.46%, functions 93.17%, lines 93.90%. Performance execution covered 68 invariant files and 16 cadence-sensitive files at each of 60, 90, 120, 144, and 240 Hz, totaling 148 executions. Four existing moderate development-dependency audit findings remain; the gate reports them and passes its configured threshold.

Focused regressions cover bounded proof reuse, malformed compact samples, all-element roundtrips, buffer ownership and alias rejection, offset bounds, bounded adoption and cancellation, late worker callbacks, visible readiness under layout changes, scheduler admission, lazy hint/order reuse, early own-modify events, rejected save settlement, and external writes during verification. Existing capacity fixtures and direct expensive-boundary observations remain in the exhaustive manifest. Independent implementation and documentation reviews were performed.

All three real Obsidian runs captured screenshots, exercised drawing, both saves, and locking, and reported zero uncaught errors and unhandled rejections. Desktop/tablet roots retained 700 px width; phone retained 300 px width and the same viewport position. Screenshots were visually inspected. Original QA workspace/theme settings and emulation flags were restored, temporary test notes were removed, and the isolated Obsidian/X11 processes were closed.

Raw summaries, main/worker `.cpuprofile` files, screenshots, original/regenerated stress files, the generation report, and the one-off driver are retained locally at:

```text
/home/ysmelsem/.codex/visualizations/2026/09/30/01a0f3b6-d30c-75a0-ac65-c12a8edfbacf/inkbook-performance
```

`baseline-{desktop,tablet,phone}/summary.json` and `verified-{desktop,tablet,phone}/summary.json` contain the actual event timestamps, Vault calls, viewport, platform classes, and errors. `regenerated-stress-files/report.json` contains byte counts, revisions, SHA-256 identities, and exact logical roundtrip results. The one-off scripts retain their original diagnostic paths; adapt those paths when reproducing elsewhere. No latency acceptance claim is inferred from green CI or these emulated mobile runs.
