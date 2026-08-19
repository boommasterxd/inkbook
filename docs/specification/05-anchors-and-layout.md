# Anchors and Layout

## 1. Coordinate Spaces

The plugin uses three explicit coordinate spaces:

- `note`: CSS-pixel coordinates in the unzoomed logical note surface;
- `viewport`: coordinates relative to the current Markdown view viewport;
- `screen`: browser client coordinates from input events.

Canonical element geometry is stored in note coordinates. View adapters derive viewport and screen matrices. Every conversion MUST use a captured layout token that includes note revision, host-layout revision, zoom, writing-mode assumptions, and adapter identity.

## 2. Binding Types

Version 1 supports exactly three user-visible element bindings:

```ts
export type ElementBinding =
  TextRangeBinding | TextPositionBinding | FixedBinding;

export type BindingOrigin = "inferred" | "manual";
export type BindingConfidence = "high" | "medium" | "low";
export type BlockKindV1 =
  | "frontmatter"
  | "heading"
  | "paragraph"
  | "list-item"
  | "blockquote"
  | "code-block"
  | "table"
  | "thematic-break"
  | "blank-line"
  | "other";
export type BlockFingerprintV1 = string & {
  readonly __brand: "BlockFingerprintV1";
};

export interface TextBoundaryAnchor {
  readonly utf16Offset: number;
  readonly association: "before" | "after";
  readonly blockKind: BlockKindV1;
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly blockFingerprint: BlockFingerprintV1;
}

export interface TextPositionBinding {
  readonly kind: "text-position";
  readonly anchor: TextBoundaryAnchor;
  readonly localOffsetX: number;
  readonly localOffsetY: number;
  readonly origin: BindingOrigin;
  readonly confidence: BindingConfidence;
  readonly inferenceProfileVersion: 1;
}

export interface TextRangeBindingCommon {
  readonly kind: "text-range";
  readonly start: TextBoundaryAnchor;
  readonly end: TextBoundaryAnchor;
  readonly origin: BindingOrigin;
  readonly confidence: BindingConfidence;
  readonly inferenceProfileVersion: 1;
}

export interface FragmentRangeBinding extends TextRangeBindingCommon {
  readonly presentation: "highlight" | "underline";
}

export interface EnclosureRangeBinding extends TextRangeBindingCommon {
  readonly presentation: "enclosure";
  readonly marginsInLineHeights: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
}

export type TextRangeBinding = FragmentRangeBinding | EnclosureRangeBinding;

export interface FixedBinding {
  readonly kind: "fixed";
  readonly anchorX: number;
  readonly anchorY: number;
  readonly origin: BindingOrigin;
  readonly confidence: BindingConfidence;
  readonly inferenceProfileVersion: 1;
}
```

Offsets address the exact unnormalized Markdown snapshot in UTF-16 code units because the editor boundary uses CodeMirror positions. Every API and test MUST use the same unit. An anchor rejects an offset between the high and low surrogate of one valid pair. A text range is ordered by source position and includes both boundary contexts. It references Markdown without copying the referenced text.

### 2.1 Anchor Canonicalization V1

```ts
export const ANCHOR_CONTEXT_UTF16_V1 = 128 as const;
```

`ANCHOR_CONTEXT_UTF16_V1` is exactly `128`. `contextBefore` is the longest code-point-safe suffix ending at the boundary whose NFC-normalized form is at most 128 UTF-16 code units. `contextAfter` is the corresponding prefix beginning at the boundary. Extraction never splits a valid surrogate pair, and the stored result is Unicode NFC. Empty edge contexts are valid. Candidate comparison applies the identical extraction and NFC normalization algorithm. Import accepts at most the parser ceiling of 256 code units for forward compatibility, but a V1 write always emits at most 128.

