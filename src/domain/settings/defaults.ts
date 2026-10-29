import {
  CLOSED_SHAPE_TOOLS,
  DEFAULT_SCROLL_PRELOAD_MARGIN_PX,
  LINE_SPACINGS,
  OUTLINE_WIDTHS,
  OUTLINE_ONLY_TOOLS,
  PEN_WIDTHS,
  type ColorV1,
  type InkbookDeviceSettingsV2,
  type InkbookSettingsV4,
  type OutlineDefaultsV1,
  type ShapeDefaultsV1,
  type ToolDefaultsV1,
} from "./types";
import { createBuiltInKeyboardShortcuts } from "./keyboard-shortcuts";

const THEME_TEXT_COLOR: ColorV1 = Object.freeze({ type: "theme-text" });
const RED_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#EF4444FF" });
const ORANGE_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#F97316FF" });
const YELLOW_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#EAB308FF" });
const GREEN_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#22C55EFF" });
const CYAN_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#06B6D4FF" });
const BLUE_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#3B82F6FF" });
const VIOLET_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#8B5CF6FF" });
const PINK_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#EC4899FF" });
const GRAY_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#6B7280FF" });

export const BUILT_IN_COLORS = Object.freeze([
  THEME_TEXT_COLOR,
  RED_COLOR,
  ORANGE_COLOR,
  YELLOW_COLOR,
  GREEN_COLOR,
  CYAN_COLOR,
  BLUE_COLOR,
  VIOLET_COLOR,
  PINK_COLOR,
  GRAY_COLOR,
]);

function outlineDefaults(): OutlineDefaultsV1 {
  return {
    outlineColor: { type: "theme-text" },
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
    select: { area: "lasso", inclusion: "touched" },
    pen: {
      color: { type: "theme-text" },
      width: PEN_WIDTHS[1],
      opacity: 1,
      pressureEnabled: true,
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
    arrow: { startNode: "none", endNode: "arrow" },
    coordinateSystem: { dimension: "2d" },
    table: { columns: 2 },
  };
}

export function createBuiltInSettings(): InkbookSettingsV4 {
  return {
    version: 4,
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
    scrollPreloadMarginPx: DEFAULT_SCROLL_PRELOAD_MARGIN_PX,
    fingerDrawingEnabled: false,
    penTapInsertion: "off",
    leftHandedToolbar: false,
    motion: "system",
    keyboardShortcuts: createBuiltInKeyboardShortcuts(),
  };
}
