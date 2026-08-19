# SVG Rendering

## 1. Decision

Inkbook retains the performant SVG rendering model. SVG is the interactive retained rendering layer for plugin-owned elements. The sidecar scene is canonical; SVG DOM, paths, bounds, hit regions, and caches are derived and disposable.

The plugin MUST NOT serialize arbitrary SVG markup as its authoritative document model. It serializes validated element records and reconstructs safe SVG nodes.

## 2. Scene Layers

Each view adapter maintains these logical layers:

1. background, implemented with CSS gradients outside the element scene;
2. translucent highlighter elements;
3. opaque strokes, shapes, free or attached lines and arrows, axes, and tables;
4. transient gesture preview;
5. selection, anchor, endpoint, resize, rotate, and curve chrome.

Canonical z-order is explicit within each compatible scene plane. DOM order alone MUST NOT be the authority.

Text-range line fragments and enclosing regions are disposable view projections of one canonical element. Every projection retains the source element ID and a stable key derived from the binding revision, host-layout revision, presentation, and fragment ordinal. A projection MUST NOT become a separate selectable or persisted element.

## 3. Stroke Representation

Canonical strokes retain their accepted input samples, including note coordinates, timestamp delta, and pressure where supported. Samples are appended to immutable bounded chunks. Bounds, point counts, resource admission, compact-encoding state, and multi-resolution render levels are updated incrementally as samples arrive. Coalesced Pointer Events SHOULD be consumed to improve fidelity without increasing event dispatch overhead.

Constant-width pen and highlighter strokes SHOULD use native SVG paths with `stroke`, `stroke-linecap`, and `stroke-linejoin`. Pressure-varying pen strokes SHOULD use a generated filled outline path. Render-side simplification MAY reduce path complexity for a zoom level, but it MUST NOT delete canonical samples.

Long active strokes MUST be extended incrementally or in bounded chunks. Rebuilding a path from all prior samples on every pointer event is forbidden because it becomes quadratic. Pointer-up finalization is `O(1)` or proportional only to newly sealed chunks. Raw long-stroke geometry MUST never be regenerated for every frame or continuous zoom value.

Every stroke longer than 4,096 samples MUST maintain deterministic multi-resolution render paths. Continuous zoom values map to a bounded set of stable level-of-detail buckets. Level changes may replace a derived path but never canonical samples.

Reflowable Highlighter and underline presentations MAY derive different visible fragments from the current text layout. The renderer MUST preserve the canonical source element and samples while replacing only binding-dependent projection nodes.

## 4. Shapes and Construction Objects

Shapes are stored as semantic geometry and style, not raw SVG strings. Resizing a shape changes its geometry while preserving outline width in note units.

For local half-extents `hx = width / 2` and `hy = height / 2`, Rectangle uses the four corners `(±hx, ±hy)`, Ellipse uses `x^2 / hx^2 + y^2 / hy^2 = 1`, Triangle uses `(0, -hy)`, `(hx, hy)`, and `(-hx, hy)`, and Diamond uses `(0, -hy)`, `(hx, 0)`, `(0, hy)`, and `(-hx, 0)`. For Octagon, let `a = sqrt(2) - 1`; its clockwise CSS-plane vertices are `(-a*hx, -hy)`, `(a*hx, -hy)`, `(hx, -a*hy)`, `(hx, a*hy)`, `(a*hx, hy)`, `(-a*hx, hy)`, `(-hx, a*hy)`, and `(-hx, -a*hy)`. These definitions own rendering, fill containment, narrow-phase hit testing, lasso coverage, bounds, and port projection so those subsystems cannot diverge.

A shape resolves `ShapeStyleV1.opacity` only to its outline paint and resolves a solid `ShapeStyleV1.fill.opacity` only to its fill paint. Retained SVG uses independent allowlisted stroke and fill opacity attributes and MUST NOT place both paints under one shared group opacity. Changing either value updates only that selected element's retained paint attributes and affected style revision; it does not regenerate geometry, rebuild unrelated elements, or alter the other opacity.

