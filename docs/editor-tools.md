# Editor Tools

## Select

The Select tool is used to select and edit existing elements.

Available interactions:

- With mouse input, click an element to select it while Select is active.
- With touch input, complete a short stationary tap to select an element regardless of the active tool. Contact alone, pan, and note scroll do not change selection. A touch drag moves an annotation only when it was already selected before contact.
- Drag from empty canvas while Select is active to draw a lasso area and select multiple elements. Lasso is not a separate toolbar tool.
- Hold Shift to add more elements to the selection.
- Move a selection.
- Scale a selection using its handles. Geometry changes, but line and outline widths remain unchanged.
- Rotate a selection. The rotation value is stored.
- Modify rectangles and ellipses using dedicated shape handles.
- Edit lines and arrows using their endpoints.
- Bend lines and arrows using a handle in the middle to create curves.

When a selection is dragged to the edge of the visible area, the plugin automatically continues scrolling. If it reaches the bottom-edge threshold, the editor adds bounded transient page space as specified in [File Format and Geometry](file-format.md); commit or cancellation then restores the exact derived height.

Every annotation retains its exact page-space geometry when it is created, moved, scaled, rotated, or edited. Portions beyond the fixed left, right, or top page edge are hidden by the active canvas and standalone SVG viewport, never translated back into view. Moving an annotation inward later reveals the preserved outside portion. Positive-y geometry continues to participate in automatic downward page growth.

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

The start and end of a line or arrow independently snap to nearby semantic shape anchors during creation and endpoint editing. Straight highlighters do not connect. The supported anchors are:

- Rectangle and table: four corners and four outer-edge midpoints.
- Ellipse or circle: the four cardinal points at 90 degrees on the bottom, 180 degrees on the left, 270 degrees on the top, and 360 degrees on the right. The file format canonicalizes 360 degrees to 0 degrees.
- Triangle: three vertices and the midpoint of each of its three edges.
- Diamond, parallelogram, and octagon: every vertex and every edge midpoint.
- Coordinate system: the origin and every current axis endpoint.

Anchors are derived from the target's current scaled and rotated geometry. They are not stored as canvas elements. The nearest candidate within 12 CSS pixels for mouse or pen input and 16 CSS pixels for touch input is previewed with a screen-sized marker. An existing candidate remains active until the pointer is 4 CSS pixels beyond the acquisition radius. Equal-distance candidates resolve by frontmost render order, then target ID, then semantic anchor order.

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

When elements are selected, the menu edits the selection instead of the current tool. For a mixed selection, it only shows properties that apply to all selected elements. One accepted structural change is one atomic undo step and changes neither session tool values nor vault defaults. Choosing the existing value is a no-op with no revision or history entry.

Exact geometry, hit tolerances, bounds, node sizing, and serialization are defined in [File Format and Geometry](file-format.md). Built-in and user-configurable defaults are defined in [Settings](settings.md).

## Related Documentation

- [Core model](core-model.md)
- [Embed UI](embed-ui.md)
- [File format](file-format.md)
- [Feature behavior](features.md)
- [Implementation specification](specification.md)
- [Settings](settings.md)
