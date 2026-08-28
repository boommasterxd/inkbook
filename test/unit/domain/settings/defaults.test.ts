import { describe, expect, it } from "vitest";

import {
  BUILT_IN_COLORS,
  CLOSED_SHAPE_TOOLS,
  OUTLINE_ONLY_TOOLS,
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../src/domain/settings";

describe("settings defaults", () => {
  it("creates every documented vault default", () => {
    const settings = createBuiltInSettings();

    expect(settings).toMatchObject({
      version: 3,
      startupTool: "draw",
      refreshRatePreference: "auto",
    });
    expect(settings.pageDefaults).toEqual({
      activeBufferLines: 3,
      backgroundSpacing: { dots: 25, lines: 25, squares: 25 },
      backgroundType: "squares",
      lockedBufferLines: 1,
    });
    expect(settings.filePlacement).toEqual({ mode: "obsidian-attachment-folder" });
    expect(settings.toolDefaults.pen).toEqual({
      color: { type: "theme-text" },
      width: 8,
      opacity: 1,
      pressureEnabled: true,
    });
    expect(settings.toolDefaults.highlighter).toEqual({
      color: { type: "rgba", value: "#EAB308FF" },
      width: 8,
      opacity: 0.4,
    });
    expect(settings.toolDefaults.straightHighlighter).toEqual(settings.toolDefaults.highlighter);
    expect(settings.toolDefaults.eraser.radius).toBe(24);
    expect(settings.toolDefaults.arrow).toEqual({ startNode: "none", endNode: "arrow" });
    expect(settings.toolDefaults.coordinateSystem.dimension).toBe("2d");
    expect(settings.toolDefaults.table.columns).toBe(3);
  });

  it("creates an independent default entry for every shape", () => {
    const shapes = createBuiltInSettings().toolDefaults.shapes;

    for (const tool of CLOSED_SHAPE_TOOLS) {
      expect(shapes[tool]).toMatchObject({ fillColor: null, fillOpacity: 0.15 });
    }
    for (const tool of OUTLINE_ONLY_TOOLS) {
      expect(shapes[tool]).not.toHaveProperty("fillColor");
      expect(shapes[tool]).not.toHaveProperty("fillOpacity");
    }
    expect(shapes.rectangle).not.toBe(shapes.ellipse);
  });

  it("returns fresh mutable settings trees", () => {
    const first = createBuiltInSettings();
    first.toolDefaults.pen.opacity = 0;

    expect(createBuiltInSettings().toolDefaults.pen.opacity).toBe(1);
  });

  it("exposes the exact built-in palette and device defaults", () => {
    expect(BUILT_IN_COLORS).toEqual([
      { type: "theme-text" },
      { type: "rgba", value: "#EF4444FF" },
      { type: "rgba", value: "#F97316FF" },
      { type: "rgba", value: "#EAB308FF" },
      { type: "rgba", value: "#22C55EFF" },
      { type: "rgba", value: "#06B6D4FF" },
      { type: "rgba", value: "#3B82F6FF" },
      { type: "rgba", value: "#8B5CF6FF" },
      { type: "rgba", value: "#EC4899FF" },
      { type: "rgba", value: "#6B7280FF" },
    ]);
    expect(createBuiltInDeviceSettings()).toEqual({
      version: 1,
      fingerDrawingEnabled: false,
      penTapInsertion: "off",
      leftHandedToolbar: false,
      motion: "system",
    });
  });
});
