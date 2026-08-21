# Handwriting Embed UI

## Locked State

In the locked state, no interactive drawing area is mounted. The embed displays a static preview of the saved SVG file.

Clicking the preview unlocks the embed.

The following rules apply:

- Only one ink embed can be active at a time.
- When another embed is opened, the plugin saves and locks the previously active embed.
- The existing preview remains visible until the new editor has fully loaded and has been measured correctly.
- The background container then animates to active height over 240 milliseconds. During the final 120 milliseconds, the preview fades out while the editor fades in. Input is enabled and the preview is unmounted only after the transition completes.
- With reduced motion, measurement is still awaited, then height and preview/editor visibility are exchanged in one frame.

This prevents an empty, incorrectly scaled, or partially initialized drawing area from appearing briefly.

## Unlocked State

The active editor consists of:

- the outer embed frame
- the floating toolbar
- the SVG drawing area
- the background
- the committed elements
- a temporary live stroke
- selection and cursor overlays

The border, rounded background container, toolbar, focus treatment, flyouts, and menus use Obsidian variables from the active host theme. The document graphic inside the container uses Inkbook's fixed, self-contained light and dark palette so the saved SVG and active scene remain identical outside Obsidian. The palette and scheme lifecycle are defined in [Standalone SVG Envelope and Theme Rendering](svg-envelope.md).

Its appearance:

- 1-pixel outer border
- gray Obsidian surface
- rounded background-container corners
- dynamic radius of `clamp(10px, 2% of the container width, 20px)`
- no additional internal CSS padding
- the visible page margin is part of the SVG page and is therefore writable

The SVG page itself is not rounded. The background container provides the dynamic corner radius and clips the SVG at its corners. The rounded background remains visible below the toolbar, while the visible side margin is embedded directly in the SVG rather than being created by a separate frame or CSS padding.

The normative DOM layer hierarchy is:

1. The embed root owns measurement and relative positioning but does not clip descendants.
2. The toolbar is an overlay sibling above the background container.
3. The background container owns the border, background, radius, and clipping.
4. The SVG committed-content bands and decorative overlays are inside the clipped background container and use `pointer-events: none`.
5. One transparent, focusable canvas input surface is above that content, below toolbar and flyouts, and owns canvas pointer, wheel, context-menu, and keyboard events.
6. Flyouts are portalled within the owning embed's document so they are not clipped by the background container and remain correct in pop-out windows.

The embed uses its own final background-container content-box width after the resolved note scroller's native right-hand scrollbar gutter has been stabilized. It respects note padding, readable-line width, lists, callouts, and other nested constraints; it never adopts the full scroller width. No Inkbook layer, including the toolbar, input surface, flyout, focus treatment, or background container, extends over the owner client edge or scrollbar gutter. Pointer contact does not add or remove any layout-affecting UI. The host-scroll ownership, edge clamp, and platform-specific native overlay behavior are defined in [Obsidian Integration](obsidian-integration.md#native-scroll-owner-and-scrollbar-stability).

## Toolbar Layout

The toolbar is a single continuous container with three semantic regions.

The general actions are located on the left:

- finger-drawing toggle when finger drawing is enabled for this device and vault
- Background
- Undo, when an action can be undone
- Redo, when an action can be redone

The tools are located in the center:

- Select
- Eraser
- Draw
- Highlighter
- Straight Highlighter
- Shape
- Style

Context-sensitive actions are located on the right:

- Copy
- Cut
- Delete
- Paste
- Lock
- overflow menu

Copy, Cut, and Delete only appear when there is an active selection. Paste only appears when a valid ink clipboard payload is known. Undo and Redo also disappear completely when the corresponding action is unavailable.

The overflow and selection context menus expose a non-interactive Arrange label followed by Bring forward, Send backward, Bring to front, and Send to back as four flat actions. The public Obsidian `MenuItem` API has no submenu contract, so Inkbook does not emulate one with private APIs or React. Disabled boundary actions remain visible in the menu so their layer behavior is discoverable. These actions do not consume four permanent toolbar slots.

