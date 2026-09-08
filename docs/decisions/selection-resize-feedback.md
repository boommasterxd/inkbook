# Continuous Selection Resize Feedback

Status: Accepted

## Context

A long freehand path can take several scene frames to rebuild within the input budget. Waiting for each complete path before updating its position makes a mixed selection appear frozen or advance in separate steps. Completing that work synchronously would violate the existing frame budget.

## Decision

Use the existing retained canonical SVG paths for continuous pointer feedback. Track the transformation represented by each completed snapshot and apply only the residual transformation to the latest gesture. Publish replacement geometry and its residual transformation atomically. Keep one path builder and one scene renderer.

The scheduling, root limits, width behavior, cache ownership, and commit/cancel rules are canonical in [Rendering and Performance](../rendering-and-performance.md).

## Consequences

All selected visible paths can follow each input frame without waiting for another element's geometry. No partial path or alternate pressure outline is introduced. Constant-width freehand centerlines are affine invariant and use SVG stroke-width preservation directly. Filled pressure outlines and non-affine shapes use replacement snapshots and the residual transformation. Between pressure snapshots, the retained outline width follows that temporary transform; the next canonical snapshot restores the configured width. Tests must check continuous movement and snapshot handoff, because comparing settled preview and commit geometry alone cannot detect frozen feedback.
