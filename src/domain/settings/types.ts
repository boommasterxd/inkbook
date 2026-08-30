export const STARTUP_TOOLS = [
  "select",
  "eraser",
  "draw",
  "highlighter",
  "straight-highlighter",
  "line",
  "arrow",
  "rectangle",
  "ellipse",
  "triangle",
  "octagon",
  "parallelogram",
  "diamond",
  "coordinate-system",
  "table",
] as const;

export const CLOSED_SHAPE_TOOLS = [
  "rectangle",
  "ellipse",
  "triangle",
  "octagon",
  "parallelogram",
  "diamond",
] as const;

export const OUTLINE_ONLY_TOOLS = ["line", "arrow", "coordinate-system", "table"] as const;
export const PEN_WIDTHS = [2, 4, 8, 14, 22] as const;
export const OUTLINE_WIDTHS = [1, 2, 4, 8, 12] as const;
export const OUTLINE_STYLES = ["solid", "dashed", "dotted"] as const;
export const ARROW_NODES = ["none", "arrow", "triangle", "diamond", "circle"] as const;
export const BACKGROUND_TYPES = ["none", "lines", "dots", "squares"] as const;
export const LINE_SPACINGS = [25, 33.333333333333336, 50, 100] as const;
export const PEN_TAP_INSERTIONS = ["off", "handwriting"] as const;
export const MOTION_PREFERENCES = ["system", "full", "reduced"] as const;
export const REFRESH_RATE_PREFERENCES = ["auto", 60, 90, 120, 144, 240] as const;
export const SELECTION_AREAS = ["rectangle", "lasso"] as const;
export const SELECTION_INCLUSIONS = ["fully-enclosed", "touched"] as const;

export type StartupToolV1 = (typeof STARTUP_TOOLS)[number];
export type ClosedShapeToolV1 = (typeof CLOSED_SHAPE_TOOLS)[number];
export type OutlineOnlyToolV1 = (typeof OUTLINE_ONLY_TOOLS)[number];
type PenWidthV1 = (typeof PEN_WIDTHS)[number];
type OutlineWidthV1 = (typeof OUTLINE_WIDTHS)[number];
type OutlineStyleV1 = (typeof OUTLINE_STYLES)[number];
type ArrowNodeV1 = (typeof ARROW_NODES)[number];
export type BackgroundTypeV1 = (typeof BACKGROUND_TYPES)[number];
export type SelectionAreaV1 = (typeof SELECTION_AREAS)[number];
export type SelectionInclusionV1 = (typeof SELECTION_INCLUSIONS)[number];

export type ColorV1 =
  { readonly type: "theme-text" } | { readonly type: "rgba"; readonly value: `#${string}` };

export interface PenDefaultsV1 {
  color: ColorV1;
  width: PenWidthV1;
  opacity: number;
  pressureEnabled: boolean;
}

export interface HighlighterDefaultsV1 {
  color: ColorV1;
  width: PenWidthV1;
  opacity: number;
}

export interface OutlineDefaultsV1 {
  outlineColor: ColorV1;
  outlineWidth: OutlineWidthV1;
  outlineStyle: OutlineStyleV1;
  outlineOpacity: number;
}

export interface ShapeDefaultsV1 extends OutlineDefaultsV1 {
  fillColor: ColorV1 | null;
  fillOpacity: number;
}

interface EraserDefaultsV1 {
  radius: number;
}

export interface ToolDefaultsV1 {
  select: { area: SelectionAreaV1; inclusion: SelectionInclusionV1 };
  pen: PenDefaultsV1;
  highlighter: HighlighterDefaultsV1;
  straightHighlighter: HighlighterDefaultsV1;
  eraser: EraserDefaultsV1;
  shapes: Record<ClosedShapeToolV1, ShapeDefaultsV1> & Record<OutlineOnlyToolV1, OutlineDefaultsV1>;
  arrow: { startNode: ArrowNodeV1; endNode: ArrowNodeV1 };
  coordinateSystem: { dimension: "2d" | "3d" };
  table: { columns: number };
}

interface PageDefaultsV3 {
  backgroundType: BackgroundTypeV1;
  backgroundSpacing: {
    lines: (typeof LINE_SPACINGS)[number];
    dots: (typeof LINE_SPACINGS)[number];
    squares: (typeof LINE_SPACINGS)[number];
  };
  activeBufferLines: number;
  lockedBufferLines: number;
}

export type FilePlacementV1 =
  | { mode: "obsidian-attachment-folder" }
  | { mode: "note-folder" }
  | { mode: "custom-vault-folder"; folder: string };

export type RefreshRatePreferenceV2 = (typeof REFRESH_RATE_PREFERENCES)[number];

export interface InkbookSettingsV4 {
  version: 4;
  startupTool: StartupToolV1;
  toolDefaults: ToolDefaultsV1;
  pageDefaults: PageDefaultsV3;
  filePlacement: FilePlacementV1;
  refreshRatePreference: RefreshRatePreferenceV2;
}

export interface InkbookDeviceSettingsV1 {
  version: 1;
  fingerDrawingEnabled: boolean;
  penTapInsertion: (typeof PEN_TAP_INSERTIONS)[number];
  leftHandedToolbar: boolean;
  motion: (typeof MOTION_PREFERENCES)[number];
}

export interface SettingsDiagnostic {
  readonly code:
    "settings.invalid-field" | "settings.invalid-root" | "settings.unsupported-version";
  readonly path: string;
}

export interface SettingsLoadResult<T> {
  readonly value: T;
  readonly diagnostics: readonly SettingsDiagnostic[];
}
