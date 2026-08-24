# Handwriting Embed UI

## Locked State

In the locked state, no interactive drawing area is mounted. The embed displays a static preview of the saved SVG file.

Clicking the preview unlocks the embed.

The following rules apply:

- Only one ink embed can be active at a time.
- When another embed is opened, the plugin saves and locks the previously active embed.
- The locked preview and active scene occupy the same lifecycle-owned inline block. Unlocking never appends a second editor before or after that block.
- An empty locked preview contains at least 2.5 writing lines, rounded up to the next complete background step, plus the writable SVG margins. Obsidian's generic button height MUST NOT override this intrinsic preview height.
- A non-empty patterned locked preview contains the complete row holding the lowest annotation, exactly one further complete pattern row, and the writable bottom margin. It never retains the active writing buffer or a legacy locked-buffer multiplier.
- The existing preview remains visible until the in-place editor has fully loaded and has been measured correctly.
- Activation starts immediately without waiting for a delay threshold. If activation has not completed after 1,200 milliseconds, one icon-only `Loading drawing` status appears centered over the existing canvas. This long-load threshold keeps ordinary worker startup and validation visually quiet because the complete locked preview already remains visible. The delayed status is shown even when validation has not yet produced a trustworthy `activeHeight`: the presentation remains at its exact locked height instead of guessing a target, while the status provides continuous feedback for a genuinely slow activation. As soon as the validated editor chrome can mount, its toolbar follows the normal overlay entrance while the status remains until the scene is measured, painted, and ready for input. A faster activation never mounts the status.
- After the active scene has been measured, the same block grows from the serialized `lockedHeight` to the derived `activeHeight` over 240 milliseconds. Its top edge, width, root, and document position remain anchored; no second editor is inserted and toolbar chrome contributes no block height. This duration is never an activation delay: the ready state, input, focus, toolbar, and completion of loading feedback are released when the prepared representation swap and height transition start. The remaining transition time only retains the temporary clip geometry until cleanup.
- One persistent outer shell owned by the embed root draws the page surface, border, dynamic radius, and clipping edge in both states. Neither the locked preview nor the active editor owns a visible duplicate shell.
- Before the first growth frame, the active SVG scene is laid out once at its final `activeHeight`, remains top-anchored at that fixed block size for one complete painted frame, and stays unchanged while only the rounded background container grows and clips progressively more of it. Its physical and logical block-start inset, transform origin, and page-space origin remain at the container's top edge; it is never vertically centered. The prepared active editor and old preview exchange visibility atomically when growth starts. This representation swap never changes shell opacity, background, border, or radius. The old preview remains lifecycle-owned but hidden until the transition completes and input is enabled. There is no frame in which both inner presentations are hidden or detached.
- Automatic page growth may occur later when committed content leaves less than one aligned writable line.
- With reduced motion, measurement is still awaited, then target height and preview/editor visibility are applied without interpolation.

This prevents an empty, incorrectly scaled, or partially initialized drawing area from appearing briefly.

Locking keeps the disabled editor visible while the exact persisted preview is restored as a lower, already complete layer. After one complete paint opportunity, the inner representations exchange atomically in one frame and the editor unmounts. The persistent outer shell is never transparent or replaced.

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
2. A zero-height sticky host is the first child of the active editor. The toolbar is an absolutely positioned overlay lifted above that host and therefore contributes no layout height.
3. The background container owns the border, background, radius, and clipping.
4. The SVG committed-content bands and decorative overlays are inside the clipped background container and use `pointer-events: none`.
5. One transparent, focusable canvas input surface is above that content, below toolbar and flyouts, and owns canvas pointer, wheel, context-menu, and keyboard events.
6. Flyouts are portalled within the owning embed's document so they are not clipped by the background container and remain correct in pop-out windows.

Activation preserves the root, top-edge anchor, measured width, presentation attachment, and active editor identity while intentionally animating the block from `lockedHeight` to `activeHeight`. The toolbar overlays the note immediately above the page, including Markdown already painted there, and does not move that content or reduce, cover, or pad the SVG page. The embed root explicitly preserves visible overflow and disables host-imposed paint containment so the upward toolbar overhang remains painted and hit-testable; paint containment remains scoped to the page surface below it. A stroke commit, autosave, SVG resource refresh, theme change, or asynchronous document reclassification MUST NOT detach, remount, move, or lock the active editor.

