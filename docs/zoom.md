# Zoom Functionality

## Core Principle

Handwriting mode uses width-fit zoom as its lower bound.

At 100 percent, the entire page width is visible. The user can zoom in, but cannot zoom out beyond the page width.

The fit zoom is calculated in CSS pixels per page unit as:

```
fitZoom = containerWidth / outerPageWidth
```

`containerWidth` is the positive content-box width of Inkbook's own background container after the native-scrollbar lease and any owner-client-edge clamp have settled. It is never the full pane or scroll-owner width. The first visible width requires two equal animation-frame measurements. After that initialization, every changed positive width is accepted in the next coalesced frame so the camera, SVG, container height, and native-scroll anchor track a continuous window resize without a delayed jump.

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

The keyboard shortcuts only take effect when the pointer is over the active canvas. Otherwise, the normal Obsidian zoom functions remain active.

One keyboard step or modifier-wheel line/page event changes the zoom by exactly a factor of 1.08. All modifier-wheel pixel events use continuous magnitude-based zoom, equivalent to one 1.08 step per 6.4 vertical pixels. There is no delta-magnitude threshold that switches a gesture to discrete steps. Browsers do not expose a reliable wheel-device identity: a mouse emitting pixel-mode events follows this same continuous mapping. Pixel input is coalesced once per animation frame and never waits for a complete discrete wheel step. Touch pinch keeps its direct distance ratio.

## Anchored Zoom

Zooming is centered on the pointer position or the midpoint of the touch gesture.

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

A one-finger gesture leaves its pending state after 4 screen pixels. It is horizontal only when `abs(deltaX) > abs(deltaY)` and vertical otherwise. Until horizontal ownership is established, touch events remain available to Obsidian and the browser. Touching an unselected annotation does not select it on contact. A release selects it only when the complete gesture remains below 6 screen pixels and 350 milliseconds; any horizontal pan or vertical note scroll therefore produces no selection. An annotation move can begin only when that annotation was already selected before contact; that contact is claimed immediately and may move in any direction after its 6-pixel drag threshold. Once horizontal page pan, pinch, finger drawing, or an eligible annotation drag wins arbitration, Inkbook contains the gesture so host pane and drawer actions cannot latch it. At width fit the horizontal camera remains clamped at `0`; above fit direct one-finger horizontal movement applies a `1.2` response multiplier before camera clamping. With finger drawing disabled, the input surface keeps `touch-action: pan-y`. A vertical touch gesture from empty canvas or an unselected annotation therefore remains on the browser's native scroll path, including platform kinetic scrolling, instead of forwarding deltas through Inkbook or introducing a nested canvas scroller. Inkbook does not prevent its terminal event, write `scrollTop` from a purely horizontal camera frame, or restore a scroll position after native cancellation. Vertical trackpad and ordinary wheel input are also left unclaimed. Terminal pointer and touch events remain visible to host cleanup. A next-task fallback releases captured touch state only after the complete terminal event has had an opportunity to commit, while interruption and a later primary contact still recover genuinely stale state.

Releasing a horizontal one-finger page pan above width fit starts bounded kinetic motion from the complete recent 120-millisecond screen-space movement window only when release speed reaches 100 pixels per second. Initial speed is capped at 4,000 pixels per second, velocity is multiplied by `0.935^(elapsedMs / (1000 / 60))`, and motion stops below 15 pixels per second. A qualifying horizontal-dominant, unshifted, pixel-mode trackpad burst uses the same bounded X-only momentum model after the expected next Wheel event fails to arrive. Direct trackpad movement uses a bounded linear speed response: samples at or below 250 screen pixels per second retain a `1` response factor, samples at or above 2,500 pixels per second use `1.75`, and intermediate speeds interpolate continuously. The same adjusted screen delta feeds the release-velocity estimator, so direct movement and kinetic travel preserve the same slow-to-fast relationship. A direction reversal clears older opposite-direction velocity samples before estimating the new tail. The handoff window is 1.5 times the latest valid event interval, clamped from 8 through 40 milliseconds, with a 24-millisecond default until cadence is known. Trackpad samples, the adaptive release, and animation frames use the owning window's monotonic `performance.now()` time base. Every native operating-system inertia event remains direct input and restarts the handoff window, so synthetic momentum begins only after the native event tail has ended and the two effects are never applied concurrently. Trackpad classification has no arbitrary delta-magnitude cutoff. The elapsed-time formula keeps the same feel from 60 through 240 Hz. Momentum advances inside the existing coalesced camera animation frame, creates no second rendering loop, and stops immediately at a horizontal camera bound, on new conflicting pointer, wheel, keyboard-zoom, or pinch input, on resize or scroll-owner transfer, on lock or disposal, and after a frame interruption longer than 100 milliseconds. It never adds vertical momentum or writes `scrollTop`: Obsidian remains the sole vertical scroll owner.

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