Line and Arrow store two free or attached endpoints plus an optional finite quadratic curve control point in canonical note coordinates. A missing curve control point denotes straight geometry. Both store independent start and end caps plus dash pattern. Selection chrome edits the same canonical endpoints, attachments, and curve field. Preview, cancellation, hit testing, spatial-index bounds, and retained rendering MUST use the applicable canonical definition and MUST NOT rebuild unrelated scene elements.

Tables and axes use the closed canonical geometry records in [Sidecar Persistence](07-sidecar-persistence.md) and render to derived SVG groups. A Table frame and its ordered row and column divider offsets are computed in its local oriented rectangle, then transformed around its canonical center by `rotationRadians`. One Table produces at most a bounded outer-frame path, one composed row-divider path, and one composed column-divider path rather than a node per cell or divider.

At fixed whole-note zoom, local resize is forbidden from multiplying any SVG stroke width, pressure-derived outline width, dash length, or marker size. A committed resize materializes new semantic coordinates or dimensions while reusing the exact style record and style revision. During preview, an implementation MAY use a temporary local transform only when native strokes use non-scaling-stroke behavior or an equivalent separated transform that preserves note-unit width. A pressure-varying filled outline MUST NOT be scaled directly; the renderer transforms a bounded centerline or level-of-detail representation and regenerates the outline from unchanged pressure samples and style. The transform MUST be materialized into canonical geometry on commit and removed on cancellation. Whole-note zoom remains an outer presentation transform and therefore still scales the complete visual note, including line widths.

For a Table, whole-object resize changes local frame dimensions and proportionally maps divider offsets into the replacement frame. Divider drag changes exactly one canonical offset and the two adjacent track sizes. Neither operation changes track count, border-line width, divider-line width, dash pattern, or style revision. Divider drag also preserves the outer frame dimensions. For axes, a positive-end length edit replaces only one vector magnitude while preserving its unit direction, the shared origin, and every inter-axis angle. Rigid rotation rotates all stored vectors together. Axis, guide, and cap style remains unchanged.

An axes vector `v` renders exactly one segment from origin `O` to `O + v`. No negative half-axis or tick mark is derived in V1. The configured positive-end cap is applied only at `O + v`; no cap is rendered at `O`. For `gridDivisions = 0`, only the two or three axis segments and their positive-end caps are rendered.

For `gridDivisions = N` from 1 through 64, each unordered axis-vector pair `(u, v)` additionally renders these exact interior guide segments for every integer `i` from 1 through `N - 1`:

- `O + (i / N) * u` to `O + (i / N) * u + v`;
- `O + (i / N) * v` to `O + (i / N) * v + u`.

Pairs are processed in the fixed order `x-y` for 2D and `x-y`, `x-z`, `y-z` for 3D. Coincident segments from different pairs are retained in that order and are not deduplicated. A 2D axes object therefore renders exactly `2 * (N - 1)` interior guides, and a 3D axes object exactly `6 * (N - 1)`. Axis and guide commands MUST be batched into bounded composed paths and remain subject to the global path-command budget. Derived cells, paths, caps, and grid intersections have no independent element identity, binding, selection, or sidecar record.

Every SVG attribute MUST be produced from a closed allowlist. Raw `innerHTML`, event-handler attributes, scripts, `foreignObject`, external URLs, and arbitrary CSS values are forbidden.

An element with enclosure presentation derives its current bounds from the resolved text-fragment envelope and stored margins. The renderer maps the closed construction shape or confidently closed freehand geometry into those bounds without changing canonical geometry. A circle MAY therefore appear elliptical after reflow. Outline width remains constant in note units.

Definitions such as markers and clip paths MUST use view-scoped unique IDs. Two panes rendering the same note MUST not resolve SVG URL references against each other's definitions.

### 4.1 Selection Geometry

Selection control geometry is distinct from paint bounds and spatial-index broad-phase bounds:

- a Line or Arrow derives endpoint and attachment handles plus its curve handle from the actual segment or quadratic curve and has no area frame;
- a Pen or Highlighter stroke derives an oriented rectangular area frame from canonical sample bounds and stored `selectionRotationRadians`; a fixed-width stroke may preview a width-preserving retained-centerline transform, while a pressure-varying Pen regenerates its selected-element outline from transformed bounded centerline or level-of-detail data without changing pressure or style; commit materializes transformed sample coordinates and the absolute frame orientation;
- a closed shape or Table derives one oriented rectangular area frame from local canonical geometry, and a transformable Table additionally derives constrained hit corridors and handles for its internal dividers; when its `text-range` presentation derives visible geometry from an enclosure envelope, the frame remains selectable but exposes no resize or rotation controls;
- a 2D or 3D axes object derives one separate oriented linear control bound and positive-end length handle for each axis, plus a shared move target and rigid-rotation handle, with no common area-resize frame;
- a persisted Group derives its aggregate rectangular frame in stored `selectionRotationRadians`; a transient multi-selection derives a zero-oriented aggregate frame from the union of member control geometry.

Paint bounds include the current line width, caps, and conservative hit tolerance. The spatial index MAY store an axis-aligned envelope of paint bounds for broad-phase lookup, but that envelope MUST NOT become selection chrome or resize authority. Control frames, handles, paint bounds, and index envelopes are disposable view projections and MUST NOT be serialized.

An area or persisted-Group selection frame renders at its current canonical orientation, not at a newly computed axis-aligned angle. During rotation preview it uses the current snapped or unsnapped absolute angle from `ROTATION_SNAP_PROFILE_V1`. Deselecting and reselecting reconstructs the same orientation from canonical geometry or Group state. Only the broad-phase spatial-index envelope remains axis-aligned.

Control geometry MUST be derived from canonical records and cached geometry, not repeated DOM layout reads. `getBBox()`, `getBoundingClientRect()`, and equivalent per-element DOM measurement are forbidden during pointer-move resize. A zero-width or zero-height stroke bound is expanded only for screen-space control chrome; the corresponding canonical scale handle is disabled until the stroke has nonzero extent. Handle visuals and effective hit targets remain screen-space sized; canonical object geometry remains in unzoomed note coordinates.

## 5. Viewport Culling

The logical overlay spans the entire note, but the mounted SVG DOM MUST cover only the viewport plus bounded overscan. The renderer MUST query a spatial index in `O(log N + k)` expected time for `k` returned candidates rather than scan every scene element on each scroll or zoom frame. One query continuation processes at most 2,048 candidates and at most 4 ms before yielding. Larger result sets resume from an immutable query token and publish no partial canonical mutation. Incremental insert, update, and removal SHOULD remain `O(log N)` expected time.

The spatial index is updated incrementally from operation affected bounds. Rebuilding it for the full scene on every mutation is forbidden.

The initial long-note target is at most 250 individually interactive canonical element projections, 4,000 total mounted SVG DOM nodes, and 100,000 rendered path commands, even when the sidecar contains 10,000 elements. DOM-node and path-command counters include selection and preview chrome and exclude only the constant-size icon sprite. A compound path counts as one DOM node, every SVG path command counts individually, and every source element represented by that path is recorded separately as an aggregated source rather than an individual projection. A frame processes at most 200 mount, unmount, or geometry-replacement changes before yielding. Tables, grids, axes, and repeated caps MUST use composed paths, symbols, or another bounded representation instead of one unbounded node per cell or line.

If a dense viewport cannot remain inside the DOM or path budget, only contiguous compatible runs in canonical z-order may be aggregated into style-, binding-, and anchor-grouped compound paths. Aggregation MUST preserve the source element ID and derived-fragment key, the exact z-order of incompatible or interleaved content, and semantic hit testing through the spatial index. If aggregation still exceeds the limit, the adapter enters a visible read-only progressive-render state and continues bounded work across frames. It MUST NOT silently omit geometry or accept mutations against an incomplete projection. Supported 5,000- and 10,000-element capacity fixtures MUST reach truthful hit-test readiness and full mutation readiness within the calibrated release budgets; an indefinitely progressive state fails capacity acceptance.

## 6. Hit Testing

