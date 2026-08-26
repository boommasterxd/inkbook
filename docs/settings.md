# Settings Specification

## Principles

- Settings expose stable user preferences, not internal performance tuning.
- Every value available in a tool's Style flyout MUST have a configurable default for that tool.
- Changing a default affects newly created elements only. It never rewrites existing elements.
- Settings UI rejects invalid values and does not persist them. On load, an invalid persisted field falls back to its documented built-in default; the loader does not silently clamp it. Versioned migrations may explicitly map a formerly valid numeric value into a new range.
- Settings migrations are pure and versioned separately from the document format.

## Scope and Precedence

Settings have four scopes:

| Scope            | Storage                | Examples                                                                  |
| ---------------- | ---------------------- | ------------------------------------------------------------------------- |
| Vault            | Obsidian plugin data   | Tool defaults, page defaults, file placement, display refresh-rate mode   |
| Device and vault | Obsidian local storage | Finger drawing, pen-tap insertion, handedness, motion preference          |
| File             | Editable SVG snapshot  | Current background type and spacing, element styles                       |
| Session          | Memory only            | Current tool, current flyout values, finger toggle, zoom, camera position |

Vault settings use `Plugin.loadData()` and `Plugin.saveData()`. Device settings use `App.loadLocalStorage("inkbook:device-settings:v1")` and `App.saveLocalStorage(...)`. They are local to the current device and vault and contain preferences only, never vault paths, note content, clipboard data, or ink data.

Precedence from highest to lowest:

1. an explicit change applied to the current selection
2. the current session value for the active tool
3. the vault default for that tool
4. the built-in default in this document

On editor activation, session tool values are initialized from vault defaults. Switching tools restores that tool's own session values. File background values come from the file and are not replaced by vault defaults after creation.

## Settings Root

```ts
interface InkbookSettingsV2 {
  version: 2;
  startupTool: StartupToolV1;
  toolDefaults: ToolDefaultsV1;
  pageDefaults: PageDefaultsV1;
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

Version 1 vault settings migrate to version 2 by adding `refreshRatePreference: "auto"`; every existing tool, page, and placement value is preserved. The device-settings schema remains version 1.

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

Pressure sensitivity is shown in the pen Style flyout and in Settings. Smoothing remains an implementation constant in version 1 to avoid exposing a low-level performance control.

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
  outlineWidth: 2 | 4 | 8 | 12;
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

The eraser radius is available in the Eraser Style flyout and Settings. It is screen-relative and therefore visually stable while zooming.

## Page Defaults

```ts
interface PageDefaultsV1 {
  backgroundType: "none" | "lines" | "dots" | "squares";
  backgroundSpacing: {
    lines: 50 | 100 | 150 | 200;
    dots: 20 | 40 | 60 | 80;
    squares: 20 | 40 | 60 | 80;
  };
  writingLineHeight: number;
  activeBufferLines: number;
  lockedBufferLines: 1;
}
```

Built-in values:

- background type: Squares
- Lines spacing: M, 100 page units
- Dots spacing: M, 40 page units
- Squares spacing: M, 40 page units
- writing line height: 100 page units
- active buffer lines: 3
- locked compatibility value: 1

Validation:

- writing line height: integer from 50 through 200 page units, step 10
- active buffer lines: integer from 1 through 8, step 1
- locked compatibility value: current writers use 1; the loader still accepts legacy integers from 0 through 8

The selected background type and all three spacing defaults are independent. A new file copies the selected type, that type's spacing, writing-line height, and active buffer count into its `PageV1`, then writes the canonical locked compatibility value `1`. Locked trailing space is fixed by the page-extent contract and is not exposed as a setting. Switching an existing file to another background type copies that type's current vault spacing into the file through one undoable background command. Later vault-setting changes never mutate existing files.

## Validation Matrix

All numeric ranges are inclusive.

| Field                         | Accepted values                        |  UI step |
| ----------------------------- | -------------------------------------- | -------: |
| Pen or highlighter opacity    | finite number from 0 through 1         |     0.05 |
| Shape outline or fill opacity | finite number from 0 through 1         |     0.05 |
| Pen or highlighter width      | the listed discrete width values       | Discrete |
| Shape outline width           | the listed discrete width values       | Discrete |
| Eraser radius                 | integer from 8 through 64 CSS pixels   |        4 |
| Table columns                 | integer from 1 through 12              |        1 |
| Writing-line height           | integer from 50 through 200 page units |       10 |
| Display refresh rate          | auto, 60, 90, 120, 144, or 240         | Discrete |
| Active buffer lines           | integer from 1 through 8               |        1 |
| Enumerations and colors       | exactly one documented value           | Discrete |

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

Settings appear in this order:

1. Unheaded general rows: startup tool, file placement, background, page buffer
2. Pen
3. Highlighter
4. Straight highlighter
5. Shapes, with one collapsible subsection per shape type
6. Eraser
7. Input: finger drawing and pen-tap insertion
8. Interface: handedness and motion

Requirements:

- Every control has a visible label, concise description, and accessible name.
- Invalid values show an inline error and are not persisted.
- Each group provides `Reset group to defaults`.
- A final `Reset all Inkbook settings` action requires confirmation.
- Resetting settings does not modify existing files or elements.
- Tool-default changes update the vault defaults immediately. An already active editor keeps every current per-tool session value, so its next elements remain predictable; locking and reopening the editor initializes new session values from the changed defaults. Page-default changes affect only files created afterward. Device-setting changes apply immediately when safe, while an active pointer gesture retains the input mode with which it began.
- The tab uses `PluginSettingTab.getSettingDefinitions()`. Typed `getControlValue()` and `setControlValue()` adapters expose the nested settings object without duplicating it. Simple values use declarative controls, conditional rows use `visible`, and reset actions use declarative actions or a bounded render callback.
- `getSettingDefinitions()` performs no file access or expensive work. Declarative UI validation is repeated during persisted settings loading.
- Visible text uses sentence case. General rows have no heading, later distinct sections use headings without the word `settings`, every row has one mutable control, and complex multi-field input moves to a modal.

## Settings Deliberately Not Exposed

Autosave delays, culling margin, spatial-index size, cache size, worker thresholds, animation-frame batching, and serialization precision are implementation constants. Exposing them would complicate support and could undermine the required performance guarantees.

## Related Documentation

- [Implementation specification](specification.md)
- [File format](file-format.md)
- [Editor tools](editor-tools.md)
- [Features](features.md)
- [Quality and testing](quality-and-testing.md)
- [Obsidian integration](obsidian-integration.md)
