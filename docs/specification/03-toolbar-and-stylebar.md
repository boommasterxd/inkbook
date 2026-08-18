# Toolbar and Stylebar

## 1. Surface Model

Inkbook adds one annotation toolbar near the top of each Markdown note. The toolbar belongs to the note view and MUST NOT imitate an application title bar, file toolbar, or page manager.

The contextual stylebar opens directly below the toolbar. It is part of the same visual component family and reuses the previous Inkbook mockup's pill geometry, control rhythm, selection indicator, compact horizontal scrolling, and theme-token strategy.

Both surfaces mount only inside native Markdown views and share the lifecycle owner of that concrete view. Inkbook adds no Ribbon action, persistent Obsidian status-bar item, custom workspace view, or Bases surface in V1.

## 2. Toolbar Contents

The toolbar renders utility controls in fixed positions and annotation tools in the configured order from `ToolbarOrderV1`:

1. host-history Undo and Redo for the originating editable pane;
2. the configured primary annotation-tool group;
3. More Tools, containing the configured secondary annotation-tool group;
4. Background;
5. whole-note Zoom Out, zoom percentage, and Zoom In;
6. a Settings launcher using one guarded host-settings adapter. When a tested host capability can open Inkbook's registered tab, the adapter MAY use it. Otherwise the control shows an accessible host-native instruction for navigating to Inkbook in Settings and MUST NOT access untyped global settings internals.

The canonical default membership and order of the two annotation-tool groups are defined in [Interaction and Tools](02-interaction-and-tools.md). Obsidian's normal plugin settings allow reordering within each fixed group. Utility controls are never included in that order setting.

The toolbar MUST NOT contain file rename, save, export, page, image, search, Markdown text, window, or document-title controls.

Cursor is both annotation selection mode and native Obsidian text-interaction mode. A separate Text tool is forbidden.

## 3. Stylebar Visibility

The stylebar MUST appear when:

- a drawing or construction tool is active;
- one or more plugin-owned elements are selected;
- a Background control is active.

The stylebar SHOULD close when Cursor is active with no selection and no open Background control. Reopening the same tool MUST preserve its current preset for the session.

Selection styles override active-tool defaults. Mixed selections MUST show an explicit mixed state instead of guessing the first element's value. A style change over a multi-selection MUST produce one reversible operation.

In Reading View, tool and selection stylebars are presentation-only or absent. Every mutation control is disabled or omitted with a visible accessible explanation, and a mode change is revalidated immediately before any command dispatch.

## 4. Stylebar Panels

### 4.1 Pen

- color;
- width;
- opacity;
- Pressure on or off;
- advanced smoothing, streamline, and thinning controls.

Pressure is visible in the Pen stylebar and snapshotted when a stroke starts. Changing it during a stroke affects only the next stroke.

### 4.2 Highlighter

- color;
- width;
- opacity;
- freehand or straight-line variant.

The highlighter is constant-width. It has no pressure toggle.

Freehand and straight-line variants change geometry only. They MUST NOT select or imply a binding mode. Line highlighter is only an input shortcut for the same straight Highlighter geometry and MUST NOT survive as tool-origin metadata. Equivalent Highlighter geometry, style, Markdown, and layout evidence MUST produce the same binding regardless of which Highlighter control initiated the gesture.

### 4.3 Eraser

- radius;
- whole-element mode;
- optional future split-stroke mode only when supported by the persistence and undo contracts.

### 4.4 Shapes

- outline color;
- outline width;
- opacity;
- solid, dashed, or dotted outline;
- fill color or no fill.

Resize changes shape geometry but not outline width, dash pattern, opacity, color, or fill style. The line-width control is the only stylebar control that changes the stored outline width.

### 4.5 Lines, Arrows, and Connectors

- line color, width, opacity, and dash pattern;
- start cap and end cap independently chosen from none, arrow, dot, circle, diamond, or bar;
- curve amount or straight mode for Line and Arrow;
- connector attachment status where applicable.