The V1 source-block classifier operates on the exact Markdown snapshot and is independent of pane width, view mode, theme, and DOM. It classifies in this precedence: frontmatter, fenced or indented code block, ATX or Setext heading, list item, blockquote, GFM table, thematic break, blank-line run, paragraph, then other. Nested list or quote content uses the outermost source block containing the boundary. A boundary exactly between blocks uses the block on the side named by its association; a missing side uses the existing block.

`canonicalBlockTextV1` converts CRLF and CR to LF, applies NFC, removes trailing U+0020 and U+0009 from each line, removes leading and trailing blank lines, and preserves remaining characters and case. `blockFingerprint` is lowercase SHA-256 over a length-framed byte sequence containing UTF-8 `inkbook-block-fingerprint-v1`, the `BlockKindV1` value, and `canonicalBlockTextV1`. Each component is preceded by its unsigned 32-bit big-endian UTF-8 byte length. Fingerprints are exactly 64 lowercase hexadecimal characters.

`Text range` follows a source interval. Highlight and underline presentations derive current line fragments. Enclosure presentation derives one region around the current text-fragment envelope and stored margins. `Text position` follows one source boundary while preserving rigid canonical geometry. Its canonical reference point is the center of the canonical axis-aligned geometry bounds. At capture, `localOffsetX` and `localOffsetY` equal that reference point minus the resolved boundary point. Projection translates the complete canonical geometry by `resolvedBoundary + localOffset - canonicalReferencePoint`. Any committed geometry edit of any `text-position` element that changes its canonical reference point MUST recompute the local offset in the same atomic operation so the committed projection exactly matches the preview. `FixedBinding.anchorX` and `anchorY` store the desired unzoomed note-coordinate position of the same canonical reference point. Fixed projection translates the complete canonical geometry by `(anchorX, anchorY) - canonicalReferencePoint` and then follows only whole-note zoom and host scrolling. Switching to `Fixed` captures the current visible reference point without changing canonical geometry. Moving a Fixed element changes its anchor. A geometry edit that changes its canonical reference point updates the anchor atomically so the committed projection exactly matches the preview.

The V1 origin and confidence combinations are closed. An inferred `Text range` is high confidence, inferred `Text position` is medium, and inferred `Fixed` is low. Every manually confirmed binding is high confidence because the value represents explicit user intent. No other combination is valid. Manual correction retains `inferenceProfileVersion: 1` to identify the anchor and projection semantics, not to claim that the classifier selected it.

Binding does not change an element's semantic type. A Highlighter remains a Highlighter, a Line remains a Line, and an Ellipse remains an Ellipse regardless of binding. Derived line fragments and enclosing regions are view state and MUST NOT be serialized as canonical SVG geometry.

### 2.2 Object Attachments

Line and Arrow endpoints MAY attach only to the closed ports defined in [Domain Model and Codecs](15-domain-model-and-codecs.md). Object attachments are separate from text position anchors. Port resolution uses the target's current view projection, including a range-bound enclosure, without changing canonical endpoint fallback geometry. Deleting a referenced target object MUST detach each affected endpoint at its last safely resolved note-coordinate position. Target deletion and every detachment publish as one reversible operation. Automatic retargeting is forbidden in V1.

Line or Arrow projection first applies that element's own binding to both canonical fallback endpoints and then replaces each attached endpoint with the current projection of its target port. The rigid-geometry guarantee of `Text position` applies only while both endpoints are free. Detach or target deletion takes the currently resolved target-port point in note coordinates and inverse-projects it through the Line or Arrow's own current binding transform before storing the canonical fallback endpoint. Reapplying that unchanged binding MUST reproduce the exact pre-detach note-space endpoint, without a second translation, scale, or reflow delta. Target deletion commits the target deletion plus endpoint replacement atomically. An unavailable, stale, ambiguous, or non-invertible Line, Arrow, or target layout token rejects the complete operation rather than persisting a guessed endpoint.

### 2.3 Construction Geometry

