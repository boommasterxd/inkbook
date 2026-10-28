# Zoom Functionality

## Core Principle

Handwriting mode uses width-fit zoom as its lower bound.

At 100 percent, the entire page width is visible. The user can zoom in, but cannot zoom out beyond the page width.

The fit zoom is calculated in CSS pixels per page unit as:

```
fitZoom = containerWidth / outerPageWidth
```

`containerWidth` is the positive content-box width of Inkbook's own background container after the native-scrollbar lease and any owner-client-edge clamp have settled. It is never the full pane or scroll-owner width. The first visible width requires two equal animation-frame measurements. After that initialization, every changed positive width is accepted in the next coalesced frame so the camera, SVG, container height, and native-scroll anchor track a continuous window resize without a delayed jump.

The active editor reads its container box, responsive toolbar stage, and resize anchor together before applying the layout pass's height, camera, native-scroll, and chrome updates. The anchor and height update reuse the captured container box. Scene viewport reads retain their existing live geometry path and scheduler ordering.

The outer page width is:

```
2000 + 2 × 24.3 = 2048.6 page units
```

The exact limits are:

```
minZoom = fitZoom
maxZoom = max(5, fitZoom × 5)
displayedPercent = camera.zoom / fitZoom × 100
renderedContainerHeight = derivedPageHeight × camera.zoom
```

This guarantees a non-empty range with at least five-times relative magnification. In normal containers the absolute maximum remains 5 CSS pixels per page unit.

`renderedContainerHeight` describes the page content height. The host adapter adds the container's block-axis borders when assigning its CSS border-box height and removes them before converting measured heights back to page units. Locked and active presentations therefore retain identical outer heights when their page heights are equal; the border never consumes writable page space.

## Zoom Input

The exact keyboard binding is device-local and configurable. Its built-in value and keyboard-layout aliases are defined in [Keyboard Shortcuts](keyboard-shortcuts.md); the zoom factor and anchor behavior below remain unchanged when the binding changes.

The following controls work in the active handwriting embed:

- `Ctrl` or `Cmd` plus mouse wheel
- trackpad pinch
- `Ctrl` or `Cmd` plus `+`
- `Ctrl` or `Cmd` plus `-`
- two-finger pinch on a touchscreen

