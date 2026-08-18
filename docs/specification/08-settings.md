# Settings

## 1. Settings Principles

Inkbook uses Obsidian's normal plugin settings surface. It MUST NOT implement a standalone Settings screen or custom shortcut editor. Under the 1.8.7 baseline, one imperative `PluginSettingTab.display()` built from Obsidian `Setting` controls is authoritative. The plugin MUST NOT depend on `getSettingDefinitions()`, which requires Obsidian 1.13.0 or newer.

Settings have one of four scopes:

- `plugin-global`: stored through Obsidian `loadData()` and `saveData()`, potentially synchronized when the user synchronizes plugin configuration;
- `device-local`: stored through a validated adapter over `App.loadLocalStorage()` and `App.saveLocalStorage()`, scoped to the current Vault installation on that device and never assumed to synchronize;
- `per-note`: stored in the annotation sidecar and edited from the toolbar or stylebar, not from Obsidian Settings;
- `runtime`: transient and never persisted.

Every stored settings object is versioned, strictly validated, and published as one complete immutable snapshot. `loadData()` and `loadLocalStorage()` results are nullable untrusted input and are validated and migrated before the settings tab is registered or any view consumes them. Invalid device-local data falls back to safe defaults without preventing plugin startup. `saveLocalStorage()` is synchronous, may throw, and is not described as transactional. A failed write keeps the chosen value active for the session, shows persistent Retry, and never claims persistence.

`activeWindow` MUST NOT own view-scoped resources. View-owned DOM, events, and timers use the concrete root's `element.doc` and `element.win`. Host-owned settings resources use the concrete settings container's document and window. No window object is settings persistence authority. Obsidian 1.8.7 exposes no public cross-device plugin-data change event that Inkbook may assume. A verified host capability may notify the settings adapter, which then reloads, migrates, validates, and atomically publishes the complete snapshot. Without that capability, Inkbook reloads at plugin load and whenever its settings tab is reopened; it MUST NOT poll the Vault or claim live external synchronization. Invalid reloaded data retains the last valid snapshot and shows Retry.

## 2. General

| Setting              | Type and values                          | Default                                    | Scope         | Purpose                                                                                               |
| -------------------- | ---------------------------------------- | ------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------- |
| Toolbar presentation | `floating` or `docked`                   | `floating`                                 | Device-local  | Chooses the note toolbar and stylebar surface.                                                        |
| Toolbar visibility   | `always`, `annotated-notes`, or `manual` | `always`                                   | Device-local  | Controls when the note toolbar is mounted. Manual mode remains reachable through an Obsidian command. |
| Toolbar tool order   | `ToolbarOrderV1`                         | Canonical order from Interaction and Tools | Plugin-global | Orders tools within the fixed primary and More Tools groups.                                          |
| Dominant hand        | `auto`, `left`, or `right`               | `auto`                                     | Device-local  | Adjusts compact overflow and edge placement without changing the configured tool order.               |

Inkbook MUST inherit Obsidian theme, font, locale, accent, and reduced-motion settings. It MUST NOT duplicate them.

The actual settings UI uses sentence-case labels and starts directly with the controls below. It MUST NOT render a redundant top-level `General` heading; this document heading is organizational only.

### 1.1 Canonical Settings Records