A selected Line or Arrow exposes the same center curve-handle interaction. The stylebar's curve control and the on-canvas handle edit the same optional canonical quadratic control point and therefore share one preview, validation, commit, and undo contract.

Connector is straight in V1. Its selection stylebar exposes start and end attachment state and Reconnect or Detach where applicable, but no curve control.

### 4.6 Axes and Tables

- line color, width, opacity, and dash pattern;
- one positive-end cap applied consistently to every axis;
- `Dimensions`, 2D or 3D, while the Coordinate system tool is active;
- table row and column counts from 1 through 200;
- axis grid density from 0 through 64 subdivisions.

While the Table tool is active without a selected Table, `Rows` and `Columns` edit the creation defaults for the next Table. When an existing Table is selected, `Rows` and `Columns` remain directly available as labelled numeric steppers or equivalent bounded integer controls, display that object's current counts, and update that selected Table immediately. Selected-object edits do not overwrite the creation defaults. Coordinate system is one toolbar tool. While it is active with no selected axes object, `Dimensions` is a labelled 2D/3D segmented choice and determines the next object's canonical geometry. A selected axes object shows its stored dimension as read-only state; V1 does not silently add, remove, or reinterpret axes after creation. Table cells are derived from ordered canonical divider offsets and have no independent element identity or style. Changing one count redistributes only that dimension into equal tracks and preserves the divider offsets of the other dimension; later divider dragging may make tracks unequal. Values outside their bounded ranges are rejected before canonical mutation. Every accepted count, divider, axis-length, density, or style change is one reversible operation.

Whole-Table resize changes the outer frame and proportionally scales its divider offsets. Individual divider controls change only adjacent track sizes. Per-axis length controls change only the selected positive length along its existing direction. Table border and divider widths, axes and guide widths, dash pattern, opacity, color, and positive-end cap size remain unchanged. The line-width control is the only stylebar control that changes those stored widths.

These objects do not contain a plugin-owned text editor, cell editor, label, or separate 3D scene.

### 4.7 Selection

The selection stylebar exposes only properties common to the complete selection. It MAY additionally expose group, ungroup, z-order, duplicate, text binding, and delete actions when they are safe and applicable. Its controls use the `linear`, `area`, `axis-set`, or `aggregate` selection model owned by [Interaction and Tools](02-interaction-and-tools.md); it MUST NOT invent a generic bounding-box behavior.

For a single selected element, the stylebar MUST expose one `Text binding` control with exactly these values:

- `Text range`;
- `Text position`;
- `Fixed`.

The control shows the current inferred or manually selected binding. It changes binding only and MUST NOT replace the element type, drawing tool, canonical geometry, or style. `Fixed` detaches the element at its current visible note position. `Text position` and `Text range` use the latest valid candidate retained from inference; an unavailable value is disabled with an accessible explanation instead of guessing a target. For every `text-range` element whose visible geometry is derived from range fragments or an enclosure envelope, the control also explains that geometry resize and rotation require changing the binding to `Text position` or `Fixed` first.

For a mixed selection, the control shows `Mixed`. Applying one available value to multiple elements performs independent target validation and either commits the complete selection as one reversible operation or changes nothing.

The control uses a labelled radio group or an equivalent single-choice pattern with selected-state exposure, roving keyboard focus, Arrow-key navigation, visible focus, and direct activation. Correction MUST NOT require a modifier key, drag gesture, or gesture chord. Each option retains a minimum 44 by 44 CSS-pixel target in compact layouts.

After automatic inference, the existing non-modal status surface announces `Text range binding inferred`, `Text position binding inferred`, or `Fixed binding inferred` without stealing focus. Color alone MUST NOT convey the binding state.

### 4.8 Background

- none, ruled, squared, or dotted;
- compact, standard, or wide horizontal spacing;
- low, medium, or high contrast within accessible limits;
- reset to the plugin default.

Vertical background spacing is derived from the measured Obsidian body line height and is never an arbitrary stored pixel value.

