# Handwriting Embed UI

## Locked State

In the locked state, no interactive drawing area is mounted. The embed displays a static preview of the saved SVG file.

Clicking the preview unlocks the embed.

The following rules apply:

- Only one ink embed can be active at a time.
- When another embed is opened, the plugin saves and locks the previously active embed.
- The locked preview and active scene occupy the same lifecycle-owned inline block. Unlocking never appends a second editor before or after that block.
- An empty locked preview contains at least 2.5 writing lines, rounded up to the next complete background step, plus the writable SVG margins. Obsidian's generic button height MUST NOT override this intrinsic preview height.
- The existing preview remains visible until the in-place editor has fully loaded and has been measured correctly.
- After the active scene has been measured, the same block grows from the serialized `lockedHeight` to the derived `activeHeight` plus the active-only toolbar row over 240 milliseconds. Its top edge, width, root, and document position remain anchored; no second editor is inserted.
- The preview remains visible over the growing scene. During the final 120 milliseconds, the preview fades out while the editor and its overlay toolbar fade in. Input is enabled and the preview is unmounted only after the transition completes.
- Automatic page growth may occur later when committed content leaves less than one aligned writable line.
- With reduced motion, measurement is still awaited, then target height and preview/editor visibility are applied without interpolation.

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
- the visible unpatterned margin on all four sides is part of the SVG page, scales with it, and is writable

The SVG page itself is not rounded. The background container provides the dynamic corner radius and clips the SVG at its corners. The rounded background remains visible below the toolbar. The top, right, bottom, and left page margins are embedded directly in the SVG rather than being created by a separate frame or CSS padding. Background guides stop at the inner edge of those margins, while the input surface and element renderer cover the complete page. Writing into a margin is therefore retained, and downward growth restores a complete bottom margin below the new occupied extent.

The normative DOM layer hierarchy is:

1. The embed root owns measurement and relative positioning but does not clip descendants.
2. The toolbar is an absolutely positioned sibling in an active-only control row above the background container.
3. The background container owns the border, background, radius, and clipping.
4. The SVG committed-content bands and decorative overlays are inside the clipped background container and use `pointer-events: none`.
5. One transparent, focusable canvas input surface is above that content, below toolbar and flyouts, and owns canvas pointer, wheel, context-menu, and keyboard events.
6. Flyouts are portalled within the owning embed's document so they are not clipped by the background container and remain correct in pop-out windows.

Activation preserves the root, top-edge anchor, measured width, presentation attachment, and active editor identity while intentionally animating the block from `lockedHeight` to the active page plus its toolbar row. The toolbar row exists only while the editor is active and does not reduce, cover, or pad the SVG page. A stroke commit, autosave, SVG resource refresh, theme change, or asynchronous document reclassification MUST NOT detach, remount, move, or lock the active editor.

The embed uses its own final background-container content-box width after the resolved note scroller's native right-hand scrollbar gutter has been stabilized. It respects note padding, readable-line width, lists, callouts, and other nested constraints; it never adopts the full scroller width. No Inkbook layer, including the toolbar, input surface, flyout, focus treatment, or background container, extends over the owner client edge or scrollbar gutter. Pointer contact does not add or remove any layout-affecting UI. The host-scroll ownership, edge clamp, and platform-specific native overlay behavior are defined in [Obsidian Integration](obsidian-integration.md#native-scroll-owner-and-scrollbar-stability).

## Toolbar Layout

The primary toolbar is one continuous control track. Context-sensitive clipboard and deletion actions are separate circular controls placed to its right and never participate in centering the primary track.

The general actions are located at the start of the primary track:

- finger-drawing toggle when finger drawing is enabled for this device and vault
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

The end of the primary track contains:

- Lock
- overflow menu

Context-sensitive actions appear as separate circular controls to the right of the centered primary track:

- Copy
- Cut
- Paste
- Delete

Copy, Cut, and Delete only appear when there is an active selection. Paste only appears when a valid ink clipboard payload is known. Undo and Redo also disappear completely when the corresponding action is unavailable. Appearing or disappearing context controls MUST NOT move the primary track away from the exact editor center.

The overflow menu opens directly below the three-dot trigger and never at the canvas center. Its Background item has an icon and opens a separate icon-labelled side submenu on pointer hover, keyboard focus, or explicit activation without resizing or repositioning the anchored parent menu. The submenu exposes None, Lines, Dots, Squares, and the applicable spacing choices. Because Obsidian's public native `Menu` API has no submenu contract, this toolbar overflow uses the same owner-document React portal and bounded positioning lifecycle as the other editor flyouts; canvas context menus remain native Obsidian menus.

