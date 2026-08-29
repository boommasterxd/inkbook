# Settings Specification

## Principles

- Settings expose stable user preferences, not internal performance tuning.
- Every value available in a tool's Style menu MUST have a configurable default for that tool.
- Changing a default affects newly created elements only. It never rewrites existing elements.
- Settings UI rejects invalid values and does not persist them. On load, an invalid persisted field falls back to its documented built-in default; the loader does not silently clamp it.
- The vault settings schema is version 3 for the first release. Because no earlier version was released in production, older or unknown settings versions are unsupported and fall back to built-in defaults; no settings migration is performed. Device-local settings use their independent version 1 schema.

## Scope and Precedence

Settings have four scopes:

| Scope            | Storage                | Examples                                                                |
| ---------------- | ---------------------- | ----------------------------------------------------------------------- |
| Vault            | Obsidian plugin data   | Tool defaults, page defaults, file placement, display refresh-rate mode |
| Device and vault | Obsidian local storage | Finger drawing, pen-tap insertion, handedness, motion preference        |
| File             | Editable SVG snapshot  | Current background type and spacing, element styles                     |
| Session          | Memory only            | Current tool, current menu values, finger toggle, zoom, camera position |

Vault settings use `Plugin.loadData()` and `Plugin.saveData()`. Device settings use `App.loadLocalStorage("inkbook:device-settings:v1")` and `App.saveLocalStorage(...)`. They are local to the current device and vault and contain preferences only, never vault paths, note content, clipboard data, or ink data.

Precedence from highest to lowest:

1. an explicit change applied to the current selection
2. the current session value for the active tool
3. the vault default for that tool
4. the built-in default in this document

On editor activation, session tool values are initialized from vault defaults. Switching tools restores that tool's own session values. File background values come from the file and are not replaced by vault defaults after creation.

## Settings Root

```ts
interface InkbookSettingsV3 {
  version: 3;
  startupTool: StartupToolV1;
  toolDefaults: ToolDefaultsV1;
  pageDefaults: PageDefaultsV3;
  filePlacement: FilePlacementV1;
  refreshRatePreference: "auto" | 60 | 90 | 120 | 144 | 240;
}

interface ToolDefaultsV1 {
  pen: PenDefaultsV1;
  highlighter: HighlighterDefaultsV1;
  straightHighlighter: HighlighterDefaultsV1;
  eraser: EraserDefaultsV1;
  shapes: Record<ClosedShapeToolV1, ShapeDefaultsV1> & Record<OutlineOnlyToolV1, OutlineDefaultsV1>;
  arrow: { startNode: ArrowNodeV1; endNode: ArrowNodeV1 };
  coordinateSystem: { dimension: "2d" | "3d" };
  table: { columns: number };
}

interface InkbookDeviceSettingsV1 {
  version: 1;
  fingerDrawingEnabled: boolean;
  penTapInsertion: "off" | "handwriting";
  leftHandedToolbar: boolean;
  motion: "system" | "full" | "reduced";
}
```

`StartupToolV1` is `"select" | "eraser" | "draw" | "highlighter" | "straight-highlighter" | "line" | "arrow" | "rectangle" | "ellipse" | "triangle" | "octagon" | "parallelogram" | "diamond" | "coordinate-system" | "table"`.

`ClosedShapeToolV1` is `"rectangle" | "ellipse" | "triangle" | "octagon" | "parallelogram" | "diamond"`.

`OutlineOnlyToolV1` is `"line" | "arrow" | "coordinate-system" | "table"`.

The built-in startup tool is `draw`.

Version 3 is the first released vault-settings schema. It stores absolute background spacing in the shared 25, 100 / 3, 50, and 100 page-unit series and the fixed 100-unit layout step. There are no production legacy settings to migrate, so version 1, version 2, and unknown vault settings are rejected as unsupported rather than transformed. The device-settings schema remains version 1.

## Display Refresh Rate

