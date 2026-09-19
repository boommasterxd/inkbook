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
      version: 4,
      startupTool: "draw",
      selectionHighlightsEnabled: true,
      refreshRatePreference: "auto",
    });
    expect(settings.pageDefaults).toEqual({
      activeBufferLines: 3,
      backgroundSpacing: { dots: 100 / 3, lines: 50, squares: 100 / 3 },
      backgroundType: "squares",
      lockedBufferLines: 1,
    });
    expect(settings.filePlacement).toEqual({ mode: "obsidian-attachment-folder" });
    expect(settings.snapping).toEqual({
      enabled: true,
      angles: true,
      bends: true,
      connections: true,
      structures: true,
    });
    expect(settings.toolDefaults.select).toEqual({ area: "lasso", inclusion: "touched" });
    expect(settings.toolDefaults.pen).toEqual({
      color: { type: "theme-text" },
      width: 4,
      opacity: 1,
      pressureEnabled: true,
    });
    expect(settings.toolDefaults.highlighter).toEqual({
      color: { type: "rgba", value: "#EAB308FF" },
      width: 8,
      opacity: 0.4,
    });
    expect(settings.toolDefaults.straightHighlighter).toEqual(settings.toolDefaults.highlighter);
    expect(settings.toolDefaults.eraser.radius).toBe(20);
    expect(settings.toolDefaults.arrow).toEqual({ startNode: "none", endNode: "arrow" });
    expect(settings.toolDefaults.coordinateSystem.dimension).toBe("2d");
    expect(settings.toolDefaults.table.columns).toBe(2);
  });

  it("creates an independent default entry for every shape", () => {
    const shapes = createBuiltInSettings().toolDefaults.shapes;

    for (const tool of CLOSED_SHAPE_TOOLS) {
      expect(shapes[tool]).toMatchObject({
        fillColor: null,
        fillOpacity: 0.5,
        outlineColor: { type: "theme-text" },
        outlineOpacity: 1,
        outlineStyle: "solid",
        outlineWidth: 4,
      });
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
});

describe("settings palette and device defaults", () => {
  it("exposes the exact built-in palette", () => {
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
  });

  it("exposes the exact device defaults", () => {
    expect(createBuiltInDeviceSettings()).toEqual({
      version: 2,
      fingerDrawingEnabled: false,
      penTapInsertion: "off",
      leftHandedToolbar: false,
      motion: "system",
      keyboardShortcuts: {
        "select-all": { key: "a", modifiers: ["mod"] },
        copy: { key: "c", modifiers: ["mod"] },
        cut: { key: "x", modifiers: ["mod"] },
        "delete-selection": { key: "Delete", modifiers: [] },
        "zoom-in": { key: "+", modifiers: ["mod"] },
        "zoom-out": { key: "-", modifiers: ["mod"] },
        "bring-forward": { key: "ArrowUp", modifiers: ["mod"] },
        "send-backward": { key: "ArrowDown", modifiers: ["mod"] },
        "bring-to-front": { key: "ArrowUp", modifiers: ["mod", "shift"] },
        "send-to-back": { key: "ArrowDown", modifiers: ["mod", "shift"] },
      },
    });
  });
});
