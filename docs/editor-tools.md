# Editor Tools

## Select

The Select tool is used to select and edit existing elements.

Available interactions:

- With mouse input, click an element to select it while Select is active.
- With touch input, complete a short stationary tap to select an element regardless of the active tool. Contact alone, pan, and note scroll do not change selection. A touch drag moves an annotation only when it was already selected before contact.
- Drag from empty canvas while Select is active to draw either an axis-aligned rectangle or a freeform lasso area. Lasso is not a separate toolbar tool.
- Hold Shift to add more elements to the selection.
- Move an existing selection with mouse, pen, or touch regardless of the active tool. The selected overlay takes precedence over creation tools, while an explicit temporary eraser input remains destructive.
- Scale a selection using its handles. Geometry changes, but line and outline widths remain unchanged.
- Rotate a selection. Rotation briefly snaps to absolute multiples of 90 degrees within a five-screen-pixel arc around the rotation handle. While the magnet is active, a plain screen-space axis runs from the snapped handle through the selection center and extends by the same center-to-handle distance on the opposite side. The rotation guide has no cross, badge, or connector marker. The screen-space threshold is converted through the active zoom so higher zoom permits finer angular control. A single element snaps its final stored rotation, not the gesture delta, so reopening an element at 10 degrees and rotating it toward 90 degrees produces 90 degrees rather than 100 degrees. A multi-selection uses its first selected element as the deterministic absolute-angle reference while preserving every relative rotation. The resulting rotation value is stored without a transient snap offset.
- Modify rectangles and ellipses using the same transform-backed scale handles as other box selections, so every frame and the final commit use one geometry path.
- Edit lines and arrows using their start and end handles. A singly selected line or arrow has no box or rotation handle.
- Bend lines and arrows using an always-present middle handle. A straight linear element places this handle at its canonical midpoint so dragging it can introduce a curve. A curved element places it at the visible quadratic midpoint rather than the off-curve control point, and dragging the handle keeps that visible curve point under the pointer for unrotated and rotated elements. Bringing the visible handle back within 5 screen pixels of the straight segment canonicalizes the bend to `null`, so a later endpoint edit cannot restore an invisible historical curve. This straight-line magnet displays the complete endpoint chord and a plain cross at its midpoint. Away from the straight segment, bringing the handle within 5 screen pixels of the chord midpoint's perpendicular bisector centers it along the chord while preserving its perpendicular distance and therefore produces a symmetric curve. This symmetry magnet displays the perpendicular bisector from just beyond the chord through and just beyond the handle, plus a plain cross at the handle. Their screen-space thresholds are converted through the active zoom so higher zoom permits finer placement.

When Select is active without an element selection, its Style controls configure two independent session values. **Selection area** chooses Rectangle or Lasso through accessible icon buttons, and the Select toolbar icon mirrors the active choice. **Include elements** chooses Touched or Fully enclosed. An active element selection replaces these tool controls with only the style properties shared by all selected elements. Rectangle is the built-in area, and Touched is the built-in inclusion rule. Touched includes an element when any visible painted geometry intersects or lies within the area. Fully enclosed includes it only when all visible painted geometry, including stroke width and arrow nodes, lies within the area. The same inclusion rule applies to both area shapes. Select owns mouse, pen, and touch area gestures independently of the finger-drawing toggle. A freeform lasso processes every coalesced input batch once, filters and simplifies in screen space through the gesture-start zoom, retains at most 512 points, and uses the same even-odd closed polygon for its visible fill and selection predicate. Simplification preserves the first and latest retained points and increases its bounded error tolerance only when the point budget is reached. Candidate lookup first queries the spatial index with the area bounds and never scans the complete element store. Additive selection uses the selection captured when the gesture began, so an unrelated later UI update cannot change the commit basis. A filled box or group selection can be moved with mouse, pen, or touch from every point inside its highlighted overlay, including transparent gaps between selected geometry, even while another creation tool is active. A single line or arrow remains movable only from its visible centerline or handles.

