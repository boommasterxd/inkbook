# Domain Model and Codecs

This document owns the canonical V1 annotation scene, element, style, attachment, revision, ordering, and compact stroke-codec contracts. [Sidecar Persistence](07-sidecar-persistence.md) owns the file envelope, storage, and save protocol. [Operations, Sessions, and Recovery](16-operations-sessions-and-recovery.md) owns mutations and runtime state transitions.

## 1. Scalar and Identity Types

All persisted numbers MUST be finite. Integer fields MUST be non-negative safe integers unless a narrower rule applies. Note coordinates are unzoomed CSS pixels and remain within the absolute limit in [Sidecar Persistence](07-sidecar-persistence.md).

```ts
export type ElementId = string & { readonly __brand: "ElementId" };
export type GroupId = string & { readonly __brand: "GroupId" };
export type SceneRevision = number & { readonly __brand: "SceneRevision" };
export type GeometryRevision = number & {
  readonly __brand: "GeometryRevision";
};
export type StyleRevision = number & { readonly __brand: "StyleRevision" };
export type BindingRevision = number & { readonly __brand: "BindingRevision" };

export interface NotePointV1 {
  readonly x: number;
  readonly y: number;
}

export interface NoteVectorV1 {
  readonly x: number;
  readonly y: number;
}
```

Persisted element IDs use `el_` followed by exactly 26 lowercase Crockford Base32 characters. Group IDs use `grp_` followed by the same payload. The alphabet is `0123456789abcdefghjkmnpqrstvwxyz`. The payload encodes exactly 128 random bits in big-endian order; the first character is from `0` through `7`. IDs are generated from platform cryptographic randomness, are never reused within one note, and fail closed when conforming randomness is unavailable. Import validation checks syntax and uniqueness but does not infer trust from an ID.

Scene and component revisions are monotonic publication generations and are excluded from inverse value equality. Every accepted dispatch increments `SceneRevision` by exactly one. Every component created or changed by that dispatch receives the new scene revision as its component revision; every unrelated component revision is preserved byte-for-byte. Recreating an element through Undo or Redo therefore receives a generation newer than every earlier publication of that element and cannot create revision ABA. Revisions never wrap; reaching the largest safe integer blocks mutation before publication.

## 2. Canonical Styles

Colors are exactly `currentColor` or `#rrggbbaa` with lowercase hexadecimal digits. No other CSS token, function, variable, URL, or keyword is valid. `currentColor` resolves from the owning Obsidian view and remains the only theme-dependent persisted paint value.

```ts
export type HexRgbaV1 = string & { readonly __brand: "HexRgbaV1" };
export type PaintColorV1 = "currentColor" | HexRgbaV1;
export type DashPatternV1 = "solid" | "dashed" | "dotted";
export type EndpointCapV1 =
  "none" | "arrow" | "dot" | "circle" | "diamond" | "bar";

export interface StrokePaintV1 {
  readonly color: PaintColorV1;
  readonly opacity: number;
  readonly width: number;
  readonly dash: DashPatternV1;
}

export type FillV1 =
  | { readonly kind: "none" }
  | {
      readonly kind: "solid";
      readonly color: PaintColorV1;
      readonly opacity: number;
    };

export interface PenStyleV1 extends StrokePaintV1 {
  readonly pressure: "constant" | "pointer";
  readonly smoothing: number;
  readonly streamline: number;
  readonly thinning: number;
  readonly strokeProfileVersion: 1;
}

export interface HighlighterStyleV1 extends StrokePaintV1 {
  readonly variant: "freehand" | "straight";
}

export interface ShapeStyleV1 extends StrokePaintV1 {
  readonly fill: FillV1;
}

export interface LinearStyleV1 extends StrokePaintV1 {
  readonly startCap: EndpointCapV1;
  readonly endCap: EndpointCapV1;
  readonly capSize: number;
}

export interface ConstructionStyleV1 extends StrokePaintV1 {
  readonly positiveEndCap: EndpointCapV1;
  readonly capSize: number;
}
```