Visible plugin objects use geometry-aware hit testing with a screen-space tolerance appropriate to pointer type. Broad phase uses the spatial index; narrow phase uses stroke distance, fill containment, line distance, or handle geometry.

Curved Line and Arrow hit testing and bounds MUST use their complete quadratic curve. Table and axes hit testing addresses the complete semantic construction element even when its visible geometry is emitted as several composed paths.

Endpoint snap candidates come only from the spatial-index query around the pointer's 12-CSS-pixel screen tolerance, followed by exact current-view port projection and deterministic narrow-phase ordering. Pointer movement updates the active Line or Arrow preview, eligible port indicators, and reverse-indexed dependent previews only. It MUST NOT scan every scene element, rebuild the attachment index, or route candidate changes through React.

Table rendering, spatial bounds, lasso coverage, hit testing, resize handles, and selection chrome MUST use the same local-frame-to-note transform defined by `center` and `rotationRadians`. No subsystem may approximate a rotated Table as its axis-aligned bounding box except for spatial-index broad-phase candidate lookup.

Touch targets MAY be larger than rendered geometry. A hit on a plugin-owned element routes to selection before an active drawing tool. Transparent root overlay regions MUST use pass-through pointer behavior so unclaimed note interactions remain native.

The lasso MUST query the spatial index by lasso bounds and then apply exact geometry or the documented coverage rule. It MUST never inspect or select Obsidian text DOM.

## 7. Gesture Rendering

During pointer movement:

- canonical scene state remains unchanged;
- preview transforms and paths update imperatively or through an equivalently bounded render path;
- React or another UI framework MUST NOT rerender the complete note scene for every sample;
- no sidecar write occurs;
- at most one animation-frame render is queued.

A single-object resize, attached-endpoint drag, Table-divider, or axis-length preview updates only that object's retained projection, bounded nearby port indicators where applicable, reverse-indexed dependents, and selection chrome. Pressure-varying Pen preview may replace only that selected element's derived outline and MUST discard stale worker generations. An aggregate resize updates one transient group transform plus one aggregate frame for compatible mounted projections. Mounted pressure-varying Pen members use one coalesced, revision-bound worker batch that transforms cached level-of-detail centerlines and regenerates derived outlines from unchanged pressure and style; offscreen members are not preview-generated. At most one latest aggregate pressure-preview request is queued per view, and stale results are discarded. Commit may materialize work proportional to affected members in cancellable worker chunks before one atomic publication, but never to unrelated scene elements.

Pointer up for element creation or destination movement of a non-fixed element freezes the gesture's Markdown and layout token and performs bounded binding inference. Movement of a `fixed` element preserves its binding. Pointer up for resize or rotation performs only the current-binding validation permitted by [Anchors and Layout](05-anchors-and-layout.md), never classification. Exactly one operation is published only when every required token remains current. It invalidates only affected bounds and caches. Pointer cancellation or stale inference or validation removes preview state, restores the prior SVG projection, and publishes nothing.

## 8. Cache Policy

Canonical path and pressure-outline caches MUST key by stable element ID, element geometry revision, style revision, and relevant render scale. Binding projection, bounds, and hit-shape caches additionally key by binding revision and host-layout revision. Text-position movement MUST reuse canonical geometry caches. Text-range reflow invalidates only affected projection and spatial-index entries.

Caches MUST have byte or entry budgets, least-recently-used eviction, and explicit disposal. The initial aggregate per-view geometry-cache budget is 8 MiB. A cache miss may reduce performance but MUST NOT change output or canonical state.

## 9. Worker and UI-Framework Boundaries

React or another component framework owns only coarse UI surfaces such as toolbar, stylebar, settings, menus, and status. Canonical annotation elements MUST NOT be one React component each. Pointer samples, gesture previews, scroll, zoom, culling, retained SVG-node updates, selection chrome, and worker progress MUST NOT be routed through React state or trigger a note-root render. UI subscriptions use narrow selectors, stable immutable references, and batched publication so an unrelated scene revision does not rerender toolbar controls. The performance harness records framework commit count and component render count for every critical workflow.

