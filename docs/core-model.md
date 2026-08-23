# Core Model

A handwriting area is not a conventional drawing area within the Markdown file. The Markdown only contains an embed that references a separate SVG file in the vault.

This SVG file contains two things:

- a regular, self-contained SVG graphic with deterministic light and dark document palettes
- a versioned embedded snapshot containing strokes, shapes, styles, render-band ordering, endpoint connections, and background settings

The note references this file through the explicit non-image `!inkbook` Markdown contract. Inkbook displays the saved SVG through its own locked preview, while opening the SVG file in an external viewer still produces the complete portable static graphic. When the embed is unlocked, the plugin also loads the embedded ink data and opens the interactive editor.

The patterned writing area has a fixed width of 2,000 page units. A writable but unpatterned margin of 24.3 page units surrounds it on every side, so the total SVG width is exactly 2,048.6 page units. Page height is derived from content bounds, the selected background, and the active or locked writing buffer. With no elements, both states contain at least 2.5 writing lines rounded up to the next complete background step, followed by the bottom margin; this aligned minimum prevents an empty embed from collapsing into a narrow strip.

## Related Documentation

- [Editor tools](editor-tools.md)
- [Embed UI](embed-ui.md)
- [File format](file-format.md)
- [Implementation specification](specification.md)
- [Rendering and performance](rendering-and-performance.md)
- [Standalone SVG envelope and theme rendering](svg-envelope.md)
- [Feature behavior](features.md)
- [Obsidian integration](obsidian-integration.md)
