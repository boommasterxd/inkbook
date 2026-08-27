# File Format and Geometry

## Authority

The editable snapshot is the semantic source of truth only inside a fully canonical envelope. SVG drawing elements are a derived static representation, but they protect externally edited or damaged files from silent replacement: if validated snapshot data and canonical static SVG paths disagree, Inkbook keeps the file static and read-only and does not rewrite it. This is the stricter safe-envelope rule used to resolve any apparent conflict between snapshot authority and external-viewer fidelity.

## SVG Envelope

The required XML structure, standalone page surface, portable light and dark palette, strict static-markup allowlist, and external-viewer contract are defined in [Standalone SVG Envelope and Theme Rendering](svg-envelope.md). This document defines the editable snapshot and canonical geometry carried by that envelope.

## Snapshot Root

```ts
interface InkSnapshotV1 {
  format: "inkbook";
  version: 1;
  revision: number;
  page: PageV1;
  elements: InkElementV1[];
}

interface PageV1 {
  innerWidth: 2000;
  margin: 24.3;
  background: BackgroundV1;
  activeBufferLines: number;
  lockedBufferLines: number;
}

type BackgroundV1 =
  | { type: "none" }
  | { type: "lines"; spacing: 25 | 33.333333333333336 | 50 | 100 }
  | { type: "dots"; spacing: 25 | 33.333333333333336 | 50 | 100 }
  | { type: "squares"; spacing: 25 | 33.333333333333336 | 50 | 100 };
```

The 2,000-unit width is the patterned writing area. The 24.3-unit margin surrounds it on every side and is writable. The total SVG width is therefore exactly 2,048.6 page units.

Page values are copied from vault defaults when the file is created. Background changes are file commands. Later vault-default changes never alter this `PageV1` implicitly. Current writers use the shared absolute 25, 100 / 3, 50, and 100 page-unit series for every patterned background. The serialized IEEE-754 value for 100 / 3 is `33.333333333333336`; layout treats it as exactly three intervals per canonical 100-unit row. The fixed 100-unit layout step is an implementation and format invariant rather than redundant per-file state. `activeBufferLines` is an integer from 1 through 8, and current writers emit the canonical locked value `1`.

Element coordinates use the outer SVG's top-left corner as `(0, 0)`. Positive `x` points right and positive `y` points down. Elements may extend into the margin but MUST remain within the enforced numeric limits.

## Shared Types

```ts
interface PointV1 {
  x: number;
  y: number;
}

type StrokeSamplesV1 = number[];

type ColorV1 = { type: "theme-text" } | { type: "rgba"; value: `#${string}` };

interface ElementBaseV1 {
  id: string;
  createdAt: number;
  rotation: number;
  pivot: PointV1;
}

interface StrokeStyleV1 {
  color: ColorV1;
  width: 2 | 4 | 8 | 14 | 22;
  opacity: number;
  pressureEnabled: boolean;
  smoothing: 0.5;
}

interface OutlineStyleV1 {
  outlineColor: ColorV1;
  outlineWidth: 1 | 2 | 4 | 8 | 12;
  outlineOpacity: number;
  outlineStyle: "solid" | "dashed" | "dotted";
}

interface ShapeStyleV1 extends OutlineStyleV1 {
  fillColor: ColorV1 | null;
  fillOpacity: number;
}
```

Validation rules:

- All numbers MUST be finite.
- Snapshot revision is a non-negative safe integer.
- Opacity and pressure are in the inclusive range `0..1`. Version 1 stroke smoothing is exactly `0.5`.
- Canonical geometry and rotation are rounded on command commit to at most three decimal places. Pressure and opacity in the editable JSON snapshot are rounded to at most four decimal places. Generated SVG opacity attributes retain at most four decimal places; every other numeric SVG attribute retains at most three, as defined by the [standalone SVG envelope](svg-envelope.md#strict-static-markup-allowlist). Negative zero is stored and serialized as zero. Anchor resolution uses canonical geometry before connected endpoints are committed.
- Rotation is stored in clockwise degrees normalized to `[-180, 180)`.
- Rotation is applied around the stored page-space pivot. New strokes, linear elements, closed shapes, and tables use their unrotated bounds center. Coordinate systems use their origin.
- IDs are lowercase UUID v4 strings and unique within the document.
- `createdAt` is a non-negative integer Unix timestamp in milliseconds.
- RGBA colors use exactly `#RRGGBBAA`.
- `theme-text` is preserved semantically and resolves through the versioned portable light and dark document palette in [Standalone SVG Envelope and Theme Rendering](svg-envelope.md). It never captures a transient Community-theme value.

