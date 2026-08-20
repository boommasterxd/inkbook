# Product Scope

## 1. Product Statement

Inkbook is an Obsidian plugin for handwriting and spatial vector annotation directly over ordinary Markdown notes. The plugin behaves like a transparent drawing layer integrated with each Markdown view, not like an embedded canvas, separate note type, or standalone editor.

Markdown is always authored through Obsidian. Inkbook owns only its overlay elements and their relationship to Markdown layout.

## 2. Core User Capabilities

Users MUST be able to:

1. open an ordinary Markdown note and immediately use native Obsidian text editing;
2. activate an annotation tool from a compact toolbar at the top of the note, with an independent always-visible note-header toggle that shows or hides the toolbar without detaching its view-local host;
3. draw with pen and highlighter using mouse or stylus, while finger touch remains reserved for annotation selection, native two-axis scrolling of a zoomed note, and whole-note pinch zoom;
4. erase, select, lasso, move, regroup, restyle, copy, cut, paste, duplicate, reorder, and delete plugin-owned elements, resize or rotate them where their binding-specific selection model exposes those geometry controls, and move a selection beyond the visible top or bottom through bounded vertical edge autoscroll;
5. create rectangles, ellipses, triangles, diamonds, octagons, free or object-attached lines and arrows, 2D or 3D coordinate systems through one Coordinate system tool, and tables directly over Obsidian's native text editor;
6. configure line width, stroke or outline opacity, fill color, fill opacity, dash pattern, endpoints, curvature, pressure, and applicable tool-specific options through a contextual stylebar;
7. have the plugin infer whether each completed element follows a text range, one text position, or a fixed note position from its geometry and current relationship to rendered text;
8. inspect and correct the inferred binding without switching to a separate drawing tool;
9. manually move a text-bound element and have its binding recomputed at the destination;
10. zoom the entire note, including Markdown and SVG annotations, as one visual surface and pan every available horizontal or vertical range through native one-finger touch scrolling or the secondary-button pointer shortcut;
11. scroll far enough below the native Markdown content to reach every annotation and continue drawing, with the same effective trailing allowance that the current Obsidian view provides after native content;
12. use optional ruled, squared, or dotted note backgrounds whose vertical rhythm follows the current Obsidian body line height and whose horizontal density scales with the same measured text rhythm;
13. undo and redo annotation operations through the same ordered host-editor history as Markdown changes in the originating editable pane, without a separate annotation-only shortcut history;
14. choose whether new sidecars are stored beside each note or below one validated Vault-relative folder, and use the same annotated note on desktop and Android when the selected Vault synchronization configuration transfers the Markdown file and its `.inkbook.json` sidecar.

Resize is geometric, not stylistic. At a fixed whole-note zoom, resizing a bounded shape or Table changes its occupied area and canonical geometry while preserving every outline, border, divider, guide, and axis line width in note units. Line-like elements are edited through their endpoints rather than an area-resize box. Each coordinate-system axis has its own constrained length control, so its length can change without changing the shared origin, axis direction, or angle to the other axes. Whole-note zoom still scales Markdown and the complete annotation presentation together.

One annotated note MUST remain fully interactive with at least 5,000 valid canonical annotation elements on every supported release device. The standard release stress workload contains 10,000 elements. Parser abuse ceilings above those tiers are validation limits, not interactive-capacity claims.

### 2.1 Automatic Text Binding

Drawing tools determine canonical geometry and visual style only. Text binding is an independent property of the completed element. Inkbook MUST NOT add separate underline, text-highlight, or text-enclosure tools.

After a drawing or construction gesture completes, the plugin MUST classify the element against the immutable Markdown and layout snapshot captured for that gesture. Classification uses the element type and geometry together with bounded text candidates, text overlap, distance, baseline alignment, and enclosed text coverage. Tool identity or visual straightness alone MUST NOT classify an element as a text decoration.

The classifier produces exactly one user-visible binding state:

- `Text range`: follows a stable source interval and derives current line fragments or one enclosing region;
- `Text position`: follows one stable source boundary while preserving rigid element geometry;
- `Fixed`: remains in canonical note coordinates and does not follow Markdown text.

A highlighter over text can receive a range binding, a line close to and aligned with a text baseline can receive an underline presentation, and a closed shape confidently enclosing text can receive a region presentation. A generic freehand drawing beside text remains rigid and follows only one text position. A low-confidence candidate MUST fall back to `Text position` or `Fixed`; it MUST NOT silently claim a semantic highlight, underline, or enclosure.

The inferred state is visible when the element is selected, correctable through the contextual stylebar, persisted in the sidecar, and reversible as one annotation operation. A manual correction remains authoritative until the user explicitly requests another binding change or moves the element to a new destination. Reflow changes only view-local projection. It MUST NOT rewrite canonical stroke samples or shape geometry.

A range-bound enclosure may span multiple paragraphs. Its stable source interval and captured margins follow those paragraphs through reflow. A captured circle MAY render as an ellipse when a different aspect ratio is necessary to continue enclosing the same text range.

### 2.2 Construction Objects

Tables, 2D axes, and 3D axes are plugin-owned vector construction elements with finite semantic geometry in unzoomed note coordinates. A table is one selectable element whose cells are derived subdivisions, not independent annotation objects. A 2D or 3D axes object is likewise one selectable element. These objects support the same selection, transform, style, binding, clipboard, persistence, and undo contracts as other construction elements.

Tables use one oriented rectangular selection box for whole-table move, resize, and rotation. Every internal row or column divider also has a constrained drag control. Dividers remain ordered inside the outer frame, so editing them changes adjacent cell dimensions without splitting the Table into separate objects. Axes use one independent line-like length control per axis and no common area-resize box. All construction transforms preserve stored line style.