The embed uses its own final background-container content-box width after the resolved note scroller's native right-hand scrollbar gutter has been stabilized. It respects note padding, readable-line width, lists, callouts, and other nested constraints; it never adopts the full scroller width. No Inkbook layer, including the toolbar, input surface, flyout, focus treatment, or background container, extends over the owner client edge or scrollbar gutter. Pointer contact does not add or remove any layout-affecting UI. The host-scroll ownership, edge clamp, and platform-specific native overlay behavior are defined in [Obsidian Integration](obsidian-integration.md#native-scroll-owner-and-scrollbar-stability).

## Toolbar Layout

The primary toolbar is one continuous control track. Context-sensitive clipboard and deletion actions are separate circular controls placed to its right and never participate in centering the primary track.

The general actions are located at the start of the primary track:

- finger-drawing toggle when finger drawing is enabled for this device and vault
- Undo, always visible and disabled when no action can be undone
- Redo, always visible and disabled when no action can be redone

The tools are located in the center:

- Select
- Eraser
- Draw
- Highlighter
- Straight Highlighter
- Active Shape, displaying the currently selected shape icon
- Shape Picker
- Style

The Straight Highlighter control uses the same marker silhouette as Highlighter with two short, evenly spaced ruler marks inside the body instead of a generic line symbol. Inkbook registers this custom icon through Obsidian's public `addIcon()` API and removes it on plugin deactivation through `removeIcon()`.

The Style control retains the canonical 19-pixel Palette geometry instead of swapping among stored icon assets. Its SVG attributes update from the active tool defaults: the glyph outline uses the tool color, line-cap-safe dash patterns distinguish solid, dashed, and dotted outlines, and a closed shape fills the palette body with its fill color and exact fill opacity. The four palette wells stay solid and use the outline color. The SVG node and button remain mounted while these attributes change, and Theme text color resolves through the owning toolbar's current host color in every window.

The end of the primary track contains:

- Lock
- overflow menu

Context-sensitive actions appear as separate circular controls to the right of the centered primary track:

- Copy
- Cut
- Paste
- Delete

Copy, Cut, and Delete only appear when there is an active selection. Paste only appears when a valid ink clipboard payload is known. Undo and Redo remain visible at stable positions for the complete active-editor lifetime; each is disabled, removed from sequential and roving keyboard focus, and visually muted when its corresponding action is unavailable. Appearing or disappearing context controls MUST NOT move the primary track away from the exact editor center.

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

Attached load and save failures preserve the last safe preview or active scene and place one compact recovery panel at the lower center of that surface. Recovery actions are circular icon-only controls with an accessible name and tooltip; they never fall back to text buttons inside the embed. A load failure synchronously removes any delayed loading status before the recovery panel is mounted, so the two states cannot paint together; it offers Retry and Discard. A save failure performs the equivalent handoff from saving status to Retry, Save copy, and Continue editing. The longer detached-session recovery dialog uses the same icon actions while retaining explanatory text because no editor remains attached.

Saving uses an earlier feedback threshold than activation because input is already disabled while the write is pending. Input and uncommitted gestures are disabled immediately, the existing editor begins its normal lock transition immediately, and a centered icon-only `Saving drawing` status appears only when the latest required save is still unresolved after 150 milliseconds. It remains through coalesced successor saves, disappears on exact-revision confirmation, and is atomically replaced by attached recovery on failure. Retry starts a new delayed saving-status lifetime. Load and save failures show their recovery UI as soon as the failure is known rather than waiting for either feedback threshold. These statuses are absolutely positioned, have no layout participation or pointer handling, expose `role="status"` with an accessible name, and retain a static progress icon when reduced motion disables rotation.

## Toolbar Design

All primary controls share one continuous toolbar surface. Copy, Cut, Paste, and Delete intentionally use separate circular surfaces outside that primary pill.