The `elements` array is partitioned into two fixed render bands. All highlighter and straight-highlighter elements appear first in back-to-front highlight order. Every other element follows in back-to-front content order. Writers MUST emit this partitioned order and readers reject an element in the highlight band after content has begun. This keeps every highlight below every content element without a separate persisted layer field.

Arrange commands change only array order inside a render band. Frontward means toward a larger array index. Determine selected runs once from the original band, then apply one stable pass:

- Bring forward replaces every original `[selected run, next unselected element]` with `[next unselected element, selected run]`.
- Send backward replaces every original `[previous unselected element, selected run]` with `[selected run, previous unselected element]`.
- Bring to front uses a stable partition that places unselected elements first and selected elements last.
- Send to back uses the inverse stable partition.

A mixed selection applies the same operation independently to both bands in one command. Relative selected order is preserved. A boundary no-op does not change revision or history.

For example, with back-to-front order `[A*, B, C*, D, E]`, where `*` is selected, Bring forward produces `[B, A*, D, C*, E]`. Send backward on `[A, B*, C, D*]` produces `[B*, A, D*, C]`.

## Element Union

```ts
type InkElementV1 =
  | StrokeElementV1
  | LinearElementV1
  | BoxShapeElementV1
  | CoordinateSystemElementV1
  | TableElementV1;
```

### Freehand Strokes

```ts
interface StrokeElementV1 extends ElementBaseV1 {
  kind: "stroke";
  tool: "pen" | "highlighter";
  points: StrokeSamplesV1;
  style: StrokeStyleV1;
}
```

- Stroke samples are flat `x, y, pressure` triples. The array length is divisible by three and contains between 1 and 4,096 triples.
- The wire array is validated before conversion to one runtime-owned `Float64Array` per execution boundary. Published typed buffers are write-once despite the mutable platform type; geometry changes allocate a replacement buffer. Live capture uses a geometrically growing numeric buffer and the committed record receives one exact copy.
- A single-point stroke renders as a round dot using its effective width.
- Pen pressure comes from hardware when available and from the deterministic simulated-pressure function otherwise.
- Highlighter strokes set `pressureEnabled` to `false`.
- Point coordinates are canonical page-space geometry. A committed move updates them directly; only a gesture preview uses a temporary transform.

### Lines, Arrows, and Straight Highlighters

```ts
interface LinearBaseV1 extends ElementBaseV1 {
  start: PointV1;
  end: PointV1;
  bend: PointV1 | null;
}

interface EndpointConnectionV1 {
  targetId: string;
  anchor: ShapeAnchorV1;
}

type BoxAnchorV1 =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-right"
  | "bottom-right"
  | "bottom-center"
  | "bottom-left"
  | "middle-left";

type ShapeAnchorV1 =
  | { kind: "box"; position: BoxAnchorV1 }
  | { kind: "ellipse-cardinal"; angle: 0 | 90 | 180 | 270 }
  | { kind: "polygon-vertex"; index: number }
  | { kind: "polygon-edge-midpoint"; index: number }
  | { kind: "coordinate-origin" }
  | { kind: "coordinate-axis-end"; index: number };

interface ConnectableLinearBaseV1 extends LinearBaseV1 {
  startConnection: EndpointConnectionV1 | null;
  endConnection: EndpointConnectionV1 | null;
}

interface LineElementV1 extends ConnectableLinearBaseV1 {
  kind: "line";
  startNode: "none";
  endNode: "none";
  style: OutlineStyleV1;
}

interface ArrowElementV1 extends ConnectableLinearBaseV1 {
  kind: "arrow";
  startNode: ArrowNodeV1;
  endNode: ArrowNodeV1;
  style: OutlineStyleV1;
}

interface StraightHighlighterElementV1 extends LinearBaseV1 {
  kind: "straight-highlighter";
  bend: null;
  startNode: "none";
  endNode: "none";
  style: StrokeStyleV1;
}

type LinearElementV1 = LineElementV1 | ArrowElementV1 | StraightHighlighterElementV1;
type ArrowNodeV1 = "none" | "arrow" | "triangle" | "diamond" | "circle";
```