```ts
export type SettingsRevision = number & {
  readonly __brand: "SettingsRevision";
};

export interface PluginSettingsV1 {
  readonly version: 1;
  readonly revision: SettingsRevision;
  readonly toolbarOrder: ToolbarOrderV1;
  readonly penDefaults: PenStyleV1;
  readonly highlighterDefaults: HighlighterStyleV1;
  readonly shapeDefaults: ShapeStyleV1;
  readonly lineDefaults: LinearStyleV1;
  readonly arrowDefaults: LinearStyleV1;
  readonly connectorDefaults: LinearStyleV1;
  readonly constructionDefaults: ConstructionStyleV1;
  readonly tableRows: number;
  readonly tableColumns: number;
  readonly axesDimensions: "2d" | "3d";
  readonly axesGridDivisions: number;
  readonly defaultNoteAppearance: NoteAppearanceV1;
  readonly sidecarStoragePolicy: SidecarStoragePolicyV1;
  readonly sidecarSyncAcknowledged: boolean;
}

export interface RememberedZoomV1 {
  readonly vaultRelativeMarkdownPath: string;
  readonly zoomPercent: number;
  readonly lastFocusedEpochMs: number;
}

export interface DeviceSettingsV1 {
  readonly version: 1;
  readonly revision: SettingsRevision;
  readonly toolbarPresentation: "floating" | "docked";
  readonly toolbarVisibility: "always" | "annotated-notes" | "manual";
  readonly dominantHand: "auto" | "left" | "right";
  readonly strokeInputMode: "auto" | "pen" | "mouse";
  readonly barrelButtonErases: boolean;
  readonly hapticFeedback: boolean;
  readonly eraserRadiusScreenPx: number;
  readonly defaultZoomPercent: number;
  readonly rememberZoomPerNote: boolean;
  readonly rememberedZoom: readonly RememberedZoomV1[];
  readonly debugLogging: boolean;
  readonly performanceOverlay: boolean;
}
```

Both revisions start at `1` and increase by one for each accepted replacement of that complete store. The application validates `expectedRevision`, constructs and publishes one immutable replacement snapshot, serializes writes per store, and never exposes a partially changed object. A failed persistence write retains that replacement as session-only with Retry and does not advance the acknowledged durable snapshot. Reload validates the complete object before publication. Future versions require explicit migration; an unsupported newer version preserves the raw host value, loads safe V1 defaults for the session, reports read-only settings incompatibility, and MUST NOT overwrite the newer value automatically.

The canonical plugin-global defaults are the toolbar order in Section 2.1, Pen `currentColor`, width `3`, opacity `1`, solid, pointer pressure enabled, smoothing `0.50`, streamline `0.50`, thinning `0.50`, and stroke profile `1`; Highlighter `#ffd84dff`, width `12`, opacity `0.35`, solid, freehand; Shape `currentColor`, width `2`, opacity `1`, solid, no fill; Line `currentColor`, width `2`, opacity `1`, solid, no caps, cap size `8`; Arrow the same with only end cap arrow; Connector the same as Line; construction `currentColor`, width `2`, opacity `1`, solid, positive cap arrow, cap size `8`; Table `3` by `3`; axes 2D with `0` grid divisions; note appearance none, standard, low; adjacent storage; and sync acknowledgement false. Pen and Highlighter dash MUST remain solid.

The canonical device-local defaults are floating, always visible, auto dominant hand, auto input, barrel erase on, haptics on, eraser radius `12`, zoom `100`, remember zoom on, empty remembered map, debug logging off, and performance overlay off. Stored zoom is from `50` through `400`, timestamps are non-negative safe integers, paths pass the same normalized identity-hint validation as other device-local records, entries are unique by path, and the array contains at most 100 entries in descending last-focused order.

### 2.1 Toolbar Order

```ts
export type ToolbarToolId =
  | "cursor"
  | "lasso"
  | "pen"
  | "highlighter"
  | "eraser"
  | "rectangle"
  | "arrow"
  | "line-highlighter"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "octagon"
  | "line"
  | "connector"
  | "coordinate-system"
  | "table";

export interface ToolbarOrderV1 {
  readonly version: 1;
  readonly primary: readonly ToolbarToolId[];
  readonly more: readonly ToolbarToolId[];
}
```

Across both arrays, every known annotation tool MUST occur exactly once and in its fixed group from [Interaction and Tools](02-interaction-and-tools.md). Unknown IDs, duplicates, missing IDs, wrong-group membership, non-array data, and unsupported versions fail validation. Undo, Redo, Background, Zoom, and Settings are utility controls and MUST NOT occur in this object.

