# Retained Stroke Shape and Position

## Status

Accepted.

## Problem

Committed translations rewrote every sample, discarded shape identity, and rebuilt pressure contours in the scene and export worker. Undo and redo repeated this work even though the stroke shape was unchanged. Temporary gesture transforms hid the cost only until commit.

## Decision

Represent stroke position with an optional persisted offset while retaining immutable shape-space samples. The world-space pivot moves with the offset. The exact coordinate and compatibility rules belong in [File Format](../file-format.md#freehand-strokes).

Render and export local geometry followed by a translation. Cache keys describe the samples and shape-affecting attributes rather than the complete positioned element. Cache ownership and retention remain bounded. Reusing geometry never means reusing stale world-space selection windows or bounds. Resizing changes shape and may allocate new samples; a translation must not do so.

The worker may reuse existing samples only within the confirmed document model and its session, epoch, and revision. External input still receives complete schema and resource validation. A cache miss or a full synchronization retains the complete validated transfer path.

## Compatibility and Tradeoffs

This is an optional version-1 extension, like the existing optional table-column offsets. Existing documents keep their absent-offset representation. Earlier plugin builds with strict key validation cannot open documents containing offsets. The SVG remains self-contained, but its allowlist must explicitly permit only the emitted bounded translation syntax.

Local-path quantization followed by translation can differ from recomputing and quantizing absolute contours. Shared local geometry and translation keep the editor and saved image aligned; byte equality with the old absolute contour construction is not a compatibility promise.

Point reuse removes sample copies and contour work for retained shapes. Complete metadata assembly, hashing, file writes, cold cache misses, and browser layout remain separate costs. Deterministic work checks establish reuse and resource bounds, not sub-500-ms physical-device latency.

## Verification

Required coverage includes translated and rotated bounds, hit testing and erasing, move/resize combinations, history replay, clipboard round trips, strict SVG validation, stale worker references, cache eviction, and actual geometry-build and point-buffer-copy boundaries. Real Obsidian checks and CPU profiles use the QA vault and the same mixed-length 10,000-stroke fixture; hardware acceptance remains separate.