- `bend` is the control point of a quadratic Bézier curve.
- Lines and arrows use `OutlineStyleV1`. Straight highlighters use `StrokeStyleV1`.
- Straight highlighters always use `bend: null` and both nodes set to `none`.
- Straight-highlighter style always uses `pressureEnabled: false` and `smoothing: 0.5`.
- Lines default to both nodes set to `none`.
- Arrows default to `startNode: "none"` and `endNode: "arrow"`.
- Node size is `max(12, outlineWidth * 4)` page units and does not grow when the element is scaled.
- A linear drag stores the pointer-down point as `start` and the pointer-up point as `end`. Its minimum length is 8 page units. A shorter non-zero drag extends in its drag direction; a zero-length drag extends right.
- Straight highlighters have no connection fields. Lines and arrows initialize both connections to `null` unless an endpoint snaps.

Outline rendering is exact: Solid has no dash array; Dashed uses `[4 * outlineWidth, 3 * outlineWidth]`; Dotted uses round caps and `[0, 2.5 * outlineWidth]`. For a bent line, endpoint direction uses the normalized quadratic tangent, `bend - start` at the start and `end - bend` at the end; otherwise it uses `end - start`. Reverse the direction for a start node so every node points away from the line body.

For node size `s`, outward unit direction `u`, and perpendicular `n`, node geometry is:

- Arrow: two open segments from the endpoint to `endpoint - s * rotate(u, +30 degrees)` and `endpoint - s * rotate(u, -30 degrees)`.
- Triangle: filled polygon `[endpoint, endpoint - s * u + 0.5 * s * n, endpoint - s * u - 0.5 * s * n]`.
- Diamond: filled polygon `[endpoint, endpoint - 0.5 * s * u + 0.5 * s * n, endpoint - s * u, endpoint - 0.5 * s * u - 0.5 * s * n]`.
- Circle: filled circle of radius `s / 2` centered at `endpoint - 0.5 * s * u`.

Filled nodes use the outline color and opacity. The line body ends at the node endpoint and remains visible below an open Arrow node.

### Endpoint Connections

An endpoint connection targets only a closed shape, coordinate system, or table. Strokes, highlighters, lines, and arrows are never targets, so connection cycles are impossible. Anchor validity is exact:

- rectangle and table use every `box` position
- ellipse uses `ellipse-cardinal` at 0, 90, 180, or 270 degrees
- triangle, diamond, parallelogram, and octagon use each valid `polygon-vertex` and `polygon-edge-midpoint` index
- coordinate systems use `coordinate-origin` and each current `coordinate-axis-end` index

`box` positions use the named corners and side midpoints of the unrotated bounds. Ellipse angles are clockwise in page coordinates: the user-facing points are 90 at the bottom, 180 at the left, 270 at the top, and 360 at the right; persisted 360 is canonicalized to 0. Polygon indices use the normalized vertex order defined below; edge midpoint `i` lies halfway from vertex `i` to vertex `(i + 1) mod vertexCount`. Coordinate-axis indices are zero-based positions in `axes`.

The deterministic semantic anchor order is: `box` positions in their `BoxAnchorV1` declaration order; ellipse angles 0, 90, 180, 270; polygon vertices by ascending index before polygon edge midpoints by ascending index; coordinate origin before axis endpoints by ascending index. Equal-distance candidates compare frontmost render rank, target ID, then this anchor order.

Resolve an anchor in the target's unrotated canonical geometry, then rotate it clockwise around the target pivot. `start` and `end` store the last successfully resolved page point and MUST equal the current resolved anchor within 0.001 page units while connected. A dangling target, incompatible anchor kind, invalid index, or mismatched resolved point makes a file invalid and read-only.

The store maintains a derived reverse map from target ID to `{ linearId, endpoint }` references. A target move, scale, rotation, shape-handle edit, axis edit, or table geometry edit resolves only its dependents, updates their endpoint coordinates, bounds, path caches, and spatial-index records, then commits the target and dependents atomically. The bend remains in page coordinates. During a live target gesture, visible dependent paths update in the same frame without tweening.