The General settings group offers `Auto`, `60 Hz`, `90 Hz`, `120 Hz`, `144 Hz`, and `240 Hz`. The built-in value is `Auto`. This preference is stored in the vault settings, so vault synchronization may carry it between devices. While `Auto` is selected, the closed dropdown reports `Auto (detecting…)` until measurement completes and then `Auto (detected: <rate> Hz)` for the settings window.

`Auto` therefore performs one quick `requestAnimationFrame` measurement for the main Obsidian window when the plugin runtime starts and for each additional owning pop-out window after it first becomes visible. It samples 18 valid frame intervals, selects the next conservative supported profile, keeps that result weakly associated with the window in memory, and performs no recurring or background measurement. Closing and reopening presentations in the same live window reuses the result. A pop-out window measures independently. Until measurement completes, or when no valid result can be obtained, the window uses the 120-Hz profile. A fixed choice starts no measurement. Switching from a fixed choice to `Auto` clears any previous Auto result and starts one measurement for each observed window; switching from `Auto` to a fixed choice cancels any unfinished measurement immediately. Changing the setting applies to active presentations without rewriting any Inkbook file.

The choice controls main-thread slice deadlines only. It does not cap the display refresh rate, change animation duration, weaken correctness checks, alter worker-internal work budgets, or expose internal cache and geometry limits. Higher profiles yield sooner and can make long non-interactive operations take slightly longer while preserving more frame time for Obsidian, style, paint, and compositing.

## Color Values

The built-in palette uses these exact snapshot values:

| Name             | Value                      |
| ---------------- | -------------------------- |
| Theme text color | `{ "type": "theme-text" }` |
| Red              | `#EF4444FF`                |
| Orange           | `#F97316FF`                |
| Yellow           | `#EAB308FF`                |
| Green            | `#22C55EFF`                |
| Cyan             | `#06B6D4FF`                |
| Blue             | `#3B82F6FF`                |
| Violet           | `#8B5CF6FF`                |
| Pink             | `#EC4899FF`                |
| Gray             | `#6B7280FF`                |

Custom colors are not part of the first release. Opacity remains a separate normalized value.

Theme text is resolved by the portable document palette, not by a transient Community-theme value. It therefore switches between Inkbook's canonical light and dark text colors while preserving identical active-scene and standalone-SVG output. Host chrome continues to use live Obsidian variables. See [Standalone SVG Envelope and Theme Rendering](svg-envelope.md).

## Pen Defaults

```ts
interface PenDefaultsV1 {
  color: ColorV1;
  width: 2 | 4 | 8 | 14 | 22;
  opacity: number;
  pressureEnabled: boolean;
}
```

Built-in values:

- color: Theme text color
- width: 8
- opacity: 1
- pressure enabled: true

Pressure sensitivity is shown in the pen Style menu and in Settings. Smoothing remains an implementation constant in version 1 to avoid exposing a low-level performance control.

## Highlighter Defaults

Freehand and straight highlighters have independent defaults:

```ts
interface HighlighterDefaultsV1 {
  color: ColorV1;
  width: 2 | 4 | 8 | 14 | 22;
  opacity: number;
}
```

Built-in values for both:

- color: Yellow, `#EAB308FF`
- base width: 8
- effective rendered width: base width multiplied by 2.5
- opacity: 0.4
- pressure: always disabled and not configurable

## Shape Defaults

Every shape type has its own persisted default entry, even when several entries initially share the same values.

```ts
interface OutlineDefaultsV1 {
  outlineColor: ColorV1;
  outlineWidth: 1 | 2 | 4 | 8 | 12;
  outlineStyle: "solid" | "dashed" | "dotted";
  outlineOpacity: number;
}

interface ShapeDefaultsV1 extends OutlineDefaultsV1 {
  fillColor: ColorV1 | null;
  fillOpacity: number;
}
```

Built-in outline values for every shape:

- outline color: Theme text color
- outline width: 4
- outline style: solid
- outline opacity: 1

Built-in fill values for every closed shape are `fillColor: null` and `fillOpacity: 0.15`. Fill controls and fields exist only for rectangle, ellipse, triangle, octagon, parallelogram, and diamond. A null fill always renders with zero effective fill opacity. Line, arrow, coordinate-system, and table defaults cannot store fill fields.

### Arrow Defaults

- start node: none
- end node: arrow
- allowed nodes: none, arrow, triangle, diamond, circle

Line defaults use none for both nodes. Node settings are not shown for other shape types.

### Coordinate-System Defaults

- dimension: 2D
- axis geometry follows [File Format and Geometry](file-format.md)
- no fill

### Table Defaults

- columns: 3
- valid range: 1 through 12
- header height: 30 percent of initial height
- no fill and no data-row separators; each table has exactly one horizontal header separator

## Eraser Defaults

```ts
interface EraserDefaultsV1 {
  radius: number;
}
```

- built-in radius: 24 screen pixels
- valid range: 8 through 64 screen pixels
- adjustment step: 4 pixels

The eraser radius is available in the Eraser Style menu and Settings. It is screen-relative and therefore visually stable while zooming.

## Page Defaults

```ts
interface PageDefaultsV3 {
  backgroundType: "none" | "lines" | "dots" | "squares";
  backgroundSpacing: {
    lines: 25 | 33.333333333333336 | 50 | 100;
    dots: 25 | 33.333333333333336 | 50 | 100;
    squares: 25 | 33.333333333333336 | 50 | 100;
  };
  activeBufferLines: number;
  lockedBufferLines: 1;
}
```

Built-in values:

- background type: Squares
- Lines spacing: S, 25 page units
- Dots spacing: S, 25 page units
- Squares spacing: S, 25 page units
- active buffer lines: 3
- locked compatibility value: 1

Validation:

- active buffer lines: integer from 1 through 8, step 1
- locked compatibility value: current writers use 1; the loader still accepts legacy integers from 0 through 8

The selected background type and all three spacing defaults are independent. A new file copies the selected type, that type's absolute spacing, and the active buffer count into its `PageV1`, then writes the fixed 100-unit layout step and canonical locked value `1`. Locked trailing space and the layout-step size are fixed by the page-extent contract and are not exposed as settings. Switching an existing file to another background type copies that type's current vault spacing into the file through one undoable background command. Later vault-setting changes never mutate existing files.

## Validation Matrix

All numeric ranges are inclusive.

| Field                         | Accepted values                      |  UI step |
| ----------------------------- | ------------------------------------ | -------: |
| Pen or highlighter opacity    | finite number from 0 through 1       |     0.05 |
| Shape outline or fill opacity | finite number from 0 through 1       |     0.05 |
| Pen or highlighter width      | the listed discrete width values     | Discrete |
| Shape outline width           | the listed discrete width values     | Discrete |
| Eraser radius                 | integer from 8 through 64 CSS pixels |        4 |
| Table columns                 | integer from 1 through 12            |        1 |
| Display refresh rate          | auto, 60, 90, 120, 144, or 240       | Discrete |
| Active buffer lines           | integer from 1 through 8             |        1 |
| Enumerations and colors       | exactly one documented value         | Discrete |

Unknown object properties, missing required properties, invalid enum values, non-finite numbers, and values outside these ranges make the containing persisted settings field invalid. The loader replaces only that field with its built-in default, records a non-content diagnostic code, and continues loading the other valid fields.

## File Placement

```ts
type FilePlacementV1 =
  | { mode: "obsidian-attachment-folder" }
  | { mode: "note-folder" }
  | { mode: "custom-vault-folder"; folder: string };
```

The built-in mode is `obsidian-attachment-folder`, falling back to `note-folder` when Obsidian has no attachment folder configured.

Custom folders:

- are normalized as vault-relative paths
- must not be absolute or contain traversal segments
- are limited before normalization to 4,096 UTF-8 bytes, 128 path segments, and 255 UTF-8 bytes per segment
- are created only after explicit user confirmation through Settings
- fall back to the note folder when unavailable

## Device Settings

### Finger Drawing

- device-and-vault-local default: disabled
- when disabled, the per-embed toolbar toggle is hidden
- when enabled, each newly activated embed starts with its local finger-drawing toggle disabled
- the per-embed toggle is session-only and resets on lock

### Pen-Tap Insertion

- default: off
- handwriting mode follows the insertion rules in [Features](features.md)

### Handedness

- default: right-handed layout
- left-handed mode changes only toolbar alignment, not icon order, commands, or canvas coordinates

### Motion

- default: system
- system follows `prefers-reduced-motion`
- full enables all specified transitions
- reduced removes non-essential interpolation while preserving immediate state changes, focus movement, feedback, and final geometry

## Settings UI

The settings tab uses these logical groups and this order:

1. **General**: startup tool, display refresh-rate preference, and file placement. General rows are the first rows and remain unheaded in the rendered Obsidian settings tab as required by the host contract.
2. **Page defaults**: background type, the independent Lines, Dots, and Squares spacing defaults, and the active buffer line count.
3. **Drawing tools**: Pen, Highlighter, Straight highlighter, and Eraser. Each tool is one independently collapsible section.
4. **Shapes and structures**: Line, Arrow, Rectangle, Ellipse, Triangle, Octagon, Parallelogram, Diamond, Coordinate system, and Table. Each tool is one independently collapsible section.
5. **Input**: finger drawing and pen-tap insertion.
6. **Interface**: handedness and motion.

The headings for Page defaults, Drawing tools, Shapes and structures, Input, and Interface use sentence case and omit the word `settings`. The General group has no visible heading, but remains a distinct logical group for definitions, validation, and reset behavior. Every tool default in the schema has exactly one corresponding section, including each shape type's separate persisted entry.

### Collapsible tool sections

Every section in Drawing tools and Shapes and structures is a keyboard-operable disclosure control. Its header contains the tool title on the left and a Lucide chevron on the right. The chevron is the only disclosure indicator: native `<details>` triangles and other leading disclosure markers are not used. The chevron points right when collapsed and down when expanded, and its state is exposed through `aria-expanded` and `aria-controls`. The section content has a stable, unique controlled ID, the title is the accessible name, and the visible focus ring remains on the header. Enter and Space toggle the section without changing a tool value. Sections are independent, so opening one does not close another; users may keep multiple tools open for comparison.

### Menu-recognizable controls

Settings MUST reuse the same typed option models, labels, ordering, selected-state treatment, previews, and control patterns as the corresponding Style and Background menus. A user must be able to recognize a setting from the menu without translating it to a different control. Shared control definitions prevent the two surfaces from acquiring different values or meanings.

Settings inherit Obsidian's neutral `SettingGroup` surface and its host-owned radius rather than adding a nested surface or copying the enclosing border, radius, or panel treatment from an adaptive Style or Background menu. Native host dividers separate independent settings rows. Expanded tool content and the Background type-and-spacing composition use whitespace instead of additional nested separator lines. Menu recognition applies to the control content and interaction model. Visual choice collections use all available inline space and keep their canonical order: choices remain in one row when they fit and wrap without horizontal scrolling when the settings viewport is narrower.

The following controls are visual choices rather than plain dropdowns:

- Colors use the same labelled color swatches and selected state as Style, including Theme text color and the documented palette.
- Outline style uses exactly three buttons, in the same order, with the same solid, dashed, and dotted line previews.
- Pen, highlighter, and outline widths use five evenly sized XS-through-XL choices with real line-width previews. The stored width values remain those in the type definitions and validation matrix.
- Fill uses the same No fill choice, color swatches, selected states, and fill-opacity treatment as Style. Fill is present only for closed shapes.
- Arrow start and end nodes use the same None, Arrow, Triangle, Diamond, and Circle endpoint icons and independent start/end selections.
- Coordinate-system dimension uses the same 2D and 3D axis icons.
- Table columns use the same compact stepper and retain the valid range of 1 through 12.
- Background type uses the same None, Lines, Dots, and Squares pattern choices and previews. Background spacing uses the same padded S/M/L/XL range with the absolute values documented above.

Numeric settings that benefit from continuous adjustment use a slider paired with a directly editable text field, not a dropdown. This applies to opacity, eraser radius, and active buffer lines. The slider and field update each other live, preserve the documented numeric representation and units, and commit one setting change on `change`. Opacity remains a finite normalized value from 0 through 1 even when the field presents a percentage. The field rejects incomplete, non-finite, out-of-range, or otherwise invalid input without persisting it. Background spacing retains the menu's discrete S/M/L/XL slider and visible current-size output. The table stepper remains a discrete numeric control because its bounded integer range is best communicated through increment and decrement actions.

Dropdowns are reserved for discrete values without a meaningful visual preview, such as startup tool, file placement, display refresh rate, pen-tap insertion, and motion. A dropdown MUST NOT replace a shared swatch, width preview, outline-style button group, endpoint or dimension icon group, pattern choice, slider-plus-field control, or table stepper merely for implementation convenience.

All controls have a visible sentence-case label, one concise description, an accessible name, and a visible focus state. Choice controls expose their selected state to assistive technology. Touch targets are at least 44 CSS pixels in the phone settings layout. Multi-field forms use a modal with Save and Cancel only when one row cannot reasonably contain the fields.

### Persistence, validation, and reset behavior

- Invalid values show an inline error and are not persisted. The persisted-data loader repeats the same validation and falls back to the documented built-in default for an invalid field without silently clamping it.
- Each logical group provides `Reset group to defaults`. A final `Reset all Inkbook settings` action requires confirmation. Resetting settings never modifies existing files or elements.
- Tool-default changes update vault defaults immediately. An already active editor keeps every current per-tool session value, so its next elements remain predictable; locking and reopening the editor initializes new session values from the changed defaults. Page-default changes affect only files created afterward. Device-setting changes apply immediately when safe, while an active pointer gesture retains the input mode with which it began.
- The tab uses `PluginSettingTab.getSettingDefinitions()`. Typed `getControlValue()` and `setControlValue()` adapters expose the nested settings object without duplicate flattened state. Simple values use declarative controls, conditional rows use `visible`, and reset actions use declarative actions or a bounded render callback.
- `getSettingDefinitions()` performs no file access or expensive work. Declarative UI validation is repeated during persisted settings loading.

### Settings parity tests

Parity tests MUST enumerate every configurable Style and Background menu value and assert that it has the matching settings default path, value domain, label, ordering, selected state, and recognizable control. They MUST cover the exact three outline-style buttons, all width previews, palette swatches, fill and opacity controls, endpoint and dimension icons, the table stepper, background choices, and S/M/L/XL spacing. Tests MUST also cover slider-and-field synchronization, invalid input rollback, inline errors, group and full reset, persistence failures, accessibility attributes for collapsible sections, and the unchanged vault/session semantics. A parity test fails when a menu option is added without a settings default or when either surface uses a divergent option list.

## Settings Deliberately Not Exposed

Autosave delays, culling margin, spatial-index size, cache size, worker thresholds, animation-frame batching, and serialization precision are implementation constants. Exposing them would complicate support and could undermine the required performance guarantees.

## Related Documentation

- [Implementation specification](specification.md)
- [File format](file-format.md)
- [Editor tools](editor-tools.md)
- [Features](features.md)
- [Quality and testing](quality-and-testing.md)
- [Obsidian integration](obsidian-integration.md)