## Context Menu Presentation

Canvas menus use Obsidian's native menu component, never a React-rendered SVG overlay. Every actionable entry has a built-in Lucide icon:

| Action | Icon |
|---|---|
| Copy, Copy embed | `copy` |
| Cut | `scissors` |
| Paste | `clipboard-paste` |
| Delete, Delete embed | `trash-2` |
| Arrange label | `layers` |
| Bring forward | `arrow-up` |
| Send backward | `arrow-down` |
| Bring to front | `chevrons-up` |
| Send to back | `chevrons-down` |
| Erase all | `eraser` |

Arrange calls `setIsLabel(true)` and has no click handler. Delete, Erase all, and Delete embed use the host warning presentation so both icon and text are red. Cut remains a normal action because it is clipboard-preserving and undoable. Separators divide selection actions from canvas or embed actions. Menu items use sentence case, expose their visible title as the accessible name, and retain visible disabled Arrange boundary actions.

The native menu owns arrow-key navigation and `Escape`. After it closes, focus returns to the control that opened it or to the canvas input surface. Mouse, touch, keyboard placement, target selection, and action availability are normative in [Features](features.md#canvas-context-menus).

## Toolbar Design

All controls share one continuous toolbar surface. They are not rendered as separate circular controls.

The toolbar is:

- rounded
- exactly `max(2.75em, 44px)` high
- arranged with 8-pixel spacing between controls
- filled and color-inverted for the active control
- keyboard-focusable
- equipped with a visible `focus-visible` ring

Every control has a 44-by-44-pixel hit target. The icon may be visually smaller and does not change size between rest, hover, active, and focus states.

The toolbar has 8 pixels of spacing above it and 12 pixels between it and the drawing area.

It is positioned as an overlay above the embed and does not occupy its own layout height. When the note is scrolled, it remains at the visible top edge while its associated embed is still visible. At the bottom of the embed, the toolbar also leaves the viewport.

## Responsive Behavior

The toolbar has three layout stages, selected from measured group widths after conditional controls have been resolved:

1. Wide: use this stage when the left and right groups fit without intersecting the exactly centered tool group, including 16 pixels of clearance on both sides. All groups remain inside the same continuous toolbar container.
2. Merged: use this stage when the complete row, including 8-pixel control gaps and 16-pixel group gaps, fits within the container but the Wide condition fails. The groups form one centered row.
3. Scrollable: use this stage when the measured merged row is wider than the container. Buttons and gaps remain unchanged. The toolbar scrolls horizontally, hides only its own horizontal scrollbar, and shows a 24-pixel edge gradient only where more content exists. It never affects the native vertical Obsidian scrollbar.

The buttons are never reduced in size, and groups do not overlap.

When the left-handed setting is enabled, the tool group is pulled farther toward the leading side in the wide layout.

Toolbar, flyout, selection, container-height, and preview transitions follow [Quality, Performance, Animation, and Testing](quality-and-testing.md). Reduced motion preserves every final state without interpolation.

## Flyouts

Background, Shape, and Style open flyouts.

The following rules apply:

- Only one flyout can be open at a time.
- A click or drawing action on the canvas closes the flyout.
- `Escape` closes the flyout.
- Flyouts are clamped to the visible boundary of the Obsidian area.
- On narrow embeds, they are shifted so that they are not clipped.
- The flyouts appear above the finger-input overlay and therefore remain operable.

Menus and portals use the document that owns the embed. Static UI styling is scoped beneath the Inkbook root in `styles.css` and uses Obsidian CSS variables. The concrete host API and pop-out requirements are defined in [Obsidian Integration](obsidian-integration.md).

## Related Documentation

- [Editor tools](editor-tools.md)
- [Implementation specification](specification.md)
- [Quality and testing](quality-and-testing.md)
- [Zoom functionality](zoom.md)
- [Rendering and performance](rendering-and-performance.md)
- [Obsidian integration](obsidian-integration.md)