Bounds and geometry validation treat the target and all re-resolved dependents as one atomic candidate. Anchors and dependent bounds are recomputed from the exact proposed target transform. No target or dependent receives an edge correction. If any resulting line or arrow is shorter than 8 page units, or the complete candidate violates geometry, resource, or derived-height limits, the complete command is rejected. Connected linear geometry therefore never needs a zero-vector node-direction fallback.

Dragging a connected endpoint previews a free point. Release on a valid candidate replaces the connection; release elsewhere stores `null` and the free point. Moving an entire line or arrow moves its bend and free endpoints; connected endpoints remain at their anchors. Removing a target first replaces every dependent connection with `null` at its last resolved endpoint in the same removal command. Undo and Redo restore both records atomically.

For a multi-selection containing both a target and its dependent line or arrow, apply the selection transform once to the target, bend, and free endpoints, then resolve connected endpoints from the final target geometry. This order prevents double translation.

### Closed Shapes

```ts
interface BoxShapeElementV1 extends ElementBaseV1 {
  kind: "rectangle" | "ellipse" | "triangle" | "octagon" | "parallelogram" | "diamond";
  x: number;
  y: number;
  width: number;
  height: number;
  style: ShapeStyleV1;
}
```

- Width and height are positive and at least 1 page unit.
- Rotation occurs around the bounds center.
- Dragging a closed shape in any direction sets `x = min(start.x, end.x)`, `y = min(start.y, end.y)`, `width = max(1, abs(end.x - start.x))`, and `height = max(1, abs(end.y - start.y))`.
- Normalized vertices are triangle `[(0.5,0),(1,1),(0,1)]`, diamond `[(0.5,0),(1,0.5),(0.5,1),(0,0.5)]`, and parallelogram `[(0.2,0),(1,0),(0.8,1),(0,1)]`. For an octagon, let `i = min(width,height) * 0.293`, `rx = i / width`, and `ry = i / height`; its vertices are `[(rx,0),(1-rx,0),(1,ry),(1,1-ry),(1-rx,1),(rx,1),(0,1-ry),(0,ry)]`.
- The parallelogram horizontal inset is 20 percent of width.
- The octagon corner inset is `min(width, height) * 0.293`.
- Scaling changes bounds and vertex positions, never outline width.

### Coordinate Systems

```ts
interface CoordinateSystemBaseV1 extends ElementBaseV1 {
  kind: "coordinate-system";
  origin: PointV1;
  style: OutlineStyleV1;
}

type CoordinateSystemElementV1 = CoordinateSystemBaseV1 &
  (
    | { dimension: "2d"; axes: [PointV1, PointV1] }
    | { dimension: "3d"; axes: [PointV1, PointV1, PointV1] }
  );
```

- Each axis value is its arrow endpoint in page coordinates.
- Creation sets the drag start as `origin`. Let `dx = end.x - start.x` and `dy = end.y - start.y`. The x-axis vector is `(signedMinimum(dx, 40), 0)` and the y-axis vector is `(0, signedMinimum(dy, 40))`; a zero component uses `+200` for x and `-200` for y. `signedMinimum(value, 40)` preserves the non-zero sign and clamps its absolute value to at least 40.
- A new 3D system adds endpoint `origin - 0.5 * (xAxisVector + yAxisVector)`. With the default axes this is a 141.421-unit diagonal down and left.
- Every axis ends with an arrow node. Axes have no fill.
- The origin and endpoints have individual edit handles.
- Scaling changes the endpoint distances from the origin and never changes outline width.
- Changing from 3D to 2D removes the third endpoint within the same undoable style command. Changing back sets the third endpoint to `origin - 0.5 * (firstAxisVector + secondAxisVector)`.
- Before a 3D-to-2D change removes axis index 2, every connection to that endpoint is detached at its last resolved point. The dimension change, detachment, reverse-map update, and dependent records are one atomic command; Undo restores the axis and connections.
- When one command targets several selected coordinate systems, it applies the requested absolute dimension independently. Systems already at that dimension remain unchanged. All changed systems, connection detachments or resolutions, bounds, reverse-map entries, and dependent records validate and commit atomically; if every target is unchanged, the command is a no-op.

### Tables

```ts
interface TableElementV1 extends ElementBaseV1 {
  kind: "table";
  x: number;
  y: number;
  columnWidth: number;
  height: number;
  columns: number;
  headerHeight: number;
  style: OutlineStyleV1;
}
```