Every selection handle uses a larger invisible interaction target than its visible circle. At zoom 1 the radius is 13 CSS pixels for mouse, 16 for pen, and 24 for touch. The radius scales inversely with the square root of zoom and is clamped between 11 and 28 CSS pixels, so low and medium zoom remain forgiving while high zoom allows finer endpoint, bend, resize, and rotation control. Visible handle geometry remains screen-sized and unchanged. A handle gesture captures the canonical visible geometry and the pointer-to-handle grab offset once. Every later preview and commit uses that immutable gesture snapshot, so touching an expanded target cannot cause an initial size jump and concurrent Store presentation updates cannot move the overlay away from its elements. Uniform group resize projects pointer movement onto the original handle direction; perpendicular pointer noise has no scale component, and crossing the fixed anchor remains clamped at the geometry minimum.

An eligible primary mouse or pen action outside the selected geometry and its handles clears the selection independently of the active tool before that tool continues. Claimed finger drawing clears at gesture start, before its creation preview begins. With finger drawing disabled, only a confirmed short empty-canvas tap clears the selection; contact that becomes note scroll, page pan, pinch, or long press preserves it. Context clicks also preserve the current selection.

When a selection is dragged to the edge of the visible area, the plugin automatically continues scrolling and reprojects the held viewport point after every applied scroll frame. If the preview needs additional space below the current page, the layout synchronously reserves only the next writing-row-aligned height required by that preview. This reserve is never animated, never starts scroll stabilization, and never shrinks during the gesture, so native autoscroll and pointer projection have one stable mapping. Cancellation restores the original height, while a successful commit reconciles the reserve with the ordinary height derived from final stored geometry.

Every annotation retains its exact page-space geometry when it is created, moved, scaled, rotated, or edited. A translated box or table derives its pivot from the canonical moved origin and unchanged canonical dimensions, preventing independent decimal rounding from invalidating an otherwise valid mixed-selection commit. A single rotated-element resize converts its local scale back to the world-space preview pivot before persistence, so freehand strokes, shapes, tables, and other scalable elements do not move when the preview is committed. Portions beyond the fixed left, right, or top page edge are hidden by the active canvas and standalone SVG viewport, never translated back into view. Moving an annotation inward later reveals the preserved outside portion. Positive-y geometry continues to participate in automatic downward page growth.

Closed-shape and group selection polygons keep the translucent accent fill. A singly selected line or arrow remains unfilled. A move that would exceed the valid document coordinate range is rejected while preview, edge-drag, and pointer cleanup still complete normally.

## Arrange

Selected annotations can be reordered through four actions in the selection context menu:

- Bring forward
- Send backward
- Bring to front
- Send to back

Highlighter and straight-highlighter elements occupy the fixed highlight render band. Every other annotation occupies the content render band above it. An arrange action changes order only inside each selected element's band, so a highlighter always remains below content. For a mixed or multi-element selection, each band is reordered independently and the selected elements retain their relative order. A successful arrange action is one undo step; an action that cannot change order creates no history entry.

## Draw

Draw is the actual pen tool.

Internally, a stroke consists of:

- a unique ID
- a list containing `x`, `y`, and pressure values
- color
- base width
- pressure sensitivity
- smoothing parameters
- creation time
- canonical page-space points updated by committed selection transformations

The default pen uses:

- color: `theme-text`, meaning the current light or dark Inkbook document-palette text role
- width: 8 page units
- dynamic stroke width: enabled
- real pressure data when a pen is detected
- simulated pressure for a mouse or finger

In the default mode, the editor automatically detects whether input is more likely to come from a pen or a mouse. A smoother, simulated pressure curve is used for mouse and finger input.

## Highlighter

The highlighter uses the same input and rendering path as the pen, but differs visually:

- yellow by default
- 40 percent opacity
- constant width, independent of pressure
- 2.5 times the selected base width
- always rendered below regular pen strokes and shapes

This keeps text or ink beneath the highlighter visible.