The overflow and selection context menus expose a non-interactive Arrange label followed by Bring forward, Send backward, Bring to front, and Send to back as four flat actions. Native canvas context menus do not emulate submenus with private APIs or React. Disabled boundary actions remain visible in the menu so their layer behavior is discoverable. These actions do not consume four permanent toolbar slots.

## Context Menu Presentation

Canvas menus use Obsidian's native menu component, never a React-rendered SVG overlay. Every actionable entry has a built-in Lucide icon:

| Action               | Icon              |
| -------------------- | ----------------- |
| Copy, Copy embed     | `copy`            |
| Cut                  | `scissors`        |
| Paste                | `clipboard-paste` |
| Delete, Delete embed | `trash-2`         |
| Arrange label        | `layers`          |
| Bring forward        | `arrow-up`        |
| Send backward        | `arrow-down`      |
| Bring to front       | `chevrons-up`     |
| Send to back         | `chevrons-down`   |
| Erase all            | `eraser`          |

Arrange calls `setIsLabel(true)` and has no click handler. Delete, Erase all, and Delete embed use the host warning presentation so both icon and text are red. Cut remains a normal action because it is clipboard-preserving and undoable. Copy, Cut, Paste, and Delete form one editing section when applicable; Arrange actions form the next section; Copy embed is document-level; Erase all and Delete embed form the final destructive section. Separators appear only between those sections. Menu items use sentence case, expose their visible title as the accessible name, and retain visible disabled Arrange boundary actions.

The native menu owns arrow-key navigation and `Escape`. After it closes, focus returns to the control that opened it or to the canvas input surface. Mouse, touch, keyboard placement, target selection, and action availability are normative in [Features](features.md#canvas-context-menus).

## Toolbar Design

All primary controls share one continuous toolbar surface. Copy, Cut, Paste, and Delete intentionally use separate circular surfaces outside that primary pill.

The primary toolbar is one 52-pixel-high rounded surface with a 1-pixel host-theme border and a restrained host shadow. Every 44-pixel primary control and its hover, active, and focus treatment are circular, with a consistent 2-pixel gap across the complete track. Each conditional context action is a 52-pixel circular surface with the same border and shadow and an 8-pixel gap from adjacent surfaces. Active controls keep normal icon geometry and use an accent-tinted inset surface plus accent outline instead of a fully color-inverted button. Destructive Delete uses the host error color. Every control is keyboard-focusable and has a visible `focus-visible` ring.

Every control has a 44-by-44-pixel hit target. The icon may be visually smaller and does not change size between rest, hover, active, and focus states.

The toolbar has 8 pixels of spacing above it and 6 pixels below it. Its 66-pixel active-only control row is outside the background container, so it creates no dead page padding and removes no writable SVG space.

It is positioned above the drawing area inside the same in-place editor block. When the note is scrolled, it remains at the visible top edge while its associated embed is still visible. At the bottom of the embed, the toolbar also leaves the viewport.

## Responsive Behavior

The primary toolbar has two layout stages, selected from the measured width of its complete primary control track:

1. Wide: use this stage when the complete track fits within the available width. The track remains centered.
2. Scrollable: use this stage when the complete track is wider than the available width. Buttons and gaps remain unchanged. The toolbar scrolls horizontally, hides only its own horizontal scrollbar, and shows a 24-pixel edge gradient only where more content exists. It never affects the native vertical Obsidian scrollbar.

The buttons are never reduced in size and never overlap. Context controls are absolutely positioned from the measured end of the centered primary pill. Their presence does not contribute to the primary pill's centering calculation. The responsive layout permanently reserves a symmetric 136-pixel corridor around a scrollable primary pill, leaving one 52-pixel action viewport plus its gaps on the right without moving the pill center; additional context controls scroll only inside that right-hand viewport. The owner-window `ResizeObserver` refreshes the measured pill edge whenever its actual size changes, including resizes that remain within the same responsive stage.

The left-handed setting changes input behavior without breaking the continuous toolbar order or its fit calculation.

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
- Flyouts use one compact panel surface with a clear heading, grouped fields, 44-pixel choice targets, visible selection borders, and host-theme focus rings.
- The Style flyout represents colors as labelled swatches, widths and dash styles as line previews, Boolean values as switches, and structural values as compact labelled controls. Labels remain available to assistive technology even when the visual choice is primarily graphical.

Menus and portals use the document that owns the embed. Static UI styling is scoped beneath the Inkbook root in `styles.css` and uses Obsidian CSS variables. The concrete host API and pop-out requirements are defined in [Obsidian Integration](obsidian-integration.md).

## Related Documentation

- [Editor tools](editor-tools.md)
- [Implementation specification](specification.md)
- [Quality and testing](quality-and-testing.md)
- [Zoom functionality](zoom.md)
- [Rendering and performance](rendering-and-performance.md)
- [Obsidian integration](obsidian-integration.md)