- A table is one atomic element made from one outer rectangle, equal-width vertical column separators, and one horizontal header separator.
- It contains no row separators and no editable text.
- Column count is an integer from 1 through 12 and defaults to 3.
- `columnWidth` is canonical persisted geometry. Total table width is always derived as `columns * columnWidth` and is not stored separately. Minimum column width is 40 page units. Minimum total height is 80 page units.
- Header height defaults to 30 percent of total height and is clamped to `24..height / 2`.
- For table creation, let `sx = end.x >= start.x ? 1 : -1` and `sy = end.y >= start.y ? 1 : -1`. Canonicalize `columnWidth = max(abs(end.x - start.x) / columns, 40)` once, then derive `width = columns * columnWidth`. Set `height = max(abs(end.y - start.y), 80)`, `x = sx > 0 ? start.x : start.x - width`, and `y = sy > 0 ? start.y : start.y - height`. Crossing the start point therefore changes the expanding direction without producing negative dimensions. The derived width may differ from the raw drag width by the canonical rounding of one column, but every column remains exactly equal.
- For a column-count edit from `columns` to `newColumns`, retain the canonical `columnWidth` unchanged and derive `oldWidth = columns * columnWidth` and `newWidth = newColumns * columnWidth`. Adding columns therefore extends the local right side, while removing columns removes local rightmost columns and shrinks the table. The command does not redistribute the retained columns across the old total width, and repeated count changes cannot accumulate column-width drift.
- The rendered local left edge is the fixed anchor of a column-count edit. Let `R` rotate a vector clockwise by `rotation`, `oldPivot` be the pre-command pivot, and `deltaWidth = newWidth - oldWidth`. Calculate the unrounded candidate `newPivot = oldPivot + R({ x: deltaWidth / 2, y: 0 })`, `newX = newPivot.x - newWidth / 2`, and `newY = newPivot.y - height / 2`, then apply the normal canonical rounding once to the resulting stored coordinates. At zero rotation, `newX` equals the previous `x`. After canonicalization, each endpoint of the rendered left edge MUST remain within 0.003 page units of its immediately preceding position. This bound covers the worst-case independent three-decimal rounding of the pivot and bounds coordinates for one edit over the complete rotation range.
- A column-count edit preserves `y` only at zero rotation and always preserves height, header height, rotation, style, outline width, and the persisted `columnWidth`. It validates the `1..12` range, the 40-page-unit minimum column width, finite numbers, canonical rounding, the per-edit fixed-edge tolerance, resource limits, derived height, and every connected dependent before commit. If the complete result is invalid, the command is rejected without changing the table, revision, or history.
- When one command targets several selected tables, it applies the requested absolute column count independently while preserving each table's own persisted `columnWidth`. Changed tables and all affected line or arrow dependents commit atomically. A table already at the requested count remains unchanged; if every target is unchanged, the command is a no-op.
- Scaling changes bounds, separators, `columnWidth`, and header height proportionally, never outline width.

## Transform Rules

- Snapshot geometry is canonical page-space geometry. No translation, scale, or transform matrix is persisted. Rendering applies the stored clockwise rotation around `pivot` after reading canonical geometry.
- Gesture previews MAY use one temporary SVG transform. A commit materializes the result once and removes the preview transform.
- Move by vector `d` adds `d` to every geometry point and to `pivot`. For bounds-based elements it adds `d.x` to `x` and `d.y` to `y`. Rotation is unchanged.
- Single-element scaling is performed in the element's unrotated local frame around the opposite handle `anchor`. Unrotate the start and current pointer by `-rotation` around the current pivot, compute `sx = (current.x - anchor.x) / (start.x - anchor.x)` and `sy = (current.y - anchor.y) / (start.y - anchor.y)`, and clamp each factor before it reaches zero so every documented minimum remains satisfied. Every canonical point becomes `anchor + (sx * (point.x - anchor.x), sy * (point.y - anchor.y))`; bounds and table fields are derived from those transformed corners. The pivot is recomputed from the result. Handle crossing never mirrors an element.
- Multi-element scaling is uniform only. Let `anchor` be the opposite selection-bounds corner and `s = max(minimumScale, distance(anchor,currentPointer) / distance(anchor,startPointer))`, where `minimumScale` is the greatest per-element factor needed to retain every documented minimum. The session derives `minimumScale` once from the immutable gesture-start selection and reuses it for every preview and commit slice. Every geometry point and pivot becomes `anchor + s * (value - anchor)`. Bounds, table header height, and axis lengths scale by `s`; each element's rotation is unchanged.
- Single-element rotation adds the gesture angle delta to `rotation`; geometry and pivot remain unchanged. Multi-element rotation uses the selection-bounds center `c`: each element's canonical geometry and pivot first move by `rotate(pivot - c, delta) + c - pivot`, then its normalized `rotation` increases by `delta`.
- Endpoint, bend, axis, dedicated shape-handle, coordinate-system dimensionality, and table column-count edits update their named canonical fields directly and recompute the pivot where the element kind requires a bounds center. Editing a connected endpoint follows the connection rules above. Coordinate-system pivot always equals its origin. Structural edits use the kind-specific geometry rules above rather than a selection-scale transform.
- Style widths, node sizes, and eraser radius never change through geometric scaling. Invalid or degenerate results are clamped before commit.

