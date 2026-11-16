import {
  CLOSED_SHAPE_TOOLS,
  DEFAULT_SCROLL_PRELOAD_MARGIN_PX,
  LINE_SPACINGS,
  OUTLINE_WIDTHS,
  OUTLINE_ONLY_TOOLS,
  PEN_WIDTHS,
  type InkbookDeviceSettingsV2,
  type InkbookSettingsV4,
  type OutlineDefaultsV1,
  type ShapeDefaultsV1,
  type ToolDefaultsV1,
} from "./types";
import { createBuiltInKeyboardShortcuts } from "./keyboard-shortcuts";
import { DEFAULT_INK_COLOR } from "./color-palette";

export { BUILT_IN_COLORS } from "./color-palette";

function outlineDefaults(): OutlineDefaultsV1 {
  return {
    outlineColor: { ...DEFAULT_INK_COLOR },
    outlineWidth: OUTLINE_WIDTHS[1],
    outlineStyle: "solid",
    outlineOpacity: 1,
  };
}

function shapeDefaults(): ShapeDefaultsV1 {
  return { ...outlineDefaults(), fillColor: null, fillOpacity: 0.5 };
}

function toolDefaults(): ToolDefaultsV1 {
  const shapes = Object.fromEntries([
    ...CLOSED_SHAPE_TOOLS.map((tool) => [tool, shapeDefaults()]),
    ...OUTLINE_ONLY_TOOLS.map((tool) => [tool, outlineDefaults()]),
  ]) as ToolDefaultsV1["shapes"];

  return {
    text: {
      fontFamily: "inter",
      fontSize: 24,
      color: { ...DEFAULT_INK_COLOR },
      opacity: 1,
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
      backgroundColor: null,
      backgroundOpacity: 1,
      alignment: "left",
    },
    select: { area: "lasso", inclusion: "touched" },
    pen: {
      color: { ...DEFAULT_INK_COLOR },
      width: PEN_WIDTHS[1],
      opacity: 1,
      pressureEnabled: true,
      holdToShapeEnabled: true,
    },
    highlighter: {
      color: { type: "rgba", value: "#EAB308FF" },
      width: PEN_WIDTHS[2],
      opacity: 0.4,
    },
    straightHighlighter: {
      color: { type: "rgba", value: "#EAB308FF" },
      width: PEN_WIDTHS[2],
      opacity: 0.4,
    },
    eraser: { radius: 20 },
    shapes,
    line: { snappingEnabled: true },
    arrow: { startNode: "none", endNode: "arrow", snappingEnabled: true },
    coordinateSystem: { dimension: "2d" },
    table: { columns: 2 },
  };
}

export function createBuiltInSettings(): InkbookSettingsV4 {
  return {
    copyTextFieldsAsText: false,
    version: 4,
    fontLibrary: [],
    startupTool: "draw",
    selectionHighlightsEnabled: true,
    toolDefaults: toolDefaults(),
    snapping: {
      enabled: true,
      angles: true,
      bends: true,
      connections: true,
      structures: true,
    },
    holdToShape: { enabled: true, holdDurationMs: 400, jitterTolerancePx: 20 },
    pageDefaults: {
      backgroundType: "squares",
      backgroundSpacing: {
        lines: LINE_SPACINGS[2],
        dots: LINE_SPACINGS[1],
        squares: LINE_SPACINGS[1],
      },
      activeBufferLines: 3,
      lockedBufferLines: 1,
    },
    filePlacement: { mode: "obsidian-attachment-folder" },
    refreshRatePreference: "auto",
  };
}

export function createBuiltInDeviceSettings(): InkbookDeviceSettingsV2 {
  return {
    version: 2,
    onboardingDismissed: false,
    readableLineWidthWarningDismissed: false,
    scrollPreloadMarginPx: DEFAULT_SCROLL_PRELOAD_MARGIN_PX,
    fingerDrawingEnabled: false,
    penTapInsertion: "off",
    leftHandedToolbar: false,
    motion: "system",
    language: "auto",
    keyboardShortcuts: createBuiltInKeyboardShortcuts(),
  };
}
