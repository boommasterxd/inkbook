# Centerline Selection Highlights

Status: Accepted

## Context

Compact pressure paths reduced document complexity, but selected zoom still incurred additional raster work from the shared SVG morphology filter. A prepared vector-union prototype avoided that filter but delayed the highlight and did not improve selected zoom in software-rendered Obsidian diagnostics. Reusing filled ink as an accent tint would alter the appearance of colored handwriting and highlighters.

## Decision

Use thin, screen-sized indicators following geometric centerlines and logical shape contours. Derive selection transform frames from geometric bounds without paint-width expansion. Keep conservative painted bounds for culling, page extent, hit testing, and area selection. Remove the vector-union prototype instead of retaining a second selection renderer.

The visual contract belongs in [Editor Tools](../editor-tools.md#select), and retained geometry ownership belongs in [Rendering and Performance](../rendering-and-performance.md#selection-highlight-geometry). Inkbook implements this independently; no Ink or tldraw source or renderer dependency is adopted.

## Verification

Acceptance requires all-family geometry and width-independence coverage, stable resize anchors and preview/commit agreement, deterministic camera reuse and resource bounds, and real Obsidian selection and zoom checks in desktop, tablet, and phone modes. The failed prototype is motivation, not evidence that this replacement meets physical-device latency targets. Software-rendering diagnostics cannot establish physical touchpad or GPU behavior.