## Bounds

Every element provides a conservative axis-aligned page-space bounding box that includes:

- transformed geometry
- half the maximum visible stroke or outline width
- arrow or endpoint-node extents
- curve extrema
- rotation around the element pivot

The spatial index, viewport culling, eraser candidate lookup, selection bounds, and page extent MUST use the same bounds implementation. Approximation is allowed only when it overestimates. Visible content must never be clipped or culled because of an underestimated bound.

Committed conservative bounds may extend beyond the fixed `0..2048.6` horizontal viewport or above `y = 0`. Creation, paste, move, rotate, scale, style, structural, and handle-edit commits preserve the exact canonical geometry and never translate a candidate merely to bring it back into view. The active canvas and standalone SVG viewport clip every outside portion visually. If a partially visible annotation is moved inward later, the preserved outside geometry becomes visible again.

All bounds remain subject to canonical coordinate, element, spatial-index membership and overflow, file-size, and maximum-derived-height limits. Bounds and geometry validation still treat every explicitly changed target and all re-resolved dependents as one atomic candidate. Positive-y geometry participates in downward page expansion; horizontal and negative-y overflow do not expand the viewport.

## Page Extent

The file does not persist editor or preview height as independent state. Both are derived from validated elements and the per-file `PageV1`.

```text
layoutStep = 100
bufferUnit = layoutStep
occupiedBottom = page.margin when elements is empty,
                 otherwise max(page.margin, maximum element bounds maxY)
occupiedRows = ceil(max(0, occupiedBottom - page.margin) / layoutStep)
activeWritableBottom = page.margin
  + (occupiedRows + page.activeBufferLines) × layoutStep
lockedWritableBottom = page.margin
  + (occupiedRows + 1) × layoutStep
activeHeight = activeWritableBottom + page.margin
lockedHeight = lockedWritableBottom + page.margin
```

These heights always end on a complete writing row. Background type and spacing are absent from the formula, so changing None, Lines, Dots, Squares, or S/M/L/XL cannot resize unchanged content. A non-empty locked page ends after exactly one complete writing row beyond the row containing the lowest element. An empty file keeps the 2.5-writing-line minimum rounded upward to a complete writing row in both states. The complete rectangular page, including its top, right, bottom, and left margins, is writable. Guides use one fixed inner frame while committed bounds may occupy a margin. Content entering the bottom margin grows the writing-row-aligned writable extent and retains a complete margin below it.

Version 1 files produced by earlier Inkbook builds may contain either the background-spacing-aligned locked height or the older exact height derived from `lockedBufferLines × bufferUnit`. The loader accepts only those exact historical derivations or the current writing-row derivation and verifies all static paths against the supplied height. A historical-height unlock schedules one full canonical export without requiring a content edit; Lock flushes that rewrite if it has not completed. The replacement retains the document revision, uses the normal expected-base and read-back verification path, and requires no migration backup because the snapshot schema version is unchanged. Arbitrary heights remain invalid.

Earlier version 1 files may also contain the preceding inset, top-anchored, or vertically centered background guide geometries. The loader accepts only a complete deterministic historical background fragment derived from the validated snapshot and supplied supported height; element paths and every other envelope component remain subject to the normal exact checks. A successful historical-background unlock marks the document for the same verified canonical rewrite without changing its revision. Unknown, partially modified, or mixed historical geometry remains invalid.