When no order is stored, the canonical default is used. A supported older version preserves the relative order of recognized tools and appends newly introduced tools to their canonical group in canonical order. Unknown legacy IDs are discarded during that explicit migration. Malformed data or an unsupported newer version falls back atomically to the canonical default and reports a non-blocking load warning.

The settings UI provides labelled `Primary toolbar` and `More Tools menu` lists with Move up, Move down, and Reset to default actions. It does not expose add or remove actions because membership is fixed. Drag and drop MAY be an additional interaction but is never the only one. Focus remains on the moved item, its new position is announced, and compact targets remain at least 44 by 44 CSS pixels.

An accepted change updates every mounted note view immediately and creates no Markdown, sidecar, scene, selection, or history mutation. If `saveData()` fails, the session value remains active under the general Retry contract and is not described as durable.

## 3. Input and Stylus

| Setting              | Type and values                                         | Default   | Scope         | Purpose                                                                                                                          |
| -------------------- | ------------------------------------------------------- | --------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Stroke input mode    | `auto`, `pen`, or `mouse`                               | `auto`    | Device-local  | Handles devices that report stylus input incorrectly.                                                                            |
| Barrel button erases | Boolean                                                 | `true`    | Device-local  | Temporarily invokes the eraser while a supported stylus barrel button is held.                                                   |
| Haptic feedback      | Boolean                                                 | `true`    | Device-local  | Provides short feedback for tool or selection changes on capable devices. Unsupported devices ignore it.                         |
| Pen pressure         | `pointer` or `constant`, edited as an On or Off control | `pointer` | Plugin-global | Reads and replaces `penDefaults.pressure`, the sole persisted authority. The active value remains available in the Pen stylebar. |

There is no Finger Drawing setting. Touch on a plugin element always selects it. One finger on empty note space remains available for native Obsidian scrolling; a recognized two-finger pinch controls plugin whole-note zoom. There is no Pen in Text setting because Cursor is the native Obsidian text mode.

## 4. Tool Defaults

Tool defaults are plugin-global presets. A change affects future elements, not existing elements unless they are selected explicitly.

Automatic text binding has no plugin setting. The inference profile, distance limits, overlap thresholds, candidate limits, confidence rules, and tie-breaking are fixed versioned domain behavior so the same gesture and layout evidence produce the same result on every device. Per-element binding is sidecar state corrected through the selection stylebar, not a plugin-global or device-local preference.

### 4.1 Pen

- color, default `currentColor`;
- width, default 3 note CSS pixels;
- opacity, default 100 percent;
- pressure, default `pointer` and owned only by `penDefaults.pressure`;
- smoothing, streamline, and thinning, each default `0.50`, bounded to `[0, 1]`, and quantized to `0.01`.

### 4.2 Highlighter

- color, default `#ffd84dff`;
- width, default 12 note CSS pixels;
- opacity, default 35 percent;
- freehand or straight-line variant, default freehand.

Highlighter width is constant and has no pressure setting.

### 4.3 Shapes

- outline color, default `currentColor`;
- outline width, default 2 note CSS pixels;
- opacity, default 100 percent;
- dash pattern, default solid;
- fill, default none.

### 4.4 Lines, Arrows, and Connectors

- line color, width, opacity, and dash pattern;
- start cap, default none;
- end cap, default arrow for Arrow and none for Line or Connector;
- Line and Arrow curve mode, default straight; Connector remains straight in V1 and has no curve-mode setting.

### 4.5 Eraser and Lasso

- eraser radius, default 12 screen CSS pixels and bounded from 4 through 96;
- eraser behavior, fixed to whole-element deletion in V1;
- lasso selection mode, fixed to geometry intersection for strokes and 50 percent coverage for bounded objects in V1.

Lasso behavior is not user-configurable until multiple modes have clear accessibility and predictability benefits.

### 4.6 Tables and Axes