The compact, standard, and wide presets control horizontal spacing for squared and dotted backgrounds. Ruled backgrounds contain horizontal lines only, so they retain but do not render the horizontal preset. The exact font-relative periods, baseline phase, line width, and dot diameter are defined in [Anchors and Layout](05-anchors-and-layout.md).

## 5. Floating and Docked Presentation

The toolbar MUST support:

- `floating`: a rounded surface with bounded shadow and inline margins;
- `docked`: a full-width note surface attached to the note header area without floating shadow.

The contextual stylebar follows the same presentation. The choice is a device-local preference because desktop and mobile layouts differ.

Changing presentation MUST not alter the sidecar, note Markdown, current tool, selection, undo history, or per-note background.

## 6. Responsive Behavior

At narrow widths the toolbar and stylebar remain desktop-class Obsidian plugin UI adapted to a phone. They do not become a separate mobile product.

- Controls keep 44 by 44 CSS-pixel touch targets.
- The primary tool row MAY scroll horizontally.
- Less frequent tools remain inside More Tools.
- The configured order within each group remains unchanged at every width.
- The stylebar MAY become a horizontal scroller or a bottom sheet, but every option remains reachable without hover.
- The `Text binding` control remains directly reachable when an element is selected.
- Tooltips never carry essential information.
- No fixed breakpoint may be exposed as a user setting.

## 7. Theming and Accessibility

The implementation MUST use Obsidian theme variables, including `--background-primary`, `--background-secondary`, `--background-modifier-hover`, `--text-normal`, `--text-muted`, `--interactive-accent`, and `--text-error`, with bounded component-level fallbacks. Normal text requires a contrast ratio of at least 4.5:1. Large text requires at least 3:1, where large means at least 18 point or at least 14 point bold. Interactive component boundaries, visible focus indicators, selected-state indicators, and essential graphical objects require at least 3:1 against adjacent colors. Decorative note-background rhythms are excluded from the essential-graphics threshold but MUST NOT reduce text contrast below its applicable limit.

Tool state MUST be conveyed by shape, position, icon treatment, and accessible state, not color alone. The toolbar uses `role="toolbar"`; popup controls expose menu, listbox, or dialog semantics as applicable. Escape closes transient UI and restores focus.

Production classes are namespaced beneath one Inkbook root and use logical CSS properties. The surfaces follow Obsidian's right-to-left state without changing it, preserve per-line mixed direction in the editor, and use `dir="auto"` where Reading View supplies mixed content. They rely on Obsidian's automatic RTL icon mirroring and opt out of the host transform only for an icon whose meaning is physically fixed. Production icons use Obsidian `setIcon()` or uniquely prefixed static `addIcon()` assets validated against the supported host versions. Every custom asset fits the API's `0 0 100 100` view box and follows the documented Lucide geometry guidelines.

## 8. Mockup Contract

The non-normative interactive design reference is [mockup/index.html](mockup/index.html). It illustrates:

- floating and docked toolbar presentations;
- the contextual stylebar below the toolbar;
- tool selection and More Tools;
- selection of plugin-owned SVG objects;
- whole-note zoom affecting Markdown, background, and SVG together;
- responsive desktop and compact behavior;
- light and dark Obsidian-like themes.

The mockup is not production code and contains no persistence or actual Obsidian API integration. [Toolbar Mockup](12-toolbar-mockup.md) describes how to run it.

The static mockup demonstrates the canonical default tool order. Production users configure the order through Obsidian's normal plugin settings; the mockup does not simulate that setting.

The textual binding contract in this document and [Anchors and Layout](05-anchors-and-layout.md) is authoritative where the static mockup does not simulate binding inference, range projection, or reflow. The mockup's generic selection rectangle is illustrative only. Production selection frames, endpoints, axes handles, resize semantics, and constant-width behavior are governed by [Interaction and Tools](02-interaction-and-tools.md) and [SVG Rendering](06-svg-rendering.md).