Runtime height changes only after committed geometry or page commands:

- On activation, set the current height to `activeHeight`.
- Grow to the recomputed `activeHeight` when `occupiedBottom` enters the final `bufferUnit` of the current writable extent.
- Shrink to the recomputed `activeHeight` when it is at least one `bufferUnit` below the current height.
- A background type or spacing command never changes height. Other page settings adopt the recomputed height only when they participate in the writing-row formula.
- Lock always targets the exact recomputed `lockedHeight`; unlock always targets the exact recomputed `activeHeight`.
- Selection edge-drag is the only pre-commit exception: when the pointer enters the final 24 CSS pixels at the container bottom, extend the transient writable bottom by exactly one `bufferUnit`. Do not extend again until the 180-millisecond transition completes and the pointer remains in that edge zone. This session-only extension changes no snapshot, revision, or history.
- Selection release commits geometry and transitions to the recomputed `activeHeight`. Cancellation transitions to the height that existed before the gesture. No other pointer sample changes a height target.
- During any transition, a new target starts from the currently rendered height.

## Clipboard Format

- Logical MIME type: `application/x-inkbook-elements+json;version=1`. The Async Clipboard custom-format key is `web application/x-inkbook-elements+json;version=1`, using the standards-defined `web ` prefix.
- Plain-text fallback starts with `Inkbook elements v1:` followed by the same compact JSON.
- The payload type is:

```ts
interface ClipboardEndpointConnectionV1 {
  targetClipId: string;
  anchor: ShapeAnchorV1;
}

type ClipboardElementBodyV1<T> = T extends LineElementV1 | ArrowElementV1
  ? Omit<T, "id" | "createdAt" | "startConnection" | "endConnection"> & {
      startConnection: ClipboardEndpointConnectionV1 | null;
      endConnection: ClipboardEndpointConnectionV1 | null;
    }
  : Omit<T, "id" | "createdAt">;

interface ClipboardElementV1 {
  clipId: string;
  element: ClipboardElementBodyV1<InkElementV1>;
}

interface InkClipboardV1 {
  format: "inkbook-elements";
  version: 1;
  elements: ClipboardElementV1[];
}
```

