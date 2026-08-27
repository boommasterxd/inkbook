import type { PageV1 } from "../../../domain/schema/public";
import type { InkbookSettingsV3 } from "../../../domain/settings/types";
import type { EditorTool, PointerSample } from "../../../editor/input/index";
import type {
  BackgroundSpacing,
  BackgroundType,
  ToolbarAction,
  ToolId,
  ShapeId,
  ToolbarState,
} from "../../../rendering/ui/index";

const SPACING_VALUES = {
  lines: { s: 25, m: 33.333333333333336, l: 50, xl: 100 },
  pattern: { s: 25, m: 33.333333333333336, l: 50, xl: 100 },
} as const;

export function isTool(action: ToolbarAction): action is ToolId {
  return (
    action === "select" ||
    action === "eraser" ||
    action === "draw" ||
    action === "highlighter" ||
    action === "straight-highlighter" ||
    action === "shape"
  );
}

export function isShapeTool(tool: EditorTool): tool is ShapeId {
  return toolbarTool(tool) === "shape";
}

function toolbarTool(tool: EditorTool): ToolId {
  return tool === "line" ||
    tool === "arrow" ||
    tool === "rectangle" ||
    tool === "ellipse" ||
    tool === "triangle" ||
    tool === "octagon" ||
    tool === "parallelogram" ||
    tool === "diamond" ||
    tool === "coordinate-system" ||
    tool === "table"
    ? "shape"
    : tool;
}

export function normalizePointerType(pointerType: string): PointerSample["pointerType"] {
  return pointerType === "pen" || pointerType === "touch" ? pointerType : "mouse";
}

interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData: { readonly platform: string };
}

export function isMacPlatform(navigator: Navigator): boolean {
  return hasUserAgentData(navigator) && /macOS|iOS/u.test(navigator.userAgentData.platform);
}

function hasUserAgentData(navigator: Navigator): navigator is NavigatorWithUserAgentData {
  if (!("userAgentData" in navigator)) return false;
  const data: unknown = navigator.userAgentData;
  return typeof data === "object" && data !== null && "platform" in data;
}

export function backgroundState(page: PageV1): {
  readonly spacing: BackgroundSpacing | null;
  readonly type: BackgroundType;
} {
  if (page.background.type === "none") return { spacing: null, type: "none" };
  const currentSpacing = page.background.spacing;
  const values = page.background.type === "lines" ? SPACING_VALUES.lines : SPACING_VALUES.pattern;
  const spacing = (Object.entries(values).find(([, value]) => value === currentSpacing)?.[0] ??
    "m") as BackgroundSpacing;
  return { spacing, type: page.background.type };
}

export type BackgroundSpacingDefaults = InkbookSettingsV3["pageDefaults"]["backgroundSpacing"];

function backgroundForType(
  type: BackgroundType,
  defaults: BackgroundSpacingDefaults,
): PageV1["background"] {
  if (type === "none") return { type };
  if (type === "lines") return { type, spacing: defaults.lines };
  if (type === "dots") return { type, spacing: defaults.dots };
  return { type, spacing: defaults.squares };
}

export function pageWithBackgroundSpacing(page: PageV1, spacing: BackgroundSpacing): PageV1 | null {
  if (page.background.type === "none") return null;
  const background =
    page.background.type === "lines"
      ? { type: "lines" as const, spacing: SPACING_VALUES.lines[spacing] }
      : { type: page.background.type, spacing: SPACING_VALUES.pattern[spacing] };
  return { ...page, background };
}

export function pageWithBackgroundType(
  page: PageV1,
  type: BackgroundType,
  defaults: BackgroundSpacingDefaults,
): PageV1 {
  if (page.background.type === type) return page;
  return { ...page, background: backgroundForType(type, defaults) };
}

export function createToolbarState(options: {
  activeTool: EditorTool;
  canPaste: boolean;
  canRedo: boolean;
  canUndo: boolean;
  fingerDrawingEnabled: boolean;
  fingerDrawingAvailable: boolean;
  hasSelection: boolean;
  openFlyout: ToolbarState["openFlyout"];
}): ToolbarState {
  return {
    activeTool: toolbarTool(options.activeTool),
    canPaste: options.canPaste,
    canRedo: options.canRedo,
    canUndo: options.canUndo,
    fingerDrawingAvailable: options.fingerDrawingAvailable,
    fingerDrawingEnabled: options.fingerDrawingEnabled,
    hasSelection: options.hasSelection,
    openFlyout: options.openFlyout,
  };
}
