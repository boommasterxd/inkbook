import {
  CLOSED_SHAPE_TOOLS,
  OUTLINE_ONLY_TOOLS,
  type ColorV1,
  type InkbookDeviceSettingsV1,
  type InkbookSettingsV2,
  type OutlineDefaultsV1,
  type ShapeDefaultsV1,
  type ToolDefaultsV1,
} from "./types";

const THEME_TEXT_COLOR: ColorV1 = Object.freeze({ type: "theme-text" });
const RED_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#EF4444FF" });
const ORANGE_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#F97316FF" });
const YELLOW_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#EAB308FF" });
const GREEN_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#22C55EFF" });
const CYAN_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#06B6D4FF" });
const BLUE_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#3B82F6FF" });
const VIOLET_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#8B5CF6FF" });
const PINK_COLOR: ColorV1 = Object.freeze({ type: "rgba", value: "#EC4899FF" });

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
]);

function outlineDefaults(): OutlineDefaultsV1 {
  return {
    outlineColor: { type: "theme-text" },
    outlineWidth: 4,
    outlineStyle: "solid",
    outlineOpacity: 1,
  };
}

function shapeDefaults(): ShapeDefaultsV1 {
  return { ...outlineDefaults(), fillColor: null, fillOpacity: 0.15 };
}

function toolDefaults(): ToolDefaultsV1 {
  const shapes = Object.fromEntries([
    ...CLOSED_SHAPE_TOOLS.map((tool) => [tool, shapeDefaults()]),
    ...OUTLINE_ONLY_TOOLS.map((tool) => [tool, outlineDefaults()]),
  ]) as ToolDefaultsV1["shapes"];

  return {
    pen: { color: { type: "theme-text" }, width: 8, opacity: 1, pressureEnabled: true },
    highlighter: { color: { type: "rgba", value: "#EAB308FF" }, width: 8, opacity: 0.4 },
    straightHighlighter: {
      color: { type: "rgba", value: "#EAB308FF" },
      width: 8,
      opacity: 0.4,
    },
    eraser: { radius: 24 },
    shapes,
    arrow: { startNode: "none", endNode: "arrow" },
    coordinateSystem: { dimension: "2d" },
    table: { columns: 3 },
  };
}

export function createBuiltInSettings(): InkbookSettingsV2 {
  return {
    version: 2,
    startupTool: "draw",
    toolDefaults: toolDefaults(),
    pageDefaults: {
      backgroundType: "squares",
      backgroundSpacing: { lines: 100, dots: 40, squares: 40 },
      writingLineHeight: 100,
      activeBufferLines: 3,
      lockedBufferLines: 1,
    },
    filePlacement: { mode: "obsidian-attachment-folder" },
    refreshRatePreference: "auto",
  };
}

export function createBuiltInDeviceSettings(): InkbookDeviceSettingsV1 {
  return {
    version: 1,
    fingerDrawingEnabled: false,
    penTapInsertion: "off",
    leftHandedToolbar: false,
    motion: "system",
  };
}
