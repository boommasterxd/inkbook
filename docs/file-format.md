# File Format and Geometry

## Authority

The validated editable snapshot is the semantic source of truth. Unlock validates the complete safe SVG envelope, metadata integrity, schema, and resource limits without reconstructing static drawing geometry. A safe static preview may differ from the snapshot: the active scene renders the snapshot, and the next ordinary save replaces the derived SVG with canonical output. Merely opening such a file does not force a repair save. Unsupported markup, invalid metadata, and exceeded limits still prevent editing. The explicitly bounded [stylesheet compatibility forms](svg-envelope.md#portable-light-and-dark-palette) and supported [snapshot-version migration](#versioning-and-migration) retain their canonical-rewrite requirements. Canonical export and output verification remain separate from source loading.

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

The types below describe the logical snapshot used by domain code and clipboard codecs. The stored stroke-sample representation is defined separately under [Disk Metadata Encoding](#disk-metadata-encoding).

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
  outlineWidth: 1 | 2 | 4 | 8 | 12 | 14 | 22;
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
- Current editors create outline widths from the same `2, 4, 8, 14, 22` XS-through-XL scale as pen strokes. Readers continue to accept legacy outline widths `1` and `12` so existing version 1 documents retain their exact appearance.

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
  offset?: PointV1;
  style: StrokeStyleV1;
}
```

- Stroke samples are flat `x, y, pressure` triples. The array length is divisible by three and contains between 1 and 16,384 triples.
- Legacy JSON sample arrays are validated before conversion to a runtime-owned `Float64Array`; compact disk samples decode directly into an exact-size typed buffer before semantic validation. Published typed buffers are write-once despite the mutable platform type; changes to the stroke shape allocate a replacement buffer. Translation retains the buffer. Live capture keeps a bounded two-sample raw state alongside the retained canonical triples; the committed record receives one exact copy of those triples.
- A single-point stroke renders as a round dot using its effective width.
- Pen pressure comes from hardware when available and from the deterministic simulated-pressure function otherwise.
- Highlighter strokes set `pressureEnabled` to `false`. New live highlighter samples use canonical pressure `0` without pressure simulation; reading or exporting existing samples does not rewrite their pressure values.
- Pressure is retained in the editable samples. The continuous-pressure filled path and its once-composited opacity group are derived output under the [standalone SVG contract](svg-envelope.md#strict-static-markup-allowlist); the representation adds no snapshot fields.
- Point coordinates describe the retained stroke shape. An omitted `offset` means zero and preserves the interpretation of existing files. Before rotation, add `offset` to each point; rotate that result around the world-space `pivot`. A committed move changes only `offset` and `pivot`, retaining points and style. Resizing may materialize new points and omit the offset.
- Offset coordinates use the same canonical precision and finite coordinate limits as other geometry. Both stored samples and translated coordinates must remain within the supported range. The optional field extends version 1: current readers accept existing files without rewriting their absent offset, but older strict readers reject files containing the new field. Install the updated plugin on every device before editing translated strokes across devices. See [Retained Stroke Shape and Position](decisions/retained-stroke-position.md).

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
  | { kind: "coordinate-axis-end"; index: number }
  | { kind: "linear-endpoint"; endpoint: "start" | "end" };

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
  startNode: "none";
  endNode: "none";
  style: StrokeStyleV1;
}

type LinearElementV1 = LineElementV1 | ArrowElementV1 | StraightHighlighterElementV1;
type ArrowNodeV1 = "none" | "arrow" | "triangle" | "diamond" | "circle";
```

- `bend` is the control point of a quadratic Bézier curve.
- Lines and arrows use `OutlineStyleV1`. Straight highlighters use `StrokeStyleV1`.
- Straight highlighters default to `bend: null` and both nodes set to `none`; their bend may be stored as a page-space quadratic control point after editing.
- Straight-highlighter style always uses `pressureEnabled: false` and `smoothing: 0.5`.
- Lines default to both nodes set to `none`.
- Arrows default to `startNode: "none"` and `endNode: "arrow"`.
- Node size is `min(max(12, outlineWidth * 4), distance(start, end))` page units. Nodes shrink with short geometry and disappear at zero length; scaling never enlarges them beyond the style-derived size.
- A linear drag stores the pointer-down point as `start` and the pointer-up point as `end`. There is no minimum length; a zero-length drag retains coincident endpoints and renders as a point.
- Straight highlighters have no connection fields. Lines and arrows initialize both connections to `null` unless an endpoint snaps.

Point geometry uses round caps without a dash array. Non-point geometry uses the round caps and exact dash arrays defined in the [element contour rules](editor-tools.md#shapes). For a bent line, endpoint direction uses the normalized quadratic tangent, `bend - start` at the start and `end - bend` at the end; otherwise it uses `end - start`. Reverse the direction for a start node so every node points away from the line body.

For node size `s`, outward unit direction `u`, and perpendicular `n`, base node geometry is:

- Arrow: two open segments from the endpoint to `endpoint - s * rotate(u, +30 degrees)` and `endpoint - s * rotate(u, -30 degrees)`.
- Triangle: filled polygon `[endpoint, endpoint - s * u + 0.5 * s * n, endpoint - s * u - 0.5 * s * n]`.
- Diamond: filled polygon `[endpoint, endpoint - 0.5 * s * u + 0.5 * s * n, endpoint - s * u, endpoint - 0.5 * s * u - 0.5 * s * n]`.
- Circle: filled circle of radius `s / 2` centered at `endpoint - 0.5 * s * u`.

The [element contour rules](editor-tools.md#shapes) define the visible rounded exterior of filled nodes, including the circle's expanded radius, and the symmetric pattern restart of open arrowheads. Filled nodes use the outline color and opacity. The line body ends at the node endpoint and remains visible below an open Arrow node.

### Endpoint Connections

An endpoint connection targets a closed shape, coordinate system, table, line, or arrow. Strokes and highlighters are never targets. Line and arrow targets expose their two endpoint anchors. A connection to the same linear element or any target that would create a directed connection cycle is invalid. Anchor validity is exact:

- rectangle and table use every `box` position
- ellipse uses `ellipse-cardinal` at 0, 90, 180, or 270 degrees
- triangle, diamond, parallelogram, and octagon use each valid `polygon-vertex` and `polygon-edge-midpoint` index
- coordinate systems use `coordinate-origin` and each current `coordinate-axis-end` index
- lines and arrows use `linear-endpoint` with `endpoint` set to `start` or `end`

`box` positions use the named corners and side midpoints of the unrotated bounds. Ellipse angles are clockwise in page coordinates: the user-facing points are 90 at the bottom, 180 at the left, 270 at the top, and 360 at the right; persisted 360 is canonicalized to 0. Polygon indices use the normalized vertex order defined below; edge midpoint `i` lies halfway from vertex `i` to vertex `(i + 1) mod vertexCount`. Coordinate-axis indices are zero-based positions in `axes`.

The deterministic semantic anchor order is: `box` positions in their `BoxAnchorV1` declaration order; ellipse angles 0, 90, 180, 270; polygon vertices by ascending index before polygon edge midpoints by ascending index; coordinate origin before axis endpoints by ascending index. Equal-distance candidates compare frontmost render rank, target ID, then this anchor order.

Resolve an anchor in the target's unrotated canonical geometry, then rotate it clockwise around the target pivot. `start` and `end` store the last successfully resolved page point and MUST equal the current resolved anchor within 0.001 page units while connected. A dangling target, incompatible anchor kind, invalid index, cycle, or mismatched resolved point makes a file invalid and read-only.

The store maintains a derived reverse map from target ID to `{ linearId, endpoint }` references. A target move, scale, rotation, shape-handle edit, axis edit, or outer table geometry edit resolves only its dependents, updates their endpoint coordinates, bounds, path caches, and spatial-index records, then commits the target and dependents atomically. Header and inner separator edits do not change outer table anchors and therefore do not visit reverse dependencies. The bend remains in page coordinates. During a live target gesture, visible dependent paths update in the same frame without tweening within the [exact-preview work limits](quality-and-testing.md#performance-architecture-rules). Larger targeted handle cohorts retain the edited line's immediate local feedback until their complete atomic commit.

Bounds and geometry validation treat the target and all re-resolved dependents as one atomic candidate. Anchors and dependent bounds are recomputed from the exact proposed target transform. No target or dependent receives an edge correction. Connected endpoints may coincide, including when a target transform collapses a connected line or arrow to a point; collapsed geometry has no arrow node. If the complete candidate violates geometry, resource, or derived-height limits, the complete command is rejected.

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

- Width and height are nonnegative with no minimum size. Zero-size geometry remains valid.
- Rotation occurs around the bounds center.
- Dragging a closed shape in any direction sets `x = min(start.x, end.x)`, `y = min(start.y, end.y)`, `width = abs(end.x - start.x)`, and `height = abs(end.y - start.y)`, with canonical rounding and no positive minimum extent.
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
- Creation sets the drag start as `origin`. Let `dx = end.x - start.x` and `dy = end.y - start.y`. The x-axis vector is `(dx, 0)` and the y-axis vector is `(0, dy)`, with no minimum or fallback extent.
- A new 3D system adds endpoint `origin - 0.5 * (xAxisVector + yAxisVector)`.
- Every nonzero axis ends with an arrow node bounded by its length, using the linear node-size rule above. Collapsed axes have no arrow node. Axes have no fill.
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
  columnOffsets?: number[];
}
```

- A table is one atomic element made from inner vertical column separators and one horizontal header separator. It has a logical outer rectangle for bounds, selection, culling, scaling, and connection anchors, but that rectangle is not rendered or hit-tested as painted table geometry. New tables start with equal-width columns; edited tables may retain explicit separator offsets.
- It contains no row separators and no editable text.
- Column count is an integer from 1 through 12. The built-in Table tool default is 2.
- `columnWidth` is canonical persisted geometry. Total table width is always derived as `columns * columnWidth` and is not stored separately. Column width and total height are nonnegative with no minimum size.
- `columnOffsets`, when present, contains exactly `columns - 1` nondecreasing local x positions in the inclusive range `0..columns * columnWidth`. Equal offsets and offsets on either logical outer edge are valid. Its absence is the equal-column representation, where separators are derived from `columnWidth`.
- Initial header height is `min(max(24, height * 0.25), height / 2)`, rounded to canonical precision and reduced by 0.001 if rounding would exceed half the height. Later separator editing accepts the inclusive logical range `0..height`.
- For table creation, let `sx = end.x >= start.x ? 1 : -1` and `sy = end.y >= start.y ? 1 : -1`. Canonicalize `columnWidth = abs(end.x - start.x) / columns` once, then derive `width = columns * columnWidth`. Set `height = abs(end.y - start.y)`, `x = sx > 0 ? start.x : start.x - width`, and `y = sy > 0 ? start.y : start.y - height`. Crossing the start point therefore changes the expanding direction without producing negative dimensions. The derived width may differ from the raw drag width by the canonical rounding of one column, but every column remains exactly equal.
- For a column-count edit from `columns` to `newColumns`, retain the canonical `columnWidth` unchanged and derive `oldWidth = columns * columnWidth` and `newWidth = newColumns * columnWidth`. Adding columns therefore extends the local right side, while removing columns removes local rightmost columns and shrinks the table. The command does not redistribute the retained columns across the old total width, and repeated count changes cannot accumulate column-width drift.
- The rendered local left edge is the fixed anchor of a column-count edit. Let `R` rotate a vector clockwise by `rotation`, `oldPivot` be the pre-command pivot, and `deltaWidth = newWidth - oldWidth`. Calculate the unrounded candidate `newPivot = oldPivot + R({ x: deltaWidth / 2, y: 0 })`, `newX = newPivot.x - newWidth / 2`, and `newY = newPivot.y - height / 2`, then apply the normal canonical rounding once to the resulting stored coordinates. At zero rotation, `newX` equals the previous `x`. After canonicalization, each endpoint of the rendered left edge MUST remain within 0.003 page units of its immediately preceding position. This bound covers the worst-case independent three-decimal rounding of the pivot and bounds coordinates for one edit over the complete rotation range.
- A column-count edit preserves `y` only at zero rotation and always preserves height, header height, rotation, style, outline width, and the persisted `columnWidth`. It validates the `1..12` range, nonnegative column width, finite numbers, canonical rounding, the per-edit fixed-edge tolerance, resource limits, derived height, and every connected dependent before commit. If the complete result is invalid, the command is rejected without changing the table, revision, or history.
- When one command targets several selected tables, it applies the requested absolute column count independently while preserving each table's own persisted `columnWidth`. Changed tables and all affected line or arrow dependents commit atomically. A table already at the requested count remains unchanged; if every target is unchanged, the command is a no-op.
- Scaling changes bounds, separators, `columnWidth`, and header height proportionally, never outline width. Table header and inner separator edits snap briefly to the default header position or equal spacing. Otherwise they clamp only to the logical outer rectangle. A vertical separator may cross another separator; offsets are stored in nondecreasing visual order.

## Transform Rules

- Snapshot geometry uses canonical page-space coordinates, except for retained stroke samples with the optional position offset defined above. Scale and general transform matrices are not persisted. Rendering adds a stroke offset before applying the stored clockwise rotation around the world-space `pivot`.
- Gesture previews MAY use one temporary SVG transform. A commit records the result once and removes the preview transform; a pure stroke move updates position without materializing new samples.
- Move by vector `d` adds `d` to stroke `offset` and `pivot`, retaining the samples. For other elements it adds `d` to every geometry point and to `pivot`. For bounds-based elements it adds `d.x` to `x` and `d.y` to `y`. Rotation is unchanged.
- Single-element scaling is performed in the element's unrotated local frame around the opposite handle `anchor`. Unrotate the start and current pointer by `-rotation` around the current pivot, compute `sx = (current.x - anchor.x) / (start.x - anchor.x)` and `sy = (current.y - anchor.y) / (start.y - anchor.y)`, and clamp each factor at zero without imposing a positive minimum. Every canonical point becomes `anchor + (sx * (point.x - anchor.x), sy * (point.y - anchor.y))`; bounds and table fields are derived from those transformed corners. The pivot is recomputed from the result. Handle crossing never mirrors an element.
- Multi-element scaling uses the active selection frame and its immutable gesture-start anchor. Free scaling resolves a nonnegative factor for each frame axis; uniform scaling projects pointer displacement onto the gesture-start handle direction. Factors derive from geometric frame extents without paint margins. There is no positive minimum scale and handle crossing never mirrors geometry. Bounds and structural fields follow the resolved geometric transform while element rotations and paint widths remain unchanged; representability limits for differently rotated boxes follow [Editor Tools](editor-tools.md#select).
- Single-element rotation adds the gesture angle delta to `rotation`; geometry and pivot remain unchanged. Multi-element rotation uses the active selection-frame center `c`: each element's canonical geometry and pivot first move by `rotate(pivot - c, delta) + c - pivot`, then its normalized `rotation` increases by `delta`. The ephemeral frame rotates by the same delta and remains authoritative for overlay orientation and later group snapping until selection membership changes. It is not persisted in the document.
- Endpoint, bend, axis, dedicated shape-handle, coordinate-system dimensionality, and table column-count or separator edits update their named canonical fields directly and recompute the pivot where the element kind requires a bounds center. Editing a connected endpoint follows the connection rules above. Coordinate-system pivot always equals its origin. Structural edits use the kind-specific geometry rules above rather than a selection-scale transform.
- Axis endpoint edits use an absolute 45-degree angular snap. Line and arrow creation and endpoint edits use an absolute 90-degree angular snap. Both use the active zoom to convert a 5 CSS-pixel screen threshold; semantic anchors take precedence. Screen-length activation and guide visibility follow [Editor Tools](editor-tools.md#select).
- Style widths and eraser radius never change through geometric scaling. Node sizes remain bounded by their style-derived size and shrink to fit short geometry. Zero dimensions and coincident endpoints are valid; negative dimensions and nonfinite results are rejected before commit.

## Bounds

Every element provides a conservative axis-aligned page-space bounding box that includes:

- transformed geometry
- half the maximum visible stroke or outline width
- arrow or endpoint-node extents
- curve extrema
- rotation around the element pivot

The spatial index, viewport culling, eraser and area-selection candidate lookup, and page extent MUST use the same conservative painted bounds implementation. Approximation is allowed only when it overestimates. Visible content must never be clipped or culled because of an underestimated bound.

Selection transform frames use separate geometric bounds without half-width expansion, as defined in [Editor Tools](editor-tools.md#select). These decorative frame bounds never replace conservative painted bounds or change area-selection inclusion predicates.

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
minimumEmptyRows = 3 when elements is empty, otherwise 0
activeRows = max(occupiedRows + page.activeBufferLines, minimumEmptyRows)
activeWritableBottom = page.margin + activeRows × layoutStep
lockedStep = layoutStep when elements is empty or background.type is none,
             otherwise background.spacing
lockedOccupiedRows = ceil(max(0, occupiedBottom - page.margin) / lockedStep)
lockedWritableBottom = page.margin + 3 × layoutStep when elements is empty,
                       otherwise page.margin + (lockedOccupiedRows + 1) × lockedStep
activeHeight = activeWritableBottom + page.margin
lockedHeight = lockedWritableBottom + page.margin
```

Active height always ends on a complete 100-unit writing row and remains independent of background type and spacing. A non-empty patterned locked page ends after exactly one complete pattern row beyond the pattern row containing the lowest element. A non-empty locked page without a visible pattern uses one complete 100-unit writing row beyond the occupied writing row. An empty file keeps the 2.5-writing-line minimum rounded upward to a complete 100-unit writing row in both states. The complete rectangular page, including its top, right, bottom, and left margins, is writable. Guides use one fixed inner frame while committed bounds may occupy a margin. Content entering the bottom margin grows the writing-row-aligned active extent and retains a complete margin below it.

The loader accepts only the exact current writing-row-derived height. It checks supplied background paths for safe structure and limits, without reconstructing their canonical geometry. Canonical export and output verification require the exact generated background.

Runtime height changes only after committed geometry or page commands:

- On activation, set the current height to `activeHeight`.
- Grow to the recomputed `activeHeight` when `occupiedBottom` enters the final `bufferUnit` of the current writable extent.
- Shrink to the recomputed `activeHeight` when it is at least one `bufferUnit` below the current height.
- A background type or spacing command never changes active height. It updates the derived locked target and the next persisted SVG envelope. Other page settings adopt the recomputed height only when they participate in the corresponding formula.
- Lock always targets the exact recomputed `lockedHeight`; unlock always targets the exact recomputed `activeHeight`.
- Selection move previews and selection autoscroll may coalesce only larger writing-row-aligned canvas targets through the bounded 180-millisecond transition. They never acquire passive scroll stabilization while the active input owns scrolling and never request a smaller preview target during the gesture.
- A successful selection move commit retains the greater of the final rendered preview extent and the Store-derived extent. Cancellation transitions back to the captured original height, while a no-op that requested no larger preview leaves height unchanged. The final canvas height must never be smaller than committed geometry.
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
- On read, the prefixed system custom format takes precedence over the system `text/plain` representation, which takes precedence over the in-session fallback, when each candidate validates. Copy writes one `text/plain`-only `ClipboardItem` during the initiating user activation because that well-known format is the interoperable system representation and already contains the complete prefixed Inkbook payload. The optional standards-prefixed custom format remains read-compatible but is not written because unsupported custom types may reject the complete multi-format operation. Every write path retains the validated in-session payload, and a failed standard system write is reported without attempting a late retry after activation.
- Codec execution, operation identity, revision synchronization, and worker fallback are defined in [Rendering and Performance](rendering-and-performance.md#document-worker-autosave-and-export).

## Limits

Files exceeding a limit open read-only and are never rewritten automatically. The increased per-stroke capacity keeps the version 1 sample representation; older builds enforcing 4,096 points cannot edit strokes above their own limit. Aggregate document and clipboard limits still apply.

| Limit                           |                 File |            Clipboard |
| ------------------------------- | -------------------: | -------------------: |
| Total input bytes               |               64 MiB |                8 MiB |
| Snapshot metadata bytes         |               60 MiB |                8 MiB |
| Elements                        |               20,000 |                5,000 |
| Freehand strokes                |               15,000 |                4,000 |
| Total stroke points             |            2,000,000 |              500,000 |
| Points per stroke               |               16,384 |               16,384 |
| Connected endpoints             |               20,000 |                5,000 |
| Connected endpoints per target  |                  512 |                  128 |
| Spatial-index overflow elements |                  512 |                  128 |
| Spatial-index cell memberships  |              262,144 |              262,144 |
| JSON entries in one container   |               49,152 |               49,152 |
| Absolute coordinate             | 1,000,000 page units | 1,000,000 page units |
| Maximum derived height          | 1,000,000 page units |       Not applicable |

The standard 10,000-stroke fixture MUST serialize to at most 32 MiB of compact snapshot metadata and at most 48 MiB for the complete SVG. CI records total bytes, metadata bytes, static-markup bytes, and bytes per stroke point. The stress fixture is accepted only when it satisfies the hard byte limits above; otherwise it is rejected by byte limits before any full domain or path-cache allocation.

Before XML parsing, reject input above the total byte limit. Reject `DOCTYPE`, entity declarations, processing instructions, and any snapshot metadata section above its byte limit. Extract only the single required metadata text with a bounded non-networked streaming XML tokenizer and reject XML errors or duplicate snapshot metadata. For unlock without a current trusted preview proof, the tokenizer checks supplied static groups against the safe SVG allowlist without generating replacement geometry. A proof may skip only this repeated scan after a fresh full-file read and matching byte length and SHA-256; its ownership and mismatch behavior are defined in [Snapshot-Authoritative Unlock and Output Reuse](decisions/validated-unlock-geometry-reuse.md). Strict canonical parsing used for output verification separately compares supplied groups with generated fragments. It discards supplied path text incrementally; it never joins or retains the complete SVG. The worker and main-thread fallback use the same bounded chunked parser, rejecting duplicate keys before assigning them and enforcing container width and nesting depth before materializing another child value. Validate the parsed unknown value semantically with the remaining depth and count budgets; a single-use proof from the exclusively owned parser root may reuse its structural facts. For compact stroke samples, successful decoding may also attach the decoded numeric extrema to that same proof and exact sample-buffer identity. Semantic validation consumes those extrema once only after consuming the matching root proof, and still checks current point counts, aggregate capacity, coordinate limits, and translated extrema. Missing, stale, mismatched, or already consumed proof state follows the complete numeric sample scan. Verify the root SHA-256 consistency binding over the original decoded metadata before constructing domain records or path caches, and reserve exact compact-reserialization comparison for strict canonical output verification. JSON parsing necessarily allocates its parsed representation; the requirement is to avoid additional complete metadata strings, domain arrays, and derived geometry until validation succeeds.

JSON nesting deeper than 16 levels, a container wider than its table limit, duplicate IDs, unknown discriminators, unknown required enum values, non-finite numbers, and invalid ranges are rejected. Structural scans ignore braces, brackets, commas, quotes, and backslashes inside strings. String decoding uses one reusable 16,384-code-unit UTF-16 scratch block, so retained fragments grow with decoded output blocks rather than escape count. Validation MUST NOT first materialize a sibling-key or sibling-frame array proportional to hostile input width. The parser may retain at most one input string, one parsed representation, bounded parser scratch, and the validated domain snapshot at a time; it releases temporary data before generating paths.

Browser clipboard materialization and receiver-side worker batch limits are defined at their execution boundaries in [Rendering and Performance](rendering-and-performance.md#document-worker-autosave-and-export); the schema limits in this document remain authoritative for decoded document and clipboard content.

## Disk Metadata Encoding

Current writers emit `data-encoding="json-varint-v1"`. Root and snapshot format version remain `1`; only each stored stroke's `points` field changes from a numeric array to a canonical Base64 string. All other snapshot fields and the logical sample triples remain unchanged. Clipboard JSON retains numeric arrays.

The sample writer uses one fixed 256-byte ASCII staging buffer. String output decodes completed chunks into Base64 string parts; the independent main-thread integrity digest instead receives exact ASCII byte chunks from the same validating codec, without a Base64 string or native text conversion for the samples. Neither path stages a complete binary stroke or constructs intermediate strings for every quartet. Byte output retains exact chunk copies and joins them into an exactly sized buffer, reusing a single chunk directly when possible. Final byte copying checks the caller's central scheduler after each 64 KiB with more copying pending; sample cancellation checkpoints remain unchanged. Staging-buffer flushes themselves are storage boundaries, not scheduler handoffs.

The decoded byte stream contains an unsigned LEB128 point count followed by three unsigned LEB128 values per point: ZigZag-encoded x delta, ZigZag-encoded y delta, and pressure. Coordinates are exact integer thousandths; deltas use the preceding point, starting at `(0, 0)`. Pressure is an integer in `0..10000`, representing ten-thousandths. ZigZag maps a nonnegative delta `n` to `2 * n` and a negative delta to `-2 * n - 1`. This encoding preserves canonical sample values without simplification or compression.

Readers require the standard Base64 alphabet, exact padding and zero unused bits, no whitespace, and no trailing bytes. Each varint uses at most five bytes, is at most `4,000,000,000`, and has no redundant terminal zero byte. Before allocating `Float64Array(pointCount * 3)`, the decoder checks encoded length, the `1..16384` point count, remaining document point capacity, and plausible payload size. Accumulated coordinates retain the absolute 1,000,000-page-unit bound and pressure retains `0..1`; full schema, aggregate, offset, geometry, and connection checks still follow.

Readers continue to accept `data-encoding="json"` with flat numeric triples. Opening or unlocking legacy JSON metadata does not itself require a rewrite, version migration, or backup. The next ordinary save emits the compact encoding. Supported snapshot-version migrations and non-current stylesheet rewrites retain their separate rules below and in [Standalone SVG Envelope](svg-envelope.md#portable-light-and-dark-palette). Older readers that accept only `json` cannot edit compact files; update every device before saving them. The decision and verification boundaries are recorded in [Compact Stroke Metadata](decisions/compact-stroke-metadata.md).

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
