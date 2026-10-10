# Isolated Scene Document

## Context

The retained decorative SVG scene can contain many long-lived nodes. Host document style invalidations still affect content across a Shadow DOM boundary, so that boundary alone does not isolate the SVG from host style recalculation. The interactive input surface and tool cursor must remain in the parent document to preserve accessibility, host input integration, native scrolling, and the injected window scheduler.

## Decision

Use this same rendering path in desktop, tablet, and phone presentations. Each attached presentation creates one inert, sandboxed `about:blank` iframe inside its existing `.inkbook-scene` shadow host. The child document owns the single retained SVG. Construct SVG elements and fragments with that child document from the beginning, before renderer subcomponents retain node factories or caches. Creating later ink nodes in the parent document would force automatic adoption for every insertion into the child scene. Keep input, cursor, native scrolling, and central scheduling in the parent document.

The normative lifecycle, sandbox, token relay, resize, scheduling, and cleanup contract is in [Imperative Scene Ownership](../rendering-and-performance.md#imperative-scene-ownership).

## Consequences

The host relays only `--interactive-accent`, `--text-normal`, and `--inkbook-scene-foreground-visibility`. Fractional observed dimensions and theme changes flow through the existing central scene frame; surface release disconnects owned listeners and observers and removes the retained SVG, frame, and host. Construction requires an attached frame with an available child document and body; otherwise it cleans up and fails closed before child-document factories are captured.

The design adds a browsing context and may change paint cost. Verify the behavior in Obsidian desktop, tablet, and phone modes; this decision makes no speed claim.