Table, 2D axes, and 3D axes geometry is canonical in unzoomed note coordinates. A Table stores one finite center, positive local width and height, normalized orientation, and strictly ordered local row and column divider offsets. A 2D axes object stores one origin and two finite projected axis vectors. A 3D axes object stores one origin and three finite projected axis vectors. Per-axis length editing preserves each vector's unit direction and every inter-axis angle; whole-object rotation rotates all vectors rigidly. Viewport and screen geometry is derived through the captured layout and view matrices.

Reflow, pane-width changes, and pure zoom MUST NOT mutate canonical construction geometry. Derived table cells, grid guides, and SVG paths are view data. Axes never receive highlight or underline presentation. A Table may receive enclosure presentation only through its outer closed frame and the normal inference thresholds.

## 3. Initial Binding Inference

Drawing tools create geometry and style only. After a new element is completed, the binding engine classifies it from the canonical element geometry and the immutable Markdown layout snapshot captured by the gesture. Classification MUST NOT introduce a separate underline, text-highlight, or text-enclosure tool.

Version 1 uses one non-configurable `BindingInferenceProfileV1`. All distances are measured in unzoomed note coordinates and normalized by the effective body line height from the captured layout token:

```ts
export const BINDING_INFERENCE_PROFILE_V1 = {
  version: 1,
  enclosureClosureLineHeights: 0.5,
  enclosureCoverage: 0.6,
  highlightCoverage: 0.6,
  highlightVerticalExpansionLineHeights: 0.35,
  underlineMaximumAngleDegrees: 12,
  underlineMinimumBaselineOffsetLineHeights: 0,
  underlineMaximumBaselineOffsetLineHeights: 0.45,
  underlineCoverage: 0.6,
  textPositionMaximumDistanceLineHeights: 2,
  maximumSourceSpanUtf16: 65_536,
  maximumNearbyBlocks: 256,
  maximumRenderedFragments: 512,
  maximumRankedCandidates: 128,
} as const;
export type BindingInferenceProfileV1 = typeof BINDING_INFERENCE_PROFILE_V1;
```

1. An enclosure candidate is eligible when a closed construction shape, or a freehand loop whose endpoints are at most `0.5` line heights apart, contains the center of at least one rendered text fragment and has enclosure coverage of at least `60` percent. The enclosed fragment centers MUST resolve to one source-contiguous interval. The result is `Text range` with enclosure presentation.
2. A Highlighter candidate is eligible when at least `60` percent of its path arclength lies inside rendered text-fragment boxes expanded vertically by `0.35` line heights and the qualifying fragments form one source-contiguous interval. The result is `Text range` with highlight presentation.
3. A straight Line with no curve control, or a geometrically straight Highlighter that did not pass the highlight rule, is eligible as an underline when its direction differs from the text inline direction by at most `12` degrees, its path lies from `0` through `0.45` line heights below the applicable baseline, and at least `60` percent of the shorter inline span overlaps the text run. The result is `Text range` with underline presentation.
4. Any remaining element whose reference point is at most `2` line heights from a stable text boundary receives `Text position` and preserves rigid geometry. The reference point is the center of the canonical geometry bounds.
5. Every other element receives `Fixed`.

Enclosure, highlight, underline, and text-position candidates are considered in that order. Binding inference receives the resulting canonical element geometry and style, never the originating tool or toolbar control.

Class ranking uses these exact scores:

- enclosure coverage is the number of eligible rendered-fragment centers inside the closed geometry divided by the number of eligible rendered-fragment centers inside its canonical axis-aligned bounds;
- highlight coverage is qualifying path arclength divided by complete path arclength;
- underline coverage is qualifying inline overlap divided by the shorter of the element's inline span and candidate text-run span;
- range-candidate normalized distance is the Euclidean distance between the center of the canonical geometry bounds and the center of the candidate text-fragment envelope, divided by effective body line height;
- text-position normalized distance is the Euclidean distance between the canonical-bounds center and the candidate boundary point, divided by effective body line height.