Every `StrokePaintV1.opacity` and solid `FillV1.opacity` is independently validated in `[0, 1]`. For `ShapeStyleV1`, inherited `opacity` is exclusively outline opacity and `fill.opacity` is exclusively fill opacity; neither value is derived from or multiplied by the other, and a renderer MUST NOT replace them with one shared group opacity. Width is in `[0.25, 128]` note pixels. Cap size is in `[1, 128]` note pixels. Smoothing, streamline, and thinning are in `[0, 1]`. UI step sizes are presentation concerns, but accepted canonical values are quantized to increments of `0.01`. Highlighter style MUST use constant width and ignores pointer pressure. A stored dotted line uses round visual dots separated by `2 * width`; dashed uses dash length `4 * width` and gap `2 * width`. These derived values are not persisted.

The V1 pressure-outline algorithm consumes the canonical samples, `PenStyleV1`, and `strokeProfileVersion`. Its golden geometry fixtures are frozen before Phase 3 exits. Changing the algorithm without changing `strokeProfileVersion` is forbidden. Resize never changes a style or its revision.

## 3. Geometry Records

```ts
export interface EncodedStrokeV1 {
  readonly codec: "delta-varint-v1";
  readonly pointCount: number;
  readonly originXQ: number;
  readonly originYQ: number;
  readonly pressure: "absent" | "present";
  readonly data: string;
}

export interface StrokeGeometryV1 {
  readonly stroke: EncodedStrokeV1;
  readonly selectionRotationRadians: number;
}

export interface AreaGeometryV1 {
  readonly center: NotePointV1;
  readonly width: number;
  readonly height: number;
  readonly rotationRadians: number;
}

export interface LinearGeometryV1 {
  readonly start: LinearEndpointV1;
  readonly end: LinearEndpointV1;
  readonly control: NotePointV1 | null;
}

export interface TableGeometryV1 extends AreaGeometryV1 {
  readonly rowDividerOffsets: readonly number[];
  readonly columnDividerOffsets: readonly number[];
}

export interface Axes2DGeometryV1 {
  readonly origin: NotePointV1;
  readonly xAxis: NoteVectorV1;
  readonly yAxis: NoteVectorV1;
  readonly gridDivisions: number;
}

export interface Axes3DGeometryV1 extends Axes2DGeometryV1 {
  readonly zAxis: NoteVectorV1;
}

export type NonLinearGeometryV1 =
  | StrokeGeometryV1
  | AreaGeometryV1
  | TableGeometryV1
  | Axes2DGeometryV1
  | Axes3DGeometryV1;

export type CanonicalGeometryV1 = NonLinearGeometryV1 | LinearGeometryV1;

export type CanonicalStyleV1 =
  | PenStyleV1
  | HighlighterStyleV1
  | ShapeStyleV1
  | LinearStyleV1
  | ConstructionStyleV1;
```

Shape area width and height are each at least `0.01`. Shape, Table, Stroke, and persisted Group selection rotation is canonicalized to `[-Math.PI, Math.PI)`, where `Math.PI` canonicalizes to `-Math.PI`. Positive rotation is visually counterclockwise in the CSS note plane. A new Pen or Highlighter stores `selectionRotationRadians: 0`; rotation materializes its samples in note coordinates and replaces that field with the committed absolute angle. To reconstruct one stroke frame at angle `theta`, derive the finite sample-bounds center, inverse-rotate every relevant cached or canonical sample around that center by `theta`, compute the local axis-aligned bounds, and rotate that bounds rectangle forward by `theta`. This prevents the stored orientation from rotating already materialized samples a second time. Deselect, reload, Undo, and Redo preserve the angle exactly. A local area point `(lx, ly)` maps exactly to `(center.x + lx * cos(theta) + ly * sin(theta), center.y - lx * sin(theta) + ly * cos(theta))`. Table width and height are at least `2`; divider validation and equal redistribution use the formulas in [Interaction and Tools](02-interaction-and-tools.md). Axis vectors are non-zero, pairwise non-collinear projected vectors. `gridDivisions` is an integer from `0` through `64`.

A curved Line or Arrow first resolves each endpoint from its own binding and optional object-port attachment, then uses the quadratic Bézier point `(1 - t)^2 * start + 2 * (1 - t) * t * control + t^2 * end` for `t` in `[0, 1]`. Its curve handle addresses the canonical `control` point directly. A null control renders and hit-tests the straight resolved start-to-end segment.