Tables and axes MUST NOT provide Markdown editing, cell text editing, labels, plugin-owned text boxes, a camera, or a separate 3D scene. A 3D axes object is a two-dimensional projection expressed by three finite note-space axis vectors.

### 2.3 Attached Lines and Arrows

A Line or Arrow is one linear annotation whose start endpoint, end endpoint, or both may snap to stable ports on attachable plugin-owned objects. An attached endpoint continues to resolve against its target when that target moves, resizes, rotates, or reflows. One or both endpoints may instead remain free note points. Attachment does not create a separate element kind, tool, or Group relationship. Detach and reconnect are reversible endpoint operations.

## 3. Native Obsidian Responsibilities

Inkbook MUST NOT replace or duplicate:

- Markdown text input, selection, formatting, folding, source editing, or reading-mode rendering;
- the software keyboard or platform input method editor;
- YAML Properties UI;
- KaTeX or Mermaid rendering;
- internal links, backlinks, graph features, file navigation, command palette, or hotkey management;
- find, search, workspace, vault, or recent-file features;
- Obsidian themes, locale selection, window chrome, file operations, synchronization, or export.

The Cursor tool is the native text-interaction mode. There is no separate Text tool and no plugin-owned Markdown text box.

Cursor also selects plugin-owned annotations. A primary click or stylus tap whose frozen hit target is an annotation or explicit annotation handle selects that plugin target, while an unclaimed event over native Markdown remains fully owned by Obsidian for caret placement, text selection, editing, IME, and software-keyboard input. Users do not switch tools merely to alternate between Markdown editing and annotation selection.

## 4. Explicitly Excluded Capabilities

The following capabilities are outside the plugin and MUST NOT appear in the toolbar, sidecar schema, settings, or implementation roadmap:

- finite pages and page sizes such as A3, A4, A5, or Letter;
- page creation, deletion, reset, rotation, or reordering;
- a custom `.inkbook` document format;
- image objects, PDF objects, web embeds, external asset fetching, or attachment management;
- custom Markdown, YAML, KaTeX, Mermaid, or callout renderers;
- plugin-defined search of any scope;
- standalone application screens such as Start, Recent Files, Export, or custom Settings screens;
- document-level fonts, themes, accents, or locales that compete with Obsidian.

## 5. Supported Obsidian Surfaces

### 5.1 Live Preview and Source Editing

The plugin MUST render the overlay above the active Markdown editor without replacing CodeMirror. Native text interaction remains available whenever the Cursor tool is active or an event is not claimed by a plugin element or active drawing gesture.

### 5.2 Reading View

Reading View MUST render the same annotation scene against the rendered note. Text and annotation editing are read-only in V1 because Obsidian owns the rendered mode and no stable whole-note editing host is assumed. Every toolbar, stylebar, handle, context-menu, clipboard, hotkey, and command entry point revalidates the current view mode immediately before dispatch. Mutation controls are disabled or omitted with an accessible read-only explanation. No Reading View interaction may publish an annotation operation, mutate Markdown, append history, or enqueue sidecar work. The restriction MUST be visible and the overlay MUST never silently diverge from Live Preview.

### 5.3 Multiple Panes

Two panes showing the same note MUST share one canonical annotation session. Each pane MAY have its own viewport, zoom, toolbar state, and selection, but operations and save acknowledgements MUST be serialized through the shared note session. Because Obsidian exposes pane-local editor histories, exactly one concrete editable pane owns the annotation-history lease for that note-session epoch. Other panes remain live annotation projections and retain native Markdown editing, but annotation mutation is visibly read-only until the owner view is disposed and a new epoch is admitted. The plugin MUST NOT pretend that independent pane histories form one safe annotation order.

### 5.4 Host Surface Exclusions

Inkbook augments only native Markdown Live Preview, Source, and Reading View. It MUST NOT register a custom `ItemView`, annotation leaf, replacement Markdown editor, Bases view, Ribbon action, or persistent Obsidian status-bar item. Bases files and non-Markdown views receive no Inkbook toolbar, overlay, sidecar discovery, or YAML marker. View-scoped accessible status output remains part of the Markdown overlay UI.

## 6. Platform Support

The supported platforms are desktop Obsidian and Android Obsidian on phones and tablets. Release claims and compatibility evidence MUST NOT imply support for an untested platform.

The plugin manifest MUST use `isDesktopOnly: false`. Production code MUST not depend on Electron, Node.js file-system APIs, hard-coded `.obsidian` paths, desktop-only pointer assumptions, hover-only controls, or a physical keyboard.

The plugin MUST document that a synchronization provider or file filter which excludes `.inkbook.json` cannot synchronize annotations. The YAML locator makes an annotated note self-describing when devices use different default storage settings, but it does not make an excluded sidecar available. A missing sidecar on another device is handled as the explicit drift state in [Sidecar Persistence](07-sidecar-persistence.md), never as an empty annotation scene.

The interaction model MUST support:

- mouse and keyboard on desktop;
- stylus pressure and barrel button when the platform exposes them;
- touch selection of plugin-owned elements;
- native one-finger scrolling on unclaimed note areas and plugin whole-note zoom through a two-finger pinch;
- the platform software keyboard for native Markdown text entry.

The exact Obsidian package, lifecycle, workspace, editor, user-interface, Vault, Android, and release boundaries are defined in [Obsidian Host Contract](14-obsidian-host-contract.md).

## 7. Product Acceptance Boundary

The plugin is not complete merely because an SVG is visible. Completion requires deterministic persistence, anchor reattachment, Android-safe input routing, bounded rendering, accessible toolbar and stylebar operation, fault handling, and all gates in [Testing and Acceptance](10-testing-and-acceptance.md).