Within enclosure, highlight, or underline, higher coverage wins, then smaller normalized distance, then the smaller UTF-16 start offset, then the smaller end offset. Text-position candidates use no coverage score and are ranked by smaller normalized distance, smaller UTF-16 offset, and association order `before` then `after`. Every `at least` and `at most` comparison includes the stated boundary. A zero denominator makes that candidate ineligible. Straightness alone MUST NOT produce an underline. Closure alone MUST NOT produce an enclosure. Identical element geometry, style, Markdown, and layout evidence MUST produce the same binding regardless of the input shortcut used to create it.

Candidate lookup is limited to 65,536 UTF-16 code units, 256 nearby blocks, 512 rendered text fragments, and 128 ranked candidates. Exceeding a limit rejects semantic range inference and falls back to the safe bounded `Text position` or `Fixed` result. It MUST NOT truncate a claimed text range silently.

For long strokes, total arclength and overlap evidence are accumulated incrementally from accepted geometry chunks against the captured bounded candidate set. Pointer up consumes those exact aggregates and MUST NOT rescan every canonical sample. An explicit rebind of existing long geometry is worker-first, cancellable, revision-bound, and publishes only the final current result. A worker-unavailable fallback uses main-thread slices of at most 2 ms during active interaction and 4 ms while idle.

Only a candidate satisfying every class threshold MAY produce `Text range` with high confidence. A safe position fallback is medium confidence. `Fixed` is the low-confidence fallback. The classifier input includes the source digest, host-layout revision, effective line height, writing-mode assumptions, and adapter identity. A stale token rejects the complete publication and requests fresh inference; it MUST NOT commit a guessed binding.

For enclosure inference, let `T` be the union envelope of qualifying text fragments, `S` the canonical closed-geometry bounds, and `L` the finite positive effective body line height of the block containing the start boundary in the captured layout token. Store `top = (T.top - S.top) / L`, `right = (S.right - T.right) / L`, `bottom = (S.bottom - T.bottom) / L`, and `left = (T.left - S.left) / L`. Margins are signed finite values in `[-1024, 1024]`. With current envelope `T'` and line height `L'`, projection is `[T'.left - left * L', T'.top - top * L', T'.right + right * L', T'.bottom + bottom * L']`. A non-finite, non-positive, or inverted result degrades the binding without canonical mutation.

Inference runs after a completed creation gesture, after moving a non-fixed element to a new destination, or after an explicit user request. Scroll, resize, rotation, reflow, and pure note zoom MUST NOT reclassify a stored binding. Resize and rotation of a `fixed` element preserve its binding exactly. Every geometry edit of a `text-position` element requires a current resolved source anchor, preserves the discriminator and anchor, and updates the local offset by the projection equation above when its reference point changes. Every `text-range` element whose visible geometry is derived from line fragments or an enclosure envelope has no geometry resize or rotation operation. This includes range-bound Pens, Highlighters, enclosing closed shapes, and enclosing Tables. The user must explicitly change its binding to `Text position` or `Fixed` before applying a rigid geometry transform. A permitted explicit geometry edit that atomically replaces an invalid binding, such as curving an underline under Section 5, follows its dedicated contract instead.

## 4. Markdown Edits and Reflow

Internal Markdown edits MUST map existing UTF-16 offsets through the editor transaction before a layout measurement occurs. `before` maps with CodeMirror association `-1` and remains before text inserted at that position. `after` maps with association `+1` and remains after inserted text. A newly inferred range uses `after` at its start and `before` at its end, excluding later insertion exactly outside either edge. Both boundaries are mapped independently through composed host transaction order. A previously non-empty range that collapses, reverses, exceeds bounds, or lands inside a valid surrogate pair becomes degraded and retains its last valid projection.