The retained renderer owns keyed SVG nodes and applies minimal imperative attribute or path updates from revision-bound projection diffs. It pools only resources with a measured benefit and a strict capacity. It performs no virtual-DOM reconstruction of the complete scene and no synchronous DOM read-after-write loop.

CPU-intensive DOM-independent work MUST use a bounded shared worker scheduler when the platform supports conforming workers. Required worker candidates include sidecar tokenization, validation, decoding and encoding; SHA-256 hashing through worker-exposed platform cryptography; migration; pressure-outline and level-of-detail generation; bulk bounds; spatial-index construction and large query continuation; lasso classification; aggregate transform materialization; large clipboard validation; and pure anchor, reflow, or background calculations after the main thread captures bounded layout evidence. DOM measurement, pointer arbitration, pointer capture, host API calls, minimal retained-node publication, and the final validated immutable scene swap remain on the main thread.

Worker use is performance-driven, not unconditional message passing. A calibrated task threshold keeps truly constant-time work on the main thread when serialization and transfer would cost more. All other eligible work is worker-first. Large geometry payloads use packed typed arrays and transferable ownership rather than repeated object cloning. Only worker-owned staging buffers may be transferred; a buffer reachable from the canonical scene, history, recovery state, or retained renderer MUST NOT be detached or exposed for shared mutation. Worker requests and responses are immutable, versioned, size-bounded, cancellable, and bound to scene and layout revisions. Stale results are discarded, newest-current work has priority, queues have hard limits, and cancellation is checked between chunks.

The scheduler creates no worker per element or view. Its concurrency is bounded by a calibrated device profile, never exceeds two workers on Android or four on desktop, and leaves at least one logical processor for the host when concurrency information is available. If workers are unavailable, the same algorithms run in cancellable main-thread slices of at most 2 ms during active interaction and 4 ms while idle. Loss or disposal of a worker rejects or safely reschedules owned work and releases transferred buffers, listeners, ports, and timers.

## 10. Rendering Performance Budgets

Budgets are initial engineering targets and MUST be calibrated on named real devices before release. `F` is the measured refresh interval of the named device and display configuration.

| Scenario                                                                     | Desktop or Android tablet target |      Android phone target |
| ---------------------------------------------------------------------------- | -------------------------------: | ------------------------: |
| Drawing, scroll, or zoom main-thread work, p95                               |           at most 8 ms per frame |   at most 12 ms per frame |
| Drawing, scroll, or zoom main-thread work, p99                               |                less than 16.7 ms |         less than 16.7 ms |
| Input to next visibly presented preview frame, p95                           |        at most `max(16.7 ms, F)` | at most `max(33.4 ms, F)` |
| First visible overlay from a warm sidecar                                    |                   at most 300 ms |            at most 750 ms |
| Warm one-element sidecar save acknowledgement                                |                   at most 250 ms |            at most 750 ms |
| Single command synchronous publication                                       |                     at most 8 ms |             at most 12 ms |
| Single-object selection or resize preview in the 10,000-element fixture, p95 |                     at most 8 ms |             at most 12 ms |
| Write-ahead recovery append, p95                                             |                    at most 30 ms |             at most 75 ms |

No supported benchmark may create a main-thread task longer than 50 ms during active input. Performance claims require the benchmark protocol in [Quality and Performance](09-quality-and-performance.md).

## 11. V1 Compact Geometry Encoding

V1 sidecars and recovery records MUST use the exact `delta-varint-v1` record and byte layout owned by [Domain Model and Codecs](15-domain-model-and-codecs.md). Decoding is deterministic, streaming over the already bounded string, and allocation-aware. Unknown codecs or versions fail closed. Quantization MUST be tested against a maximum 0.005 note-unit position error and 0.0005 pressure error at the full zoom range.

The interactive capture limit is 100,000 accepted samples for the complete pointer gesture and its preview, recovery admission, and final operation. When the limit is reached, the adapter finalizes the gesture once, releases pointer capture, and requires a new pointer contact for another stroke. It MUST NOT continue the same gesture through hidden linked segments. Imported sidecars may contain up to the higher parser limit defined in [Sidecar Persistence](07-sidecar-persistence.md).
