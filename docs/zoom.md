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

## Zoom Input

The following controls work in the active handwriting embed:

- `Ctrl` or `Cmd` plus mouse wheel
- trackpad pinch
- `Ctrl` or `Cmd` plus `+`
- `Ctrl` or `Cmd` plus `-`
- two-finger pinch on a touchscreen

The keyboard shortcuts only take effect when the pointer is over the active canvas. Otherwise, the normal Obsidian zoom functions remain active.

One mouse-wheel or keyboard step changes the zoom by exactly a factor of 1.08. A modifier-key pixel event is treated as continuous trackpad input only while both axis magnitudes are below 16 pixels. Its magnitude uses a 2.5 responsiveness multiplier, equivalent to one 1.08 step per 6.4 pixels, so a small trackpad pinch follows the fingers without making mouse-wheel notches jump. Trackpad input is coalesced once per animation frame and never waits for a complete discrete wheel step. Larger pixel events plus line- and page-mode events are discrete mouse-wheel input and apply exactly one signed 1.08 step per event. Touch pinch keeps its direct distance ratio.

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

A one-finger gesture is horizontal when `abs(deltaX) >= 1.25 × abs(deltaY)` and vertical otherwise. Inkbook contains every canvas touch start and move before Obsidian's pane and drawer gesture handlers can latch it. At width fit the horizontal camera remains clamped at `0`; above fit the gesture visibly pans the page. A vertical gesture forwards its delta to the resolved native Obsidian scroll owner instead of introducing a nested canvas scroller. Terminal pointer and touch events remain visible to host cleanup. A next-task fallback releases captured touch state only after the complete terminal event has had an opportunity to commit, while interruption and a later primary contact still recover genuinely stale state.

Releasing a horizontal one-finger page pan above width fit starts bounded kinetic motion from the recent 120-millisecond screen-space movement window only when release speed reaches 100 pixels per second. Initial speed is capped at 4,000 pixels per second, velocity is multiplied by `0.92^(elapsedMs / (1000 / 60))`, and motion stops below 15 pixels per second. The elapsed-time formula keeps the same feel from 60 through 240 Hz. Momentum advances inside the existing coalesced camera animation frame, creates no second rendering loop, and stops immediately at a horizontal camera bound, on new pointer, wheel, keyboard-zoom, or pinch input, on resize or scroll-owner transfer, on lock or disposal, and after a frame interruption longer than 100 milliseconds. It never adds vertical momentum: Obsidian remains the sole vertical scroll owner.

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

A single frame may change the zoom by no more than a factor of 1.35. This prevents a quick pinch from causing a sudden jump.

The imperative scene renderer updates the camera transform, background grid, selection overlay, and scroll position in the same frame. It performs cached layout reads before calculations and DOM writes and does not notify React. A later committed camera change may update coarse UI state without changing scene geometry.

## Zoom When Locking

A locked preview always displays the full page width.

When a zoomed-in embed is locked, zoom and horizontal position begin returning to width fit while height changes to the locked target over 240 milliseconds. Lock, unlock, and content-driven height transitions suppress browser scroll anchoring on the resolved Obsidian scroll owner and retain the embed root's pre-transition viewport Y position. The bounded hold samples that single visual anchor once per animation frame and writes `scrollTop` only when host anchoring actually introduces drift. A host `scroll` event is corrected synchronously before the next paint, including bottom-pinning during locked-to-editor growth. Explicit wheel, touch-scroll, or scroll-key input transfers control to the user immediately.

After the exact saved preview is ready, it crossfades independently over 120 milliseconds as defined in [Quality and Testing](quality-and-testing.md). When reduced motion is enabled, the final camera, height, and preview state apply together without interpolation.

The current zoom and horizontal position are cached during the open session so that a widget remounted by CodeMirror does not lose its view. This session state is cleared when the embed is locked.

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