Every current transaction contributes the closed `SourceOffsetMapV1` defined in [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md) to the contiguous active-plus-latest checkpoint chain. The `MarkdownSourceCoordinator` admits the same echoed transition from multiple panes exactly once by digest and map identity. A duplicate advances only that view token and does not remap anchors, append recovery, enqueue save, or advance generation. A mismatched base enters bounded external-change handling. The checkpoint contains prior and replacement Markdown digests plus the composed UTF-16 offset mapping, not one duplicated anchor record per shifted element. The mapping becomes canonical and sidecar-eligible only after the checkpoint is recovery-protected.

Anchor materialization MUST use one immutable replacement Markdown snapshot whose digest equals the checkpoint replacement digest. It maps each affected UTF-16 boundary with its stored association and recomputes `contextBefore`, `contextAfter`, `blockKind`, and `blockFingerprint` for every anchor affected by a changed boundary, context window, or source block. A snapshot-digest or source-generation mismatch aborts encoding and restarts from the current durable generation. Materialization is worker-first and creates no host-history effect. When layout becomes current, only bindings affected by changed text or layout ranges are re-resolved.

When a source checkpoint becomes durable, `MarkdownSourceCoordinator` maps the affected canonical-scene anchors and publishes the new source generation without traversing the complete actionable history. Each anchor-bearing prior or replacement history value retains its source generation and resolves through the persistent composed-map graph in [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md). A reverse evidence index identifies entries whose blocks or ranges intersect a checkpoint; unrelated entries receive no allocation. Undo or Redo materializes only the requested entry against the current immutable source snapshot, applies the same association and evidence-regeneration rules as the canonical scene, and caches the result only while that source generation remains current. A stale generation, unsafe range collapse, unavailable evidence, excessive mapping depth, or failed exact materialization blocks that history direction and further annotation mutation while preserving its prior entry and acknowledged recovery for explicit review. Background graph compaction is revision-bound and MUST NOT rewrite the complete history table.

If source-checkpoint persistence fails, the current view may continue to display its transient mapped projection, but annotation mutation and sidecar saving are blocked under a visible `Source checkpoint pending` state until Retry succeeds. Native Markdown editing remains owned by Obsidian and is never rolled back by Inkbook. On reopen after a crash before checkpoint durability, the unchanged sidecar digest mismatch uses the bounded external reattachment path below. View-only reflow, wrapping, scroll, mode, font, and width changes never create a source checkpoint.

External edits or ambiguous changes use this bounded reattachment order:

1. exact context at the mapped offset;
2. block fingerprint within the nearby block window;
3. bounded context search with deterministic distance and tie-breaking;
4. degraded placement at the last valid note position;
5. orphaned state when no safe relationship remains.

Exact-context matching requires both stored contexts that exist at the file edges. Fingerprint candidates are ranked by absolute distance from the mapped offset, then smaller UTF-16 offset. Bounded context search ranks a match of both contexts above either one, then larger total matching context length, smaller absolute mapped-offset distance, smaller block start, and smaller boundary offset. An exact tie between distinct boundaries is ambiguous and degrades instead of choosing one silently.

Degraded and orphaned elements remain visible and editable. The plugin MUST show their status and offer Reattach and Fix to Note actions. It MUST never silently attach an element to unrelated text.

One anchor search is limited to 65,536 UTF-16 code units, 256 nearby blocks, and 128 ranked candidates. A revision-bound text index provides context and fingerprint candidates without repeated full-text scans. After bounded DOM evidence capture, reattachment runs through the shared worker scheduler, publishes only results matching the current Markdown and layout token, and reports progress for larger external changes. A newer source revision cancels and discards stale work. The worker-unavailable fallback uses bounded main-thread slices under the same publication contract.

For highlight and underline presentation, each view derives only fragments intersecting its viewport plus `OVERSCAN_PROFILE_V1`. One element may materialize at most 512 fragments and 256 KiB of derived fragment records per view generation. Compatible adjacent paint fragments MAY be emitted as one composed path while preserving the canonical element ID and stable fragment keys. If the visible range alone exceeds either limit, that element enters a visible projection-overflow state, retains its last complete current-token projection, and accepts no geometry or binding mutation until bounded projection succeeds. For enclosure presentation, each view computes the bounding envelope from a bounded source-range index without materializing offscreen line fragments and applies the stored line-height-relative margins. A circular Ellipse MAY become an ellipse after width-induced reflow so that it continues to enclose the same source range. Outline width remains constant in note units.

