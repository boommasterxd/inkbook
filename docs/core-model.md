# Core Model

A handwriting area is not a conventional drawing area within the Markdown file. The Markdown only contains an embed that references a separate SVG file in the vault.

This SVG file contains two things:

- a regular, self-contained SVG graphic with deterministic light and dark document palettes
- a versioned embedded snapshot containing strokes, shapes, styles, render-band ordering, endpoint connections, and background settings

This allows Obsidian to display the file as an image even when the editor is not active. When the embed is unlocked, the plugin also loads the embedded ink data and opens the interactive editor.

The patterned writing area has a fixed width of 2,000 page units. A writable but unpatterned margin of 24.3 page units surrounds it on every side, so the total SVG width is exactly 2,048.6 page units. Page height is derived from content bounds, the selected background, and the active or locked writing buffer.

## Related Documentation

- [Editor tools](editor-tools.md)
- [Embed UI](embed-ui.md)
- [File format](file-format.md)
- [Implementation specification](specification.md)
- [Rendering and performance](rendering-and-performance.md)
- [Standalone SVG envelope and theme rendering](svg-envelope.md)
- [Feature behavior](features.md)
- [Obsidian integration](obsidian-integration.md)