- Table rows, default 3 and bounded from 1 through 200;
- Table columns, default 3 and bounded from 1 through 200;
- Coordinate system dimensions, default 2D and selectable as 2D or 3D in the active-tool stylebar;
- axis grid divisions, default 0 and bounded from 0 through 64;
- axes positive-end cap, default arrow;
- shared construction line style from Shapes and Lines.

These plugin-global values initialize future construction elements only. The active Table tool may change its `Rows` and `Columns` creation defaults for subsequent Tables. Selecting an existing Table exposes and edits that object's canonical divider-derived counts without changing either global default. A Table's divider-derived row and column counts and an axes object's grid density are canonical per-element sidecar state. `Coordinate system` is one toolbar tool. Its active-tool stylebar initializes new elements as 2D or 3D from this default. A created object's dimension is canonical per-element state and read-only in V1.

## 5. Note Appearance and Zoom

| Setting                               | Type and values                         | Default     | Scope         | Purpose                                                                         |
| ------------------------------------- | --------------------------------------- | ----------- | ------------- | ------------------------------------------------------------------------------- |
| Default note background               | `none`, `ruled`, `squared`, or `dotted` | `none`      | Plugin-global | Initializes a note when annotations are first created.                          |
| Default horizontal background spacing | `compact`, `standard`, or `wide`        | `standard`  | Plugin-global | Sets horizontal grid density. Vertical spacing always follows body line height. |
| Default background contrast           | `low`, `medium`, or `high`              | `low`       | Plugin-global | Controls background visibility within accessible theme bounds.                  |
| Default whole-note zoom               | 50 to 400 percent                       | 100 percent | Device-local  | Initial zoom for notes without remembered device-local zoom.                    |
| Remember zoom per note                | Boolean                                 | `true`      | Device-local  | Keeps a bounded device-only map of recent note zoom values.                     |

The remembered zoom map is limited to 100 notes using least-recently-used eviction. It contains Vault-relative identity hints only and never annotation content.

Zoom remains view-local after a pane opens. The most recently focused view is the only view allowed to update the remembered value for that note. Other panes may diverge without overwriting it until they receive focus.

Background selected for a particular note, its effective spacing preset, and its contrast override are per-note sidecar state. The actual measured vertical line height is derived and MUST NOT be persisted.

For squared and dotted backgrounds, compact, standard, and wide mean horizontal periods of exactly `0.75`, `1.00`, and `1.25` times the measured body line height. Ruled backgrounds retain the preset but render no vertical pattern. Every vertical period, baseline phase, line width, and dot size is derived from current Obsidian metrics under [Anchors and Layout](05-anchors-and-layout.md), not stored as a setting.

## 6. Storage and Recovery

```ts
export type SidecarStoragePolicyV1 =
  | { readonly version: 1; readonly mode: "adjacent" }
  | {
      readonly version: 1;
      readonly mode: "vault-root";
      readonly vaultRelativeRoot: string;
    };
```

| Setting or action         | Type and values                           | Default                                           | Scope         | Purpose                                                                                                 |
| ------------------------- | ----------------------------------------- | ------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| Sidecar location          | `adjacent` or `vault-root`                | `adjacent`                                        | Plugin-global | Selects where newly annotated notes create sidecars.                                                    |
| Sidecar folder            | Validated non-empty Vault-relative folder | `Annotations` when `vault-root` is first selected | Plugin-global | Supplies the root below which the Markdown directory structure is mirrored.                             |
| Migrate existing sidecars | Confirmed bounded action                  | No automatic run                                  | Runtime       | Moves validated existing sidecars to the currently selected policy through the durable relocation flow. |

`Sidecar folder` is visible and required only for `vault-root`. The control shows the resulting path for an example and the current note. It rejects absolute paths, path traversal, backslashes, NUL, empty or dot segments, `.obsidian`, hidden segments, a file in place of a folder, and paths that normalize outside the Vault. The plugin creates missing validated folders only when a first sidecar or confirmed migration needs them. It uses no operating-system path picker and no direct file-system API.