If either range boundary becomes ambiguous, the complete range binding becomes degraded. It retains the last valid visible projection and MUST NOT attach one endpoint to unrelated text. Reflow changes derived projection geometry and spatial-index bounds only. It MUST NOT rewrite canonical stroke samples, shape geometry, the stored binding, host history, or the sidecar revision.

## 5. Manual Move and Reanchoring

Moving a text-bound element to a new paragraph MUST run binding inference at the destination. The old binding MUST NOT remain authoritative simply because the same element ID is retained. A `Fixed` element remains fixed unless the user explicitly selects a text binding.

The operation contains both the transform and replacement binding. It commits atomically as one invertible host-history effect. Undo restores the exact prior transform, binding, origin, confidence, and derived placement. The user MAY explicitly choose `Fixed` to suppress text reanchoring for that element.

For a group or multi-selection move, the engine infers a replacement binding independently for every transformed non-fixed element from that element's destination geometry and preserves every `Fixed` binding unchanged. Every transform and applicable binding replacement publishes atomically as one operation. One failing or stale required inference rejects the complete command without partial movement.

The selection stylebar exposes `Text range`, `Text position`, and `Fixed`. A manual correction uses the latest valid candidate for the chosen class, records `origin: "manual"` and `confidence: "high"`, and remains authoritative through later layout changes. If no valid candidate exists, that value is unavailable rather than guessed. Binding correction changes no canonical element geometry and commits as one reversible operation.

Changing the curve control of a Line with underline presentation MUST validate the new geometry and binding atomically against the current layout token. Curved Line geometry is not an underline candidate in V1. Adding a curve therefore replaces the invalid underline binding with the current safe `Text position` or `Fixed` fallback while preserving the element ID. Undo restores the exact prior curve control, binding, origin, confidence, and derived projection.

## 6. Anchor Groups and Efficient Reflow

Elements sharing a resolved text boundary SHOULD be rendered under an SVG group transform. Reflow updates the group transform rather than rewriting every descendant path point. Text-range projections retain the canonical source element ID and stable view-local fragment keys so selection, hit testing, aggregation, and accessibility continue to address one element.

The renderer MUST distinguish:

- canonical geometry revision;
- anchor revision;
- host layout revision;
- view transform revision.

Changing one revision invalidates only dependent derived data. Binding-dependent projections additionally key by binding revision and host-layout revision. Markdown reflow MUST NOT regenerate canonical stroke geometry.

## 7. Background Alignment

Ruled, squared, and dotted backgrounds MUST align to the actual computed Obsidian body text rhythm.

When the selected background is `none`, the adapter performs no background metric, layout-probe, or region work.

For each current host-layout token, the adapter derives a stable note-content origin `O`, one rectangular fallback `BackgroundRhythmRegion` covering the visible note plus bounded overscan, and zero or more rectangular body-text override regions in unzoomed note CSS pixels. A region contains a note-space clip rectangle, effective body font size `F`, baseline-to-baseline line height `L`, and first body-text baseline `B`. Body-text override regions do not overlap each other and split whenever font metrics, line height, writing direction, or baseline phase changes. Every mounted ordinary body-text line box belongs to exactly one current override region. Headings and other intentionally non-body typography are not promised body-grid alignment.

Within one region, the vertical period is exactly `L`. Its phase is the non-negative modulo `phaseY = mod(B - O.y, L)`, and rows are positioned at `O.y + phaseY + k * L` for integer `k`, clipped to that region. This places every ordinary Markdown body-text baseline in the region on one corresponding background row. Block margins that change the modulo phase create a new adjacent region instead of forcing unrelated paragraphs onto one global phase or modifying Obsidian's text layout.