Pen and Highlighter geometry use `StrokeGeometryV1`, whose `stroke` uses `EncodedStrokeV1`. Pointer-pressure Pen requires `pressure: "present"`; constant Pen and every Highlighter require `pressure: "absent"`. Pen and Highlighter dash is always solid. Rectangle, Ellipse, Triangle, Diamond, and Octagon use `AreaGeometryV1`. Line and Arrow use `LinearGeometryV1` and may persist a quadratic `control` plus zero, one, or two endpoint attachments. Table and axes use their semantic records above. Derived paths, cells, guides, bounds, handles, fragments, and SVG nodes are never canonical records.

## 4. Object Ports and Attached Linear Endpoints

```ts
export type ObjectPortIdV1 =
  | "area:north"
  | "area:east"
  | "area:south"
  | "area:west"
  | "axes:origin"
  | "axes:x-positive"
  | "axes:y-positive"
  | "axes:z-positive";

export interface ObjectPortAttachmentV1 {
  readonly targetElementId: ElementId;
  readonly portId: ObjectPortIdV1;
}

export interface LinearEndpointV1 {
  readonly fallbackPoint: NotePointV1;
  readonly attachment: ObjectPortAttachmentV1 | null;
}
```

Rectangle, Ellipse, Triangle, Diamond, Octagon, and Table expose the four area ports where rays from the local center in the north, east, south, and west directions first intersect the actual closed outline defined in [SVG Rendering](06-svg-rendering.md). Rectangle and Table therefore use edge midpoints, Ellipse uses its cardinal extrema, and polygon ports lie on their actual edges or vertices rather than on an unrelated bounds corner. A 2D axes object exposes origin, X-positive, and Y-positive. A 3D axes object additionally exposes Z-positive. Pen, Highlighter, Line, Arrow, and Group expose no V1 ports. A port that is invalid for the target kind rejects the complete scene.

Area ports are transformed by the same center, local frame, rotation, binding projection, and whole-note view transform as their target. Axis ports resolve to the stored origin or positive vector endpoint. A range-bound enclosure target resolves its area ports from the current view-local enclosure projection, so two panes may display different endpoint positions without canonical mutation. The endpoint fallback remains canonical note geometry.

A reverse attachment index maps targets to attached Line or Arrow endpoints. Target move, resize, rotation, reflow, and preview update only those returned endpoints. A committed canonical target transform updates each attached endpoint's `fallbackPoint` in the same atomic batch. View-only text reflow changes only the resolved projection and does not mutate the fallback or scene. Target deletion resolves the last current endpoint when possible, otherwise retains `fallbackPoint`, clears the attachment, and publishes target deletion plus all disconnects atomically. Undo restores the target and attachments exactly. Lines and Arrows cannot be attachment targets, so attachment cycles are structurally impossible. One target admits at most 1,024 attached endpoints.

## 5. Scene Elements

```ts
export interface ElementCommonV1 {
  readonly elementId: ElementId;
  readonly geometryRevision: GeometryRevision;
  readonly styleRevision: StyleRevision;
  readonly bindingRevision: BindingRevision;
  readonly binding: ElementBinding;
}

export interface PenElementV1 extends ElementCommonV1 {
  readonly kind: "pen";
  readonly geometry: StrokeGeometryV1;
  readonly style: PenStyleV1;
}

export interface HighlighterElementV1 extends ElementCommonV1 {
  readonly kind: "highlighter";
  readonly geometry: StrokeGeometryV1;
  readonly style: HighlighterStyleV1;
}

export interface ShapeElementV1 extends ElementCommonV1 {
  readonly kind: "rectangle" | "ellipse" | "triangle" | "diamond" | "octagon";
  readonly geometry: AreaGeometryV1;
  readonly style: ShapeStyleV1;
}

export interface LineElementV1 extends ElementCommonV1 {
  readonly kind: "line" | "arrow";
  readonly geometry: LinearGeometryV1;
  readonly style: LinearStyleV1;
}

export interface TableElementV1 extends ElementCommonV1 {
  readonly kind: "table";
  readonly geometry: TableGeometryV1;
  readonly style: ConstructionStyleV1;
}

export interface Axes2DElementV1 extends ElementCommonV1 {
  readonly kind: "axes-2d";
  readonly geometry: Axes2DGeometryV1;
  readonly style: ConstructionStyleV1;
}

export interface Axes3DElementV1 extends ElementCommonV1 {
  readonly kind: "axes-3d";
  readonly geometry: Axes3DGeometryV1;
  readonly style: ConstructionStyleV1;
}

export type SceneElementV1 =
  | PenElementV1
  | HighlighterElementV1
  | ShapeElementV1
  | LineElementV1
  | TableElementV1
  | Axes2DElementV1
  | Axes3DElementV1;

type WithoutComponentRevisionsV1<T> = T extends SceneElementV1
  ? Omit<T, "geometryRevision" | "styleRevision" | "bindingRevision">
  : never;

export type SceneElementValueV1 = WithoutComponentRevisionsV1<SceneElementV1>;
```