Saving a new policy changes the default for future sidecars after `saveData()` acknowledges it. It does not move existing files. Each existing note continues to follow its validated `inkbook-sidecar` YAML locator, including on another device with a different current default. `Migrate existing sidecars` always presents scope, count, collisions, and progress before mutation; it is cancellable between sidecars, resumable after failure, and never runs at startup. The exact path, locator, rename, sync, and migration contracts are owned by [Sidecar Persistence](07-sidecar-persistence.md).

If the host renames the configured root, the replacement policy is validated and persisted before any new sidecar may be created. Until `saveData()` acknowledges the new root, the UI shows persistent Retry and creation is blocked under both paths. Inkbook never silently recreates the old folder.

The same group also contains these status and maintenance actions:

- show the fixed sidecar suffix `.inkbook.json` and the resolved current-note location;
- show whether the user has acknowledged that the selected sync configuration must include other file types and that unsupported providers may exclude sidecars;
- validate the current note's sidecar;
- list bounded orphan-sidecar candidates discovered from explicit user action;
- retry a failed current-note save;
- clear device-local recovery data after confirmation;
- remove annotations from the current note after destructive confirmation.

Autosave delay, parser limits, conflict policy, YAML key names, recovery budgets, and the `.inkbook.json` suffix are not settings. Only the validated storage policy above controls location.

## 7. Advanced and Diagnostics

| Setting or action      | Default | Scope                | Purpose                                                                                                              |
| ---------------------- | ------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Debug logging          | Off     | Device-local         | Emits bounded lifecycle and timing events without note text, anchor context, stroke points, paths, or file contents. |
| Performance overlay    | Off     | Device-local         | Shows frame, mounted-element, cache, and save metrics for development.                                               |
| Export diagnostics     | Action  | Runtime              | Exports versions, capabilities, sanitized errors, and aggregate timings only.                                        |
| Reset Inkbook settings | Action  | Both settings stores | Resets after confirmation while preserving all note sidecars.                                                        |

No diagnostics mode may enable network transmission or content logging implicitly. V1 stores no secret. Any future secret capability requires Obsidian `SecretStorage` and `SecretComponent` plus a reviewed product change; secrets MUST NOT enter plugin data, local storage, sidecars, diagnostics, or logs.

## 8. Commands and Hotkeys

Inkbook registers lightweight named Obsidian commands during `onload()` for toolbar visibility, tools, non-history annotation operations, select next and previous annotation, zoom, background, sidecar validation, migration, and annotation removal. Command IDs are stable ASCII identifiers without a redundant `inkbook-` prefix. It registers no annotation-only Undo or Redo command. Commands that require an editor use `editorCallback` or `editorCheckCallback` and the supplied originating editor and view. A `checking: true` callback performs no mutation.

Obsidian's Hotkeys settings own bindings and conflict resolution. The plugin MUST NOT store custom shortcut bindings in its own settings and public releases ship no default hotkeys. A later reviewed exception uses Obsidian's `Mod` abstraction and uppercase letter keys and MUST NOT override common native Markdown editing, navigation, search, or application commands.

## 9. Excluded Legacy Settings

The new plugin MUST NOT carry forward settings for Writing or Drawing subfolders, SVG attachment folders, embeds, frame locking, page formats, page backgrounds, custom app theme, app locale, app accent, separate text boxes, image import, PDF or web content, search, export, or responsive breakpoints.

Migration code MAY remove obsolete keys from earlier internal prototypes after preserving the validated settings that still map to this specification.

A future declarative-settings migration follows one of two explicit paths: raise `minAppVersion` to at least 1.13.0 and remove `display()`, or maintain behaviorally identical imperative and declarative implementations with versioned contract tests. No release may expose divergent settings semantics across supported Obsidian versions.