The fallback region's `F`, `L`, and baseline offset come from one bounded hidden layout probe with the current Obsidian body-text style. It is painted first across its complete clip. Body-text override regions are then painted in note order over their clips, replacing the fallback pattern there. Overlap is permitted only between the fallback and an override, never between two overrides. An empty note uses only the fallback. If finite positive metrics or a stable phase cannot be measured safely, the affected region degrades visibly to `none` rather than using arbitrary values.

For every region, the horizontal period is `H = L * R`, where the spacing ratio `R` is exactly `0.75` for compact, `1.00` for standard, and `1.25` for wide. Vertical guides share the note origin and are positioned at `O.x + k * H`. Ruled renders horizontal rows only. Squared renders horizontal and vertical guides. Dotted renders dots at the intersections of the same periods. Standard therefore produces square cells within each region, while compact and wide intentionally change horizontal density without altering Markdown line height. `none` renders no background layer.

Within a region, line width is `clamp(0.5, 0.06 * F, 1.25)` note CSS pixels and dot diameter is `clamp(0.75, 0.10 * F, 2.5)` note CSS pixels. The background kind, horizontal spacing preset, and contrast are canonical per-note choices. Region clips, font sizes, line heights, periods, phases, line widths, and dot diameters are derived and MUST NOT be persisted.

Theme, font, mode, writing-layout, or host-layout changes invalidate the background metrics and affected anchor projections together. Pure note zoom reuses the unzoomed metrics and MUST NOT mutate the sidecar, host history, or canonical geometry.

Backgrounds MUST use one CSS gradient-backed surface or an equivalent constant-work renderer per mounted rhythm region. Region mounting is culled to the viewport plus bounded overscan and processed through the shared layout coordinator. The renderer MUST NOT create one SVG or DOM element per line, square, or dot. In Live Preview and Source, the concrete `ViewOverlayAdapter` owns fallback and override regions. In Reading View, the whole-note view owner owns the fallback region, while each override region is owned by exactly one applicable `MarkdownRenderChild` and is removed when that rendered section detaches or is reprocessed. No section child owns or removes the fallback.

One view admits at most 512 mounted rhythm regions and 4,096 source line boxes for background derivation. Adjacent regions with identical `F`, `L`, writing direction, phase, and lifecycle owner are merged before admission. Regions MUST NOT merge across Reading View section-owner boundaries. Exceeding either limit makes the complete affected view background visibly degraded to `none` until a current bounded layout fits; it MUST NOT render partially aligned rows or scan the complete note. After the main thread captures bounded typography and line-box evidence, derivation above one frame budget is worker-first, cancellable, and publishes only one complete current generation. The fallback uses slices of at most 2 ms during interaction and 4 ms while idle.

## 8. Reading View Resolution

`ReadingViewLayoutResolver` maps source UTF-16 positions and ordered range boundaries to rendered blocks through host-provided section metadata plus the same bounded context and block fingerprint used by the binding engine. It returns a result associated with the Markdown content digest and Reading View render generation.

If the host exposes no trustworthy source mapping for a rendered block, affected annotations remain visible at their last valid placement with degraded status. Annotation movement and reanchoring for those elements become read-only in that view. The adapter MUST NOT infer authority from incidental DOM order alone.

## 9. Zoom and Layout

The Markdown content root, background, overlay, and hit-test coordinate system MUST share one zoom transform. Zoom is view presentation, not canonical annotation geometry.

Changing zoom MUST:

- preserve the visible note position around the gesture focal point where the host permits it;
- recompute screen and viewport matrices;
- update hit testing and handle sizes;
- avoid editing the Markdown or sidecar scene;
- avoid independently scaling the SVG twice.

Pure note zoom does not change logical note width and MUST NOT reclassify bindings. A host-induced logical-width change is handled as a new host-layout revision and MAY reproject text ranges without canonical mutation.

Selection handles MUST retain accessible screen-space hit targets even though their note-space size changes with zoom.