## Straight Highlighter

The straight highlighter uses the same input and rendering path as lines, but differs visually:

- yellow by default
- 40 percent opacity
- constant width, independent of pressure
- 2.5 times the selected base width
- always rendered below regular pen strokes and shapes

This keeps text or ink beneath the highlighter visible.

## Shapes

The toolbar has adjacent Active Shape and Shape Picker controls. The Active Shape control displays the exact currently selected shape icon and activates that shape tool. The Shape Picker opens the shape selection and updates the Active Shape control; it is not itself a drawing tool. The available shapes are:

- Line
- Arrow
- Rectangle
- Ellipse
- Triangle
- Octagon
- Parallelogram
- Diamond
- Coordinate System
- Table

The Active Shape control remembers the most recently selected shape. Repeated activation keeps that tool active; only the adjacent Shape Picker opens or closes the selection.

Lines, arrows, closed shapes, coordinate systems, and tables are created by dragging from a start point to an end point. The live preview uses normalized geometry, and pointer release commits one element. Gestures below the element's minimum geometry are clamped on commit.

Lines, arrows, coordinate systems, and tables do not have a fill. All closed shapes additionally support a fill color.

A coordinate system can be either two-dimensional or three-dimensional. Its dimensionality is selected in the Style menu when the tool is active and remains editable there when existing coordinate systems are selected. Scaling changes the lengths of its axes without changing their line width.

The Table tool creates a connected table from lines. Its number of columns is configurable during creation and remains editable in the Style menu when existing tables are selected. It has no row separators except for a single horizontal separator below the column headings. Scaling changes the lengths of its lines without changing their line width.

## Line and Arrow Connections

The start and end of a line or arrow independently snap to nearby semantic shape anchors during creation, endpoint editing, and movement of an existing line or arrow with at least one free endpoint. A whole-selection move uses the deterministically nearest eligible free endpoint to adjust the shared translation and persists that endpoint's semantic connection. It never replaces an existing endpoint connection and never targets a shape that moves inside the same selection. Straight highlighters do not connect. The supported anchors are:

- Rectangle and table: four corners and four outer-edge midpoints.
- Ellipse or circle: the four cardinal points at 90 degrees on the bottom, 180 degrees on the left, 270 degrees on the top, and 360 degrees on the right. The file format canonicalizes 360 degrees to 0 degrees.
- Triangle: three vertices and the midpoint of each of its three edges.
- Diamond, parallelogram, and octagon: every vertex and every edge midpoint.
- Coordinate system: the origin and every current axis endpoint.

Anchors are derived from the target's current scaled and rotated geometry. They are not stored as canvas elements. The nearest candidate within 12 CSS pixels for mouse or pen input and 16 CSS pixels for touch input is previewed with a plain screen-sized target cross. The same marker is used for new lines and arrows, endpoint handles, and whole-line movement. It clears immediately when the candidate is released, without an exit transition. An existing candidate remains active until the pointer is 4 CSS pixels beyond the acquisition radius. Equal-distance candidates resolve by frontmost render order, then target ID, then semantic anchor order.

Pointer release persists a connection to the semantic target anchor rather than only the resolved page coordinate. Moving, scaling, rotating, or editing the target recomputes every connected endpoint in the same frame. A curved line retains its page-space bend point, so its endpoint tangent and arrow node reorient exactly as they do after a manual endpoint edit.

Dragging a connected endpoint previews a detached free endpoint. Releasing it over an eligible anchor replaces the connection; releasing it elsewhere leaves it detached at the free position. Deleting an attached target detaches each dependent endpoint at its last resolved position. Undo and Redo restore target geometry and connection state atomically.

The second endpoint may not connect when the resulting resolved line would violate the 8-page-unit minimum length. Exact schema, target validation, transform propagation, and clipboard behavior are defined in [File Format and Geometry](file-format.md).

## Eraser

The eraser always removes complete elements. It does not support pixel-level or partial erasing.

This means:

- A touched stroke is removed completely.
- A touched shape is removed completely.
- The movement between two input points is checked as a continuous sweep so that thin lines cannot slip through gaps between sample points.
- The effect radius can be configured in the Style menu.
- Touched elements preview a fade over 160 milliseconds but remain in the model until pointer release removes them together. Cancellation restores them immediately.
- One erasing gesture creates one undo step.

The eraser can also be activated temporarily:

- by holding `Ctrl` or `Cmd`
- by using the eraser tip of a supported pen
- by using the side button of a supported pen

When released, the editor automatically switches back to the previous tool.

## Style

Style is not a standalone drawing tool, but a context-sensitive adaptive Obsidian menu.

The toolbar Style control uses the canonical Palette glyph and continuously previews the active tool defaults. Its glyph outline uses the current pen, highlighter, line, arrow, or shape color. Pen and highlighter glyphs remain solid and unfilled. Line, arrow, and shape glyphs reproduce the active `solid`, `dashed`, or `dotted` outline style. A closed shape additionally fills the palette body with its current fill color at the configured fill opacity; no-fill shapes leave the body transparent. Select and Eraser use the neutral host icon color because they have no paint color. The four canonical palette wells retain the same solid outline color and geometry regardless of the outer dash style or fill.

The following options are available for the pen and the highlighters:

- color
- width
- opacity

Opacity is presented as a rounded slider with a compact percentage field. Dragging updates the local percentage display continuously and commits the bounded normalized value when the interaction changes, avoiding one history or render update per pointer sample.

Pen widths:

- XS: 2
- S: 4
- M: 8
- L: 14
- XL: 22

Pressure sensitivity is additionally shown for the pen. This setting applies to newly created strokes. It is not available for the highlighter because the highlighter intentionally uses a constant width.

The following options are available for shapes:

- outline color
- outline width
- outline style
- fill color, where applicable
- outline opacity
- fill opacity

Shape widths:

- XS: 1
- S: 2
- M: 4
- L: 8
- XL: 12

Outline styles:

- Solid
- Dashed
- Dotted

Arrows only:

- start and end nodes: None, Arrow, Triangle, Diamond, or Circle

The active Arrow tool icon renders the configured start and end node independently. Every combination of the five node types is representable without changing the shared line body.

Coordinate systems only:

- dimensionality: 2D or 3D

The active Coordinate System tool icon renders two axes for 2D and three axes for 3D.

Tables only:

- number of columns

The coordinate-system dimensionality and table column-count controls apply both to the active creation tool and to an existing applicable selection. A selection containing only coordinate systems exposes dimensionality. A selection containing only tables exposes column count. If all selected elements support the same structural property but currently have different values, the control shows a mixed state until the user chooses one concrete value; that value is then applied independently to every selected element. A mixed selection containing another element kind hides these structural controls.

Changing the column count of a selected table preserves that table's current column width. Adding a column extends the table by one column width on its local right side, while removing a column removes the local rightmost column and shrinks the total width by one column width. Height, header height, rotation, and line width remain unchanged. The rendered local left edge stays fixed, including for a rotated table.

Colors use the canonical built-in palette defined in [Settings](settings.md#color-values), including Theme text color and Gray. The list and serialized values are maintained only in that document.

When elements are selected, the menu edits the selection instead of the current tool. Select area and inclusion controls remain unavailable until the selection is cleared. For a mixed selection, the menu only shows element properties that apply to all selected elements. One accepted structural change is one atomic undo step and changes neither session tool values nor vault defaults. Choosing the existing value is a no-op with no revision or history entry.

Exact geometry, hit tolerances, bounds, node sizing, and serialization are defined in [File Format and Geometry](file-format.md). Built-in and user-configurable defaults are defined in [Settings](settings.md).

## Related Documentation

- [Core model](core-model.md)
- [Embed UI](embed-ui.md)
- [File format](file-format.md)
- [Feature behavior](features.md)
- [Implementation specification](specification.md)
- [Settings](settings.md)
