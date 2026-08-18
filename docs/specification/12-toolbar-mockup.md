# Toolbar Mockup

## Purpose

The bundled mockup is a focused design and interaction reference for the only substantial custom plugin UI: the note toolbar, contextual stylebar, plugin-owned SVG elements, backgrounds, and whole-note zoom.

It deliberately does not reproduce an Obsidian application shell or implement persistence.

## Files

- [Interactive mockup](mockup/index.html)
- [Styles](mockup/styles.css)
- [Stylebar controls](mockup/mockup-stylebar.js)
- [Interaction script](mockup/mockup.js)

Open `mockup/index.html` directly in a modern browser. The mockup has no build step, external script, remote font, network request, or dependency.

## Demonstrated Behavior

- primary and secondary annotation tools;
- contextual stylebar opening directly below the toolbar;
- Pen Pressure toggle;
- highlighter, eraser, shape, arrow, selection, and background style controls;
- touch or click selection of plugin-owned SVG objects;
- selected-Table `Rows` and `Columns` controls that redraw the same semantic Table;
- whole-note zoom of Markdown, background, SVG, and selection together;
- Floating and Docked toolbar presentation;
- responsive desktop and compact layouts;
- light and dark Obsidian-like theme tokens;
- accessible pressed, expanded, menu, and focus behavior.

The mockup-only preview controls for theme, viewport, and toolbar presentation are not production toolbar controls. In production, theme and viewport come from Obsidian and toolbar presentation comes from plugin settings.

The static mockup shows the canonical default order within the primary toolbar and More Tools menu. Production users can reorder tools within those fixed groups through Obsidian's normal plugin settings. The mockup does not simulate order persistence, validation, migration, or its accessible settings controls.

## Non-Goals

The mockup does not provide:

- real Obsidian APIs or CodeMirror integration;
- sidecar or YAML persistence;
- actual pointer drawing or geometry editing;
- real anchor reattachment;
- final icons, localization, or performance measurements;
- actual automatic binding inference, source-range resolution, or width-dependent reflow;
- any page, file, image, PDF, web embed, search, export, or Markdown text-box UI.

Production components MUST follow [Toolbar and Stylebar](03-toolbar-and-stylebar.md), [Interaction and Tools](02-interaction-and-tools.md), and the gates in [Quality and Performance](09-quality-and-performance.md).

The production selection stylebar additionally provides the `Text binding` control specified in [Toolbar and Stylebar](03-toolbar-and-stylebar.md). The current static mockup's generic anchor affordance is only a visual placeholder and is not the normative binding model.

The static selection rectangle is also only a visual placeholder. It does not demonstrate production endpoint handles, oriented area frames, Table-divider handles, per-axis length controls, aggregate selection frames, resize geometry, or constant-width behavior. Those contracts are defined in [Interaction and Tools](02-interaction-and-tools.md) and [SVG Rendering](06-svg-rendering.md).