The primary toolbar is one 48-pixel-high rounded surface with 2 pixels of internal padding, the exact current portable page-surface color, a 1-pixel host-theme border, and a restrained host shadow. The locked preview container, active background container, toolbar, and separate circular context controls therefore resolve to `#F6F6F6` in light mode and `#212121` in dark mode. The persistent outer embed shell owns one restrained shadow in locked and active states; the inner locked button explicitly suppresses native host button shadows and never changes depth on hover. Every 44-pixel primary control and its hover, active, and focus treatment are circular, with a consistent 2-pixel gap across the complete track. The complete primary pill scales from zero to full size over 300 milliseconds when the editor opens and applies the exact reverse while it closes. Its individual buttons and active-tool indicator do not run separate entrance or exit animations. Saving starts immediately while the presentation remains attached long enough to finish this decorative exit. Each conditional context action is a 48-pixel circular surface with exactly the same resolved background color, border, shadow, and top edge as the primary toolbar and an 8-pixel gap from adjacent surfaces; its transparent positioning group contributes no visible backdrop. Copy, Cut, Paste, and Delete use the same zero-to-full scale motion and its exact reverse. When several appear or disappear because selection or clipboard availability changes, their fully opaque, fixed-size surfaces start from left to right with a 50-millisecond stagger. Every disappearing surface retains its fixed layout slot until the last staggered exit in that batch reaches zero scale; all completed exit slots are then removed atomically, so no exiting control changes its layout origin while another exit remains visible. A complete editor lock scales every still-visible context control out concurrently with the primary pill so presentation teardown remains bounded to 300 milliseconds. The motion never animates width, moves neighboring controls, or resizes a 44-pixel primary control. Active tools keep normal icon geometry above one persistent accent-tinted circular indicator. A tool change translates that indicator between the old and new tool over 120 milliseconds, so the accent surface visibly slides without replacing either button or icon. The Finger Drawing toggle retains its local pressed treatment because it is a mode toggle rather than the active drawing tool. Destructive Delete uses the host error color. Every control is keyboard-focusable and has a visible `focus-visible` ring. Reduced motion moves the pill, the indicator, and conditional controls directly to their final states.

Every control has a 44-by-44-pixel hit target. The icon may be visually smaller and does not change size between rest, hover, active, and focus states.

The 48-pixel toolbar track is positioned inside a 68-pixel overlay envelope with 8 pixels above and 12 pixels below it. The complete envelope is translated above a zero-height host, so it creates no dead page padding, moves no surrounding Markdown, and removes no writable SVG space.

It is positioned above the drawing area inside the same in-place editor boundary while painting over the note rather than participating in note flow. The zero-height host uses native sticky positioning. Its inset compensates for the measured top padding of the already resolved public scroll owner, without private Obsidian selectors or per-scroll JavaScript writes. As the note scrolls, the toolbar moves normally until it reaches the visible top edge, remains there while its embed is visible, and leaves the viewport with the embed's bottom boundary.

## Responsive Behavior

The primary toolbar has two layout stages, selected from the measured width of its complete primary control track:

1. Wide: use this stage when the complete track fits within the available width. The track remains centered.
2. Scrollable: use this stage when the complete primary track and the symmetric space required by the currently visible context controls do not fit. Buttons and gaps remain unchanged. One transparent 50-pixel-high capsule-clipped horizontal scrollport contains the complete primary pill followed by every separate 48-pixel context-action circle, with one transparent pixel above and below the control surfaces so their outlines remain intact. Partially visible surfaces retain rounded scroll edges instead of a rectangular cut. The toolbar shadow belongs to the outer, non-scrolling composition and therefore remains visible beyond the clipped scrollport without forming a rectangular backdrop. The scrollport hides only its own horizontal scrollbar and applies no edge fade or alpha mask. It never affects the native vertical Obsidian scrollbar.

The buttons are never reduced in size and never overlap. In Wide, context controls are absolutely positioned from the measured end of the centered primary pill, their presence does not move that pill, and the stage remains Wide only while every visible context control fits. In Scrollable, the complete visual row scrolls as one unit instead of placing context actions in a separate clipped viewport. Pointer panning and focus navigation can therefore reach Copy, Cut, Paste, and Delete at every supported width. The owner-window `ResizeObserver` refreshes the complete row overflow and measured pill edge whenever its actual size changes, including resizes that remain within the same responsive stage.

The pre-measurement state is Wide. The editor keeps the chrome hidden during its initial stable-width measurement, resolves the actual stage from the mounted control track, and reveals only that measured result. After initialization, the editor accepts every changed positive container width in the next coalesced frame. It observes the mounted primary toolbar directly as well as chrome mutations, so Wide or Scrollable stage, measured primary-pill edge, and context-action placement converge from the same current geometry during and after a window resize. A resize MUST NOT be required to correct first-open geometry.

The left-handed setting changes input behavior without breaking the continuous toolbar order or its fit calculation.

Toolbar, flyout, selection, container-height, and preview transitions follow [Quality, Performance, Animation, and Testing](quality-and-testing.md). Reduced motion preserves every final state without interpolation.

## Flyouts

Background, Shape Picker, and Style open flyouts. Active Shape is a drawing-tool control and never doubles as the picker trigger.

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