Wheel and keyboard events retain raw anchor coordinates and measure layout in the executing frame, so intervening native scroll or host movement cannot supply a stale viewport. Pure horizontal frames derive no page height, read no vertical scroll range, and write no container height or `scrollTop`. Zoom reads the owner's client viewport once and reuses it for clamping and projection. After native scroll readback, cursor and scene receive the same projected content intersection; the scene does not repeat that frame's host measurement. Later scroll, resize, and external layout changes invalidate it normally.

A single frame may change the zoom by no more than a factor of 1.35. This prevents a quick pinch from causing a sudden jump. Continuous wheel input bounds its queued target to the reachable zoom range. Reversing direction discards the unfinished opposite-direction zoom tail, so input beyond a camera limit cannot delay the next reverse gesture. Finite extreme deltas saturate safely instead of producing zero or infinite factors.

The imperative scene renderer updates the camera transform, background grid, selection overlay, and scroll position in the same frame. It performs cached layout reads before calculations and DOM writes and does not notify React. Navigation supplies the cursor with a projected content box and the pre-read scroll viewport, using the actual applied content height and scroll-position readback. The same-frame cursor update therefore performs no bounding-box or computed-style reads after the height and scroll writes. Native scroll clamping may still require browser layout; the readback preserves the actual clamped position. Later external layout changes invalidate the projection normally. A later committed camera change may update coarse UI state without changing scene geometry.

## Zoom When Locking

A locked preview always displays the full page width.

When a zoomed-in embed is locked, zoom and horizontal position begin returning to width fit while height changes to the locked target over 240 milliseconds. Lock, unlock, and content-driven height transitions suppress browser scroll anchoring on the resolved Obsidian scroll owner and retain the embed root's pre-transition viewport Y position. The bounded hold samples that single visual anchor once per animation frame and writes `scrollTop` only when host anchoring actually introduces drift. A host `scroll` event is corrected synchronously before the next paint, including bottom-pinning during locked-to-editor growth. Explicit wheel, touch-scroll, or scroll-key input transfers control to the user immediately.

After the exact saved preview is ready, it crossfades independently over 120 milliseconds as defined in [Quality and Testing](quality-and-testing.md). When reduced motion is enabled, the final camera, height, and preview state apply together without interpolation.

Camera state belongs to one mounted editor presentation. When Obsidian removes that presentation, including Live Preview viewport virtualization, Inkbook discards its zoom and horizontal position. A later mount initializes directly at width fit before its first active frame and never paints a retained zoom state after an initial fit layout. Locking likewise starts the next editor at width fit.

## Resize Behavior

Pane resizing, sidebar changes, font scaling, mobile orientation changes, and remount measurement changes preserve relative magnification and the page point at the viewport center.

```
relativeMagnification = oldZoom / oldFitZoom
newZoom = clamp(relativeMagnification × newFitZoom, newFitZoom, max(5, newFitZoom × 5))
```

The editor then applies the same anchored horizontal and vertical equations using the viewport center. A zero-width or hidden container delays initialization until a positive stable width is observed on two consecutive animation frames. It does not reapply that stabilization delay to later positive resize observations.

## Related Documentation

- [Embed UI](embed-ui.md)
- [Implementation specification](specification.md)
- [Quality and testing](quality-and-testing.md)
- [Rendering and performance](rendering-and-performance.md)
- [Obsidian integration](obsidian-integration.md)