Eraser, Cursor, Lasso, selection chrome, Table cells, Table dividers, axis guides, and background regions are not scene elements. A Line highlighter creates `HighlighterElementV1`; its originating tool is not stored.

## 6. Groups, Object Order, and Scene State

```ts
export interface GroupRecordV1 {
  readonly groupId: GroupId;
  readonly childIds: readonly (ElementId | GroupId)[];
  readonly selectionRotationRadians: number;
}

export interface SceneStateV1 {
  readonly revision: SceneRevision;
  readonly elements: readonly SceneElementV1[];
  readonly objectOrder: readonly ElementId[];
  readonly groups: readonly GroupRecordV1[];
  readonly noteAppearance: NoteAppearanceV1;
}

export interface NoteAppearanceV1 {
  readonly background: "none" | "ruled" | "squared" | "dotted";
  readonly horizontalSpacing: "compact" | "standard" | "wide";
  readonly contrast: "low" | "medium" | "high";
}
```

`elements` contains each `ElementId` exactly once. `objectOrder` is a complete duplicate-free back-to-front permutation of those IDs. Groups contain at least two ordered direct children, references resolve, one child has at most one direct parent, and nesting is at most 32. Groups have no independent style, binding, element geometry, or object-order slot. `selectionRotationRadians` is only the canonical orientation authority for reconstructing that persisted Group's aggregate selection frame; creating a Group initializes it to zero, and a committed Group rotation updates it by the same absolute rotation used to materialize every descendant transform. Reconstruction inverse-rotates descendant selection geometry by the stored angle around any common finite origin, computes its local union bounds, and rotates that rectangle forward; the result is origin-independent and does not rotate descendants twice. Recursively flattening one Group's `childIds` in stored order MUST equal exactly the contiguous `objectOrder` subsequence occupied by that Group. Sidecar validation, clipboard validation, and every Group replacement enforce this same invariant.

Creating a Group preserves descendant relative order and compacts its leaf descendants into one contiguous block at the earliest selected leaf position. Nested selected roots are reduced to their highest selected ancestor before compaction. Ungrouping preserves the current leaf order. A Group z-order command moves its complete contiguous leaf block while preserving internal order. Any operation that would interleave another element inside a Group block is invalid. This makes Group selection and z-order deterministic without a second ordering authority.

`noteAppearance` belongs to the same canonical revision and reversible operation stream as elements, Groups, and object order. Runtime maps, reverse attachment indices, spatial indices, and selectable-order indices are derived from these arrays and are not serialized.

## 7. Clipboard Transfer V1

The preferred MIME type is `application/x-inkbook-annotations+json`. A host that cannot write it uses the identical UTF-8 JSON as `text/plain`; Inkbook accepts that fallback only when the top-level format and complete schema validate. No HTML, SVG, Markdown, URL, file, image, or host object is transferred.

```ts
export interface ClipboardElementV1 {
  readonly localId: number;
  readonly kind: SceneElementV1["kind"];
  readonly geometry: CanonicalGeometryV1;
  readonly style: CanonicalStyleV1;
  readonly linearStartAttachment: ClipboardAttachmentV1 | null;
  readonly linearEndAttachment: ClipboardAttachmentV1 | null;
}

export interface ClipboardAttachmentV1 {
  readonly targetLocalId: number;
  readonly portId: ObjectPortIdV1;
}

export interface ClipboardGroupV1 {
  readonly localGroupId: number;
  readonly selectionRotationRadians: number;
  readonly childRefs: readonly (
    | { readonly kind: "element"; readonly localId: number }
    | { readonly kind: "group"; readonly localGroupId: number }
  )[];
}

export interface InkbookClipboardV1 {
  readonly format: "inkbook-annotation-clipboard";
  readonly schemaVersion: { readonly major: 1; readonly minor: 0 };
  readonly sourceOrigin: NotePointV1;
  readonly elements: readonly ClipboardElementV1[];
  readonly objectOrder: readonly number[];
  readonly groups: readonly ClipboardGroupV1[];
}
```