Keyboard shortcut eligibility follows the [canvas keyboard ownership contract](keyboard-shortcuts.md#ownership-and-scope). A focused canvas accepts zoom without pointer hover; document-level handling requires the pointer over the active embed. Outside that scope, the normal Obsidian zoom functions remain active.

One keyboard step or modifier-wheel line/page event changes the zoom by exactly a factor of 1.08. All modifier-wheel pixel events use continuous magnitude-based zoom with `factor = exp(-deltaY / 100)`, matching Chromium's synthetic touchpad-pinch scale. There is no delta-magnitude threshold that switches a gesture to discrete steps. Browsers do not expose a reliable wheel-device identity: a mouse emitting pixel-mode events follows this same continuous mapping. Pixel input is coalesced once per animation frame and never waits for a complete discrete wheel step. Opposing deltas received before that frame combine algebraically instead of discarding unfinished input. Touch pinch uses the absolute distance ratio from the gesture's initial valid separation.

## Anchored Zoom

Zooming is centered on the pointer position, the midpoint of the touch gesture, or the visible canvas center for keyboard zoom without pointer hover. Keyboard layout aliases and anchor ownership follow the [configured keyboard zoom contract](keyboard-shortcuts.md#configurable-canvas-bindings).

A touch pinch retains the page point beneath its initial midpoint. The current finger separation determines the bounded zoom target, and the current midpoint determines that retained point's new screen position. Moving both fingers together therefore pans the content even when their separation does not change. Horizontal camera and native vertical scroll limits still take precedence at page boundaries. Returning toward the initial separation immediately changes the next frame's target; no earlier scale change is replayed after reversal or release. Gesture cancellation restores its origin and releases its pending target through the existing navigation lifecycle. External resize, scroll-owner transfer, or view restoration cancels the active pinch and its pointer ownership; later samples require a new explicit gesture start instead of reapplying the old distance ratio.

The page point beneath the anchor should remain at the same screen position during zooming. To achieve this, the plugin adjusts the following simultaneously:

- the zoom
- the horizontal camera position
- the visible embed height
- the note's scroll position

The horizontal camera is constrained so the page never exposes blank space at either side:

```
minimumCameraX = containerWidth / zoom - outerPageWidth
maximumCameraX = 0
camera.x = clamp(candidateCameraX, minimumCameraX, maximumCameraX)
```

At width fit, both limits are exactly 0, so `camera.x` MUST be 0 and the full page width is visible. Above fit, the interval allows horizontal navigation while keeping both viewport edges covered by the page.

Vertical panning in the handwriting embed does not use `camera.y`. Vertical movement remains controlled by the native Obsidian scroller. This means that a normal mouse-wheel gesture continues to scroll the note.

Horizontal navigation uses:

- a horizontal trackpad gesture
- `Shift` plus mouse wheel
- a predominantly horizontal one-finger gesture

A one-finger gesture leaves its pending state after 4 screen pixels. It is horizontal only when `abs(deltaX) > abs(deltaY)` and vertical otherwise. Until horizontal ownership is established, touch events remain available to Obsidian and the browser. Touching an unselected annotation does not select it on contact. A release selects it only when the complete gesture remains below 6 screen pixels and 350 milliseconds; any horizontal pan or vertical note scroll therefore produces no selection. An annotation move can begin only when that annotation was already selected before contact; that contact is claimed immediately and may move in any direction after its 6-pixel drag threshold. Once horizontal page pan, pinch, finger drawing, or an eligible annotation drag wins arbitration, Inkbook contains the gesture so host pane and drawer actions cannot latch it. At width fit the horizontal camera remains clamped at `0`; above fit direct one-finger horizontal movement follows screen-space finger displacement without a response multiplier. With finger drawing disabled, the input surface keeps `touch-action: pan-y`. A vertical touch gesture from empty canvas or an unselected annotation therefore remains on the browser's native scroll path, including platform kinetic scrolling, instead of forwarding deltas through Inkbook or introducing a nested canvas scroller. Inkbook does not prevent its terminal event, write `scrollTop` from a purely horizontal camera frame, or restore a scroll position after native cancellation. Vertical trackpad and ordinary wheel input are also left unclaimed. Terminal pointer and touch events remain visible to host cleanup. A next-task fallback releases captured touch state only after the complete terminal event has had an opportunity to commit, while interruption and a later primary contact still recover genuinely stale state.

Horizontal-dominant trackpad Wheel events apply their normalized screen-space deltas directly, including browser or operating-system inertial events. Pending deltas combine algebraically in one centrally admitted input frame, without a response multiplier. Pixel-mode events retain their magnitude; line/page modes retain the canonical unit normalization. Shift-wheel retains its existing horizontal routing.

Consumed Wheel events can suppress Chromium's native touchpad fling ([Chromium implementation](https://github.com/chromium/chromium/blob/150.0.7871.43/components/input/fling_controller.cc#L151)). Inkbook therefore supplies bounded kinetic motion after a quiet interval for cancelable, unshifted pixel-mode horizontal input. The interval is three times the latest positive event interval, clamped to 32–80 milliseconds, with a 48-millisecond initial interval. The existing central input frame checks this deadline without layout reads or camera writes before it expires. Valid event timestamps use the owning window's performance time basis; invalid or future timestamps use the current time. Release velocity uses the final sample time rather than the delayed release deadline. Each new direct event stops an active synthetic tail before applying its unchanged delta. A gap greater than 120 milliseconds or a backwards timestamp starts a new burst.

DOM Wheel events expose neither physical contact nor a portable momentum phase. A noncancelable event suppresses Inkbook's synthetic tail until the next burst to avoid duplicating a browser-supplied tail; this is a conservative signal, not a universal detector of operating-system inertia. Line/page and Shift-wheel input never starts synthetic momentum. Vertical input, zoom, pointer contact, resize, scroll-owner transfer, and disposal cancel pending or active momentum.

Releasing a horizontal one-finger page pan above width fit starts bounded kinetic motion from recent screen-space samples in the latest movement direction. The controller forwards already validated coalesced samples without projecting them again or adding reducer dispatches; direct movement still uses one dispatch per event. A stationary terminal sample does not dilute release velocity. The shared touch and trackpad velocity model retains at most 32 cumulative positions and timestamps and estimates speed from samples within a 120-millisecond window ending at the last moving sample. Equal timestamps merge; opposing movement resets the history to the latest direction. A quadratic least-squares fit estimates endpoint velocity, falling back to a linear fit for fewer than three samples or an ill-conditioned quadratic fit. A release more than 40 milliseconds after the last motion, before the latest sample, or with a fitted velocity opposing the latest direction does not start momentum.

Release speed must reach 50 pixels per second and is capped at 8,000 pixels per second. Velocity decays by `0.96^(elapsedMs / (1000 / 60))`; travel integrates that decay over each frame, and motion stops at 15 pixels per second. This bounded model does not reproduce every platform's native fling curve. Momentum advances inside the existing coalesced camera animation frame, creates no second rendering loop, and stops at a horizontal camera bound, on conflicting input, resize or scroll-owner transfer, lock or disposal, or a frame interruption longer than 100 milliseconds. It never adds vertical momentum or writes `scrollTop`: Obsidian remains the sole vertical scroll owner.

For an anchor at local screen coordinates `(anchorX, anchorY)`, horizontal anchoring uses:

```
pageX = anchorX / oldZoom - oldCameraX
newCameraX = anchorX / newZoom - pageX
```

Vertical anchoring uses the nearest Obsidian pane scroller as the sole scroll owner:

```
pageY = (oldScrollTop + anchorViewportY - embedTopInScrollContent) / oldZoom
newScrollTop = embedTopInScrollContent + pageY × newZoom - anchorViewportY
```

`anchorViewportY` is measured from the pane viewport's top edge. `embedTopInScrollContent` is the background container's top edge in the same pane's scroll-content coordinate system, measured before the atomic frame. The frame sets `renderedContainerHeight = derivedPageHeight * newZoom` before clamping `newScrollTop`.

The result is clamped to native scroll bounds. At the top or bottom boundary, exact anchoring yields to the native bound without introducing `camera.y`.

The Obsidian adapter resolves the scroll owner without private host selectors: starting at the background container, walk ancestors in its owning document and remember the first element whose computed `overflow-y` is `auto` or `scroll`. Prefer the first such element whose scroll range is positive. If no eligible ancestor currently has a positive range, use the remembered nearest eligible ancestor so a short note keeps the same future scroll owner; only when no eligible ancestor exists may the adapter use that document's `scrollingElement`. The gesture controller retains the result only for the current gesture and re-resolves after a widget remount or workspace layout change.

Each safely recognized presentation also retains a separate reference-counted scrollbar-stability lease for the resolved owner. That lease is established before Inkbook's first width-derived preview or editor measurement, remains across lock and unlock, and stays unchanged throughout pointer gestures, so native scrollbar reservation cannot change `containerWidth`, `fitZoom`, or the page position when a pen touches the canvas. A live layout move transfers leases over two frames; a destroyed presentation releases immediately and a remount acquires afresh. The lifecycle, edge clamp, and native overlay-scrollbar limitation are normative in [Obsidian Integration](obsidian-integration.md#native-scroll-owner-and-scrollbar-stability).

## Atomic Zoom Frames

Trackpads can emit multiple zoom events within a single screen frame. The plugin does not apply these events individually.

Instead, during each animation frame:

- zoom factors are multiplied
- horizontal and vertical pan components are added
- the most recently known anchor is used
- the camera, height, and scroll position are calculated from the same result

If a stroke commit grows the page before its scheduled layout measurement, the zoom frame adopts that committed extent for both the scene background and the container. The container must not outgrow its rendered page while the deferred measurement catches up.

The renderer owns zoom-height writes so pure owned geometry changes do not trigger redundant theme reads. Independent resize and foreign theme updates remain active; the provenance and CSS compatibility boundary are defined in [Imperative Scene Ownership](rendering-and-performance.md#imperative-scene-ownership).

Wheel and keyboard events retain raw anchor coordinates and measure layout in the executing frame, so intervening native scroll or host movement cannot supply a stale viewport. Pure horizontal frames derive no page height, read no vertical scroll range, and write no container height or `scrollTop`. Each navigation frame reads the active scene content box and native scroll owner's client viewport once in the owning window. The scene and cursor adopt that same fresh snapshot during the existing read phase; when no cursor exists, no cursor snapshot is stored. The scene viewport keeps the larger actual/target extent during preparation or height transition, while the cursor uses the measured content box. After native scroll readback, cursor and scene receive the same projected content intersection; the scene does not repeat that frame's host measurement. An unchanged-scale pan or stationary touch target that resolves to the measured scroll position skips the redundant scroll write and readback. A zoom-height write always retains native scroll application and readback because the browser may anchor or clamp scrolling during the height change. Later scroll, resize, owner transfer, and external layout changes invalidate the snapshot normally.

Continuous wheel and touch pinch adopt their latest reachable zoom target completely in the next centrally admitted input frame. They have no per-frame scale cap or replay queue. Their retained input state is constant-size, independent of the number of events in a burst; camera limits apply before publication. A reverse gesture is applied without draining older motion, and reaching a limit leaves no pending scale work. Finite extreme deltas saturate safely instead of producing zero or infinite factors. Discrete keyboard and line/page-wheel steps retain their separate factor-1.08 behavior and existing factor-1.35 frame bound.

The imperative scene renderer updates the camera transform, background grid, selection overlay, and scroll position in the same frame. It performs cached layout reads before calculations and DOM writes and does not notify React. Navigation supplies the cursor with a projected content box and the pre-read scroll viewport, using the actual applied content height and scroll-position readback. The same-frame cursor update therefore performs no bounding-box or computed-style reads after the height and scroll writes. Navigation may skip camera, selection, and cursor feedback only when an applied proof matches camera position and zoom, input zoom and fit zoom, container and owner viewport edges, owner and owning-window identity, and actual scroll position. Every navigation frame still takes the fresh layout read; an absent or invalid proof forces feedback once. Input configuration changes only when zoom or fit zoom changes. Zoom, resize, and scroll-owner transfer invalidate the proof. Native scroll clamping may still require browser layout; the readback preserves the actual clamped position. Later external layout changes invalidate the projection normally. A later committed camera change may update coarse UI state without changing scene geometry.

Live Preview retains at most one pending zoom-scroll target per CodeMirror view. A widget-owned binding uses public `EditorView.requestMeasure()` and `EditorView.updateListener` to reconcile that target after the host adjusts its height map. The existing admitted zoom callback requests the leading measurement; later targets retain only the latest anchor and request a trailing measurement no more often than once per 150 milliseconds. One semantic owner-window timer queues the measurement through the existing central `requestFrame()` admission. This throttle is not a work budget or a separate native work loop. The binding retains the measured container origin from the existing navigation snapshot and reads that owned container's rectangle once after host measurement. The resulting origin delta also accounts for height changes before the embed during host virtualization. The retained geometric target remains unclamped until this origin correction; native scroll bounds take precedence after correction. The immediate navigation write remains bounded. It corrects native scroll drift greater than 0.5 pixels once, without another scale update. Replaced targets share the same trailing measurement. A central scheduler frame reconciles a completed empty measurement when no host update listener runs; an earlier correction cancels that frame. Deliberate input, document changes, resize, owner transfer, locking, and disposal cancel obsolete ownership. Gesture cancellation and view restoration supply their restored scroll target so host reconciliation cannot reapply a previous zoom position.

An own zoom-generated scroll notification may consume one previously adopted scene/cursor projection instead of requesting another complete layout measurement. Reuse requires the same owner and owning window, actual scroll position, scene and host geometry revisions, and fresh container-border and scrollport rectangles. The measured content insets remain valid only until a foreign class/style notification or the public Obsidian `css-change` refresh invalidates scene layout. CodeMirror document, viewport, and geometry updates advance the host revision before reconciliation. Unknown, coalesced, native, or clamped scroll results fall back to normal invalidation when this proof fails; suspend, owner transfer, and disposal release it. Bounds checks remain necessary because content above the embed can move it without resizing it. This path adds no work loop or independent scheduler.

## Zoom When Locking

A locked preview always displays the full page width.

When a zoomed-in embed is locked, zoom and horizontal position begin returning to width fit while height changes to the locked target over 240 milliseconds. Lock, unlock, and content-driven height transitions suppress browser scroll anchoring on the resolved Obsidian scroll owner and retain the embed root's pre-transition viewport Y position. The bounded hold samples that single visual anchor once per animation frame and writes `scrollTop` only when host anchoring actually introduces drift. A host `scroll` event is corrected synchronously before the next paint, including bottom-pinning during locked-to-editor growth. Explicit wheel, touch-scroll, or scroll-key input transfers control to the user immediately.

After the exact saved preview is ready, the complete preview is restored below the disabled editor and takes over atomically after one complete paint opportunity, as described in [Embed UI](embed-ui.md#locked-state). When reduced motion is enabled, the final camera, height, and preview state apply together without interpolation.

Camera state belongs to one mounted editor presentation. When Obsidian removes that presentation, including Live Preview viewport virtualization, Inkbook discards its zoom and horizontal position. A later mount initializes directly at width fit before its first active frame and never paints a retained zoom state after an initial fit layout. Locking likewise starts the next editor at width fit.

## Resize Behavior

Pane resizing, sidebar changes, font scaling, mobile orientation changes, and remount measurement changes preserve relative magnification and the page point at the viewport center.

```
relativeMagnification = oldZoom / oldFitZoom
newZoom = clamp(relativeMagnification × newFitZoom, newFitZoom, max(5, newFitZoom × 5))
```

The editor then applies the same anchored horizontal and vertical equations using the viewport center. A zero-width or hidden container delays initialization until a positive stable width is observed on two consecutive animation frames. It does not reapply that stabilization delay to later positive resize observations. A zoom-owned height write may suppress one subsequent root-only resize invalidation only after the preceding full layout proof has been adopted by both scene and cursor, and the fresh root size, owner, window, viewport edges, and scroll position still match that proof. The proof is one-use. External width or height changes, position changes, host clamping, theme-driven geometry, unknown measurements, and resize notifications before snapshot adoption retain normal invalidation. Coalesced zoom writes reuse the proof only while each observed state remains coherent with its predecessor.

## Related Documentation

- [Embed UI](embed-ui.md)
- [Implementation specification](specification.md)
- [Quality and testing](quality-and-testing.md)
- [Rendering and performance](rendering-and-performance.md)
- [Obsidian integration](obsidian-integration.md)