- Copy assigns compact unique `clipId` values in selection order, removes `id` and `createdAt`, and preserves geometry, style, render-band order, and relative positions. A connection whose target is selected becomes `targetClipId`; a connection to an unselected target becomes `null` at its resolved endpoint.
- Paste first validates `InkClipboardV1` against clipboard limits. It maps every `clipId` to a new UUID, assigns `createdAt = pasteCommandTimestamp`, resolves connection targets through that complete map, translates the group, validates the resulting document limits, and commits atomically. Pasted elements enter the front of their respective render bands while retaining clipboard order. A failed step changes nothing.
- The prefixed system custom format takes precedence over the system `text/plain` representation, which takes precedence over the in-session fallback, when each candidate validates. Copy attempts to construct a `ClipboardItem` with the custom format directly and catches construction or write failure; `ClipboardItem.supports()` is not a feature gate for web custom formats. A synchronous custom-format construction failure immediately falls back to a `text/plain`-only write within the same user activation, and every path retains the validated in-session payload.
- Codec execution, operation identity, revision synchronization, and worker fallback are defined in [Rendering and Performance](rendering-and-performance.md#document-worker-autosave-and-export).

## Limits

Files exceeding a limit open read-only and are never rewritten automatically.

| Limit                           |                 File |            Clipboard |
| ------------------------------- | -------------------: | -------------------: |
| Total input bytes               |               64 MiB |                8 MiB |
| Snapshot metadata bytes         |               60 MiB |                8 MiB |
| Elements                        |               20,000 |                5,000 |
| Freehand strokes                |               15,000 |                4,000 |
| Total stroke points             |            2,000,000 |              500,000 |
| Points per stroke               |                4,096 |                4,096 |
| Connected endpoints             |               20,000 |                5,000 |
| Connected endpoints per target  |                  512 |                  128 |
| Spatial-index overflow elements |                  512 |                  128 |
| Spatial-index cell memberships  |              262,144 |              262,144 |
| JSON entries in one container   |               20,000 |               12,288 |
| Absolute coordinate             | 1,000,000 page units | 1,000,000 page units |
| Maximum derived height          | 1,000,000 page units |       Not applicable |

The standard 10,000-stroke fixture MUST serialize to at most 32 MiB of compact snapshot metadata and at most 48 MiB for the complete SVG. CI records total bytes, metadata bytes, static-markup bytes, and bytes per stroke point. The stress fixture is accepted only when it satisfies the hard byte limits above; otherwise it is rejected by byte limits before any full domain or path-cache allocation.

Before XML parsing, reject input above the total byte limit. Reject `DOCTYPE`, entity declarations, processing instructions, and any snapshot metadata section above its byte limit. Extract only the single required metadata text with a bounded non-networked streaming XML tokenizer and reject XML errors or duplicate snapshot metadata. The tokenizer compares supplied static groups with canonical generated fragments and discards supplied path text incrementally; it never joins or retains the complete SVG. The synchronous fallback runs a string-aware structural pass before native `JSON.parse()`; the production load uses the bounded chunked parser, which rejects duplicate keys before assigning them. Both enforce container width and nesting depth before materializing another child value. Validate the parsed unknown value iteratively with the remaining depth and count budgets, compare current-version decoded metadata exactly with canonical compact reserialization, and verify its root SHA-256 consistency binding before constructing domain records or path caches. JSON parsing necessarily allocates its parsed representation; the requirement is to avoid additional complete metadata strings, domain arrays, and derived geometry until validation succeeds.

JSON nesting deeper than 16 levels, a container wider than its table limit, duplicate IDs, unknown discriminators, unknown required enum values, non-finite numbers, and invalid ranges are rejected. Structural scans ignore braces, brackets, commas, quotes, and backslashes inside strings. String decoding uses one reusable 16,384-code-unit UTF-16 scratch block, so retained fragments grow with decoded output blocks rather than escape count. Validation MUST NOT first materialize a sibling-key or sibling-frame array proportional to hostile input width. The parser may retain at most one input string, one parsed representation, bounded parser scratch, and the validated domain snapshot at a time; it releases temporary data before generating paths.

Browser clipboard materialization and receiver-side worker batch limits are defined at their execution boundaries in [Rendering and Performance](rendering-and-performance.md#document-worker-autosave-and-export); the schema limits in this document remain authoritative for decoded document and clipboard content.

## Versioning and Migration

- Writers emit version 1 only.
- Inkbook may display a replacement preview for a newer unsupported version only after its static SVG passes the same exact element-and-attribute allowlist as generated output; otherwise it leaves the custom Markdown link noninteractive or replaces its owned presentation with a non-rendering placeholder. The document cannot be edited.
- Version 0 uses the same envelope, snapshot fields, ordering, connections, and canonical geometry as version 1 except that both the root `data-inkbook-version` and snapshot `version` are `0` and the root omits `data-inkbook-snapshot-sha256`. Its only migration changes the snapshot discriminator to `1`. The first version 1 save adds the canonical metadata hash; the version 1 exact-text and hash requirements do not block loading the supported legacy source.
- Older supported versions migrate in memory through sequential pure migrations in the document worker during unlock. Every adjacent step validates its complete output before the next step begins. Runtime batches and the export baseline are created only after the migrated current-version result passes schema and byte, depth, container, element, geometry, and connection limits. Cancellation applies between migration and validation slices. The equivalent bounded main-thread fallback uses the same registry, checkpoints, limits, and failure result when workers are unavailable.
- Before the first write that would replace a successfully migrated document, preserve the exact original content as `<base>.backup-v<old-version>.svg`. Creation uses the public Vault boundary and is read back before replacement. If that collision-safe path already exists, it is accepted only when its content exactly equals the original; Inkbook never replaces a different existing backup. The verified backup is required exactly once per adopted migrated source.
- Migration or unlock cancellation leaves the original untouched and the presentation static/read-only. Backup creation or verification failure prevents the version 1 replacement and leaves the session in recovery-required state with the original still untouched.
- Unknown properties in the current schema are rejected rather than silently discarded.

## Related Documentation

- [Implementation specification](specification.md)
- [Core model](core-model.md)
- [Editor tools](editor-tools.md)
- [Rendering and performance](rendering-and-performance.md)
- [Standalone SVG envelope and theme rendering](svg-envelope.md)
- [Settings](settings.md)
- [Quality and testing](quality-and-testing.md)