The payload is non-empty. Local IDs are contiguous integers from zero. `objectOrder` is a complete permutation of element local IDs. Group rules equal scene Group rules, including canonical persisted selection orientation. Geometry and style must match the declared kind. `sourceOrigin` is the center of the finite axis-aligned union of canonical geometry bounds after external Line or Arrow endpoints are resolved. A transferred Line or Arrow `LinearGeometryV1` contains null endpoint attachments; its optional clipboard attachments may reference only an attachable element within the payload and carry the original valid port. A copied endpoint attached outside the selection is converted to a free endpoint at its current safely resolved fallback before serialization. Every other element record requires both clipboard attachments to be null. Bindings, element or Group IDs, revisions, note identity, source text, anchor contexts, selection DOM, viewport state, and transient multi-selection orientation are forbidden.

Paste allocates fresh cryptographic IDs, assigns every created component the next scene publication revision, remaps internal Line or Arrow endpoint attachments and Group references, translates `sourceOrigin` to the requested current note point, and runs normal binding inference for every created element against one current layout token. Keyboard paste without a pointer target uses the center of the visible unzoomed note viewport. Duplicate uses the same pipeline with an offset of exactly 16 note pixels on both axes. Failure of any ID, resource, geometry, relationship, binding, recovery, or history step rejects the complete atomic batch. Cut writes and acknowledges the clipboard payload before attempting one dependency-closed delete operation.

The encoded payload is at most 1 MiB UTF-8, 5,000 elements, 100,000 total stroke points, 32 Group levels, 64 JSON levels, and 1,024 Line or Arrow endpoints attached to one copied target. Limits are enforced before immutable construction. Unknown major versions, future minor fields, duplicate keys, non-finite values, invalid cross-kind records, external references, and over-limit input are rejected without clipboard-driven mutation.

## 8. `delta-varint-v1` Wire Format

Coordinates are quantized by `round(noteCoordinate * 100)` into signed 32-bit integers. Pressure is quantized by `round(clamp(pressure, 0, 1) * 1000)`. `originXQ` and `originYQ` are the first quantized point. The first timestamp is zero.

`data` is unpadded base64url over this exact byte stream:

1. if pressure is present, one unsigned varint containing the first point pressure;
2. for every point from index `1`, a zigzag-varint X delta, zigzag-varint Y delta, optional unsigned pressure varint, and unsigned elapsed-millisecond delta varint, in that order.

Signed 32-bit `n` maps to unsigned zigzag value `2 * abs(n)` when `n >= 0` and `2 * abs(n) - 1` otherwise. Unsigned varints use minimal little-endian base-128 groups with bit 7 as continuation. No value may use more than five bytes. A non-minimal encoding, overflow, trailing byte, invalid alphabet, padding, count mismatch, non-monotonic time, or value outside the declared limits rejects the complete element.

An empty stroke is invalid. A one-point stroke has an empty byte stream when pressure is absent and contains only its pressure otherwise. The decoded byte limit is `20 * pointCount`; the base64url character limit is `ceil(decodedByteLimit * 4 / 3)`. Golden fixtures MUST cover positive and negative deltas, five-byte boundaries, zero deltas, pressure-present and pressure-absent strokes, and every invalid form.

## 9. Canonical Serialization and Validation

Sidecar JSON is serialized with RFC 8785 JSON Canonicalization Scheme semantics, encoded as UTF-8 without BOM, followed by exactly one LF. Arrays retain semantic order. Persisted object member order is therefore not an independent authority. A digest over a sidecar or record uses the canonical bytes named by its contract.

Validation proceeds in this order: bounded tokenization, scalar and string validation, closed-discriminator validation, ID uniqueness, element validation, complete object-order permutation, Group topology, attachment references and ports, aggregate resource limits, and immutable scene construction. No spatial index, SVG node, cache, or host object is constructed before complete validation succeeds.

V1 writes exactly schema minor `0`. A sidecar with a newer minor or major version opens read-only after bounded structural validation. Inkbook MUST NOT rewrite it or claim unknown-field preservation. Supporting a newer minor requires an explicit migration and golden round-trip fixtures.
