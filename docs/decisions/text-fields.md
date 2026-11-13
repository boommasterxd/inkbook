# Portable Text Fields

## Decision

Text is an ordinary domain element with retained Markdown source, source-range formatting, paragraph alignment, and a validated portable layout. The existing Store, spatial index, commands, history, worker, and serialization flow own it. Browser measurement and CodeMirror stay outside the domain and document worker; React does not render text elements.

Saved text uses native SVG text/tspan markup, normalized math paths, and whole used font faces. Version 2 distinguishes this extension from path-only version 1. Layout runs bind actual binary face IDs through immutable CSS aliases, separately from editable logical family grouping, so regrouping or later face imports cannot alter previously prepared text. Font bytes occur once in a data-only stylesheet; metadata descriptors carry content-hash IDs and reconstruct runtime resources only after validated face matching and binary hash verification. This avoids storing the same font payload in both editable metadata and CSS while retaining a consistency binding.

A single runtime `foreignObject` remains inside the retained text group, preserving element and camera transforms without a separate editing layer. Its lifecycle-owned, sandboxed `about:blank` input frame gives CodeMirror local coordinates without the outer field rotation. CodeMirror's public [measurement contract](https://codemirror.net/docs/ref/#view.EditorView.scaleX) supports translation and scaling, but not rotation. The input frame covers only the existing visible clip; translating the source container inside it preserves native editor windowing and Obsidian as the sole vertical scroll owner. The existing font, theme, palette, input, and coordinate pipelines supply this document; no duplicate editor, renderer, or scheduler is introduced. Portable inner padding separates input and caret from the visible selection frame. Disposal releases the input document, assets, and event ownership; static previews, saved files, and PDF preparation remain free of `foreignObject` and runtime frames.

## Consequences and Boundaries

- Full local font faces preserve standalone rendering without a network or source-vault dependency; they increase file size and remain subject to existing file limits and explicit font caps.
- Range offsets retain editable source semantics. Portable layout remains a derived presentation artifact that must be recomputed after relevant source, width, font, or style changes.
- Version 0/1 loading remains available. Version 2 requires an updated reader on every editing device; no-text canonical exports remain version 1.
- Existing central scheduling, cancellation, culling, atomic publication, and bounded session ownership apply to text work.
- Active editing adds one clipped browsing context and document-local font definitions. They reuse the canonical resources and remain runtime-only; their browser memory and paint cost require native acceptance evidence.
- Deterministic tests establish observed work and correctness. Manual native-host, external-viewer, accessibility, and physical-device acceptance remain separate evidence.

The maintained behavioral, capacity, and format contract is [Text Fields](../text-fields.md).
