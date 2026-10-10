import { describe, expect, it } from "vitest";

import {
  createBuiltInDeviceSettings,
  createBuiltInKeyboardShortcuts,
  createBuiltInSettings,
  loadDeviceSettings,
  loadSettings,
} from "../../../../src/domain/settings";

describe("vault settings loading", () => {
  it("loads and clones valid boundary values", () => {
    const input = createBuiltInSettings();
    input.toolDefaults.pen.opacity = 0;
    input.toolDefaults.highlighter.opacity = 1;
    input.toolDefaults.eraser.radius = 64;
    input.toolDefaults.table.columns = 12;
    input.pageDefaults.activeBufferLines = 8;
    input.pageDefaults.lockedBufferLines = 0;
    input.filePlacement = { mode: "custom-vault-folder", folder: " Notes//Inkbook " };

    const result = loadSettings(input);

    expect(result.diagnostics).toEqual([]);
    expect(result.value).not.toBe(input);
    expect(result.value.toolDefaults.pen).not.toBe(input.toolDefaults.pen);
    expect(result.value.toolDefaults.eraser.radius).toBe(64);
    expect(result.value.pageDefaults).toMatchObject({
      activeBufferLines: 8,
      lockedBufferLines: 0,
    });
    expect(result.value.filePlacement).toEqual({
      mode: "custom-vault-folder",
      folder: "Notes/Inkbook",
    });
  });

  it("accepts integer numeric values between UI steps", () => {
    const input = createBuiltInSettings();
    input.toolDefaults.eraser.radius = 9;

    const result = loadSettings(input);

    expect(result.diagnostics).toEqual([]);
    expect(result.value.toolDefaults.eraser.radius).toBe(9);
  });
});

describe("vault settings V3 migration", () => {
  it("migrates valid V3 settings without changing existing values", () => {
    const current = createBuiltInSettings();
    current.startupTool = "arrow";
    current.toolDefaults.pen.opacity = 0.35;
    const { select: _select, ...legacyToolDefaults } = current.toolDefaults;
    const {
      snapping: _snapping,
      selectionHighlightsEnabled: _highlights,
      ...legacyCurrent
    } = current;
    const legacy = { ...legacyCurrent, version: 3, toolDefaults: legacyToolDefaults };

    const result = loadSettings(legacy);

    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual({
      ...current,
      version: 4,
      toolDefaults: {
        ...legacyToolDefaults,
        select: { area: "lasso", inclusion: "touched" },
      },
    });
  });

  it("rejects malformed V3 settings without partially migrating valid fields", () => {
    const current = createBuiltInSettings();
    current.startupTool = "arrow";
    const { select: _select, ...legacyToolDefaults } = current.toolDefaults;
    const {
      snapping: _snapping,
      selectionHighlightsEnabled: _highlights,
      ...legacyCurrent
    } = current;
    const legacy = {
      ...legacyCurrent,
      version: 3,
      toolDefaults: {
        ...legacyToolDefaults,
        pen: { ...legacyToolDefaults.pen, opacity: Number.NaN },
      },
    };

    const result = loadSettings(legacy);

    expect(result.value).toEqual(createBuiltInSettings());
    expect(result.diagnostics).toContainEqual({
      code: "settings.invalid-field",
      path: "toolDefaults.pen.opacity",
    });
  });

  it("rejects V3 tool defaults containing fields outside the legacy schema", () => {
    const current = structuredClone(createBuiltInSettings());
    const {
      snapping: _snapping,
      selectionHighlightsEnabled: _highlights,
      ...legacySettings
    } = current;
    const legacy = legacySettings as unknown as Record<string, unknown>;
    legacy.version = 3;

    const result = loadSettings(legacy);

    expect(result.value).toEqual(createBuiltInSettings());
    expect(result.diagnostics).toEqual([{ code: "settings.invalid-field", path: "toolDefaults" }]);
  });
});

describe("vault settings field loading", () => {
  it("replaces only invalid nested fields and records their paths", () => {
    const input = createBuiltInSettings() as unknown as Record<string, unknown>;
    const toolDefaults = input.toolDefaults as Record<string, unknown>;
    const pen = toolDefaults.pen as Record<string, unknown>;
    const table = toolDefaults.table as Record<string, unknown>;
    const pageDefaults = input.pageDefaults as Record<string, unknown>;
    pen.opacity = Number.NaN;
    table.columns = 13;
    pageDefaults.activeBufferLines = 7;
    pageDefaults.lockedBufferLines = 9;

    const result = loadSettings(input);

    expect(result.value.toolDefaults.pen.opacity).toBe(1);
    expect(result.value.toolDefaults.table.columns).toBe(2);
    expect(result.value.pageDefaults.activeBufferLines).toBe(7);
    expect(result.value.pageDefaults.lockedBufferLines).toBe(1);
    expect(result.diagnostics).toEqual([
      { code: "settings.invalid-field", path: "toolDefaults.pen.opacity" },
      { code: "settings.invalid-field", path: "toolDefaults.table" },
      { code: "settings.invalid-field", path: "pageDefaults.lockedBufferLines" },
    ]);
  });

  it.each([
    ["unlisted color", { type: "rgba", value: "#FFFFFFFF" }],
    ["malformed color", { type: "rgba", value: "#EF4444" }],
    ["color with an unknown property", { type: "theme-text", extra: true }],
  ])("rejects an %s", (_label, color) => {
    const input = createBuiltInSettings() as unknown as Record<string, unknown>;
    const toolDefaults = input.toolDefaults as Record<string, unknown>;
    const pen = toolDefaults.pen as Record<string, unknown>;
    pen.color = color;

    const result = loadSettings(input);

    expect(result.value.toolDefaults.pen.color).toEqual({ type: "theme-text" });
    expect(result.diagnostics).toContainEqual({
      code: "settings.invalid-field",
      path: "toolDefaults.pen.color",
    });
  });
});

describe("vault settings structural validation", () => {
  it("rejects a wide settings root without materializing all keys", () => {
    const input = createBuiltInSettings() as unknown as Record<string, unknown>;
    for (let index = 0; index < 10_000; index += 1) input[`extra-${index}`] = null;

    const result = loadSettings(input);

    expect(result.diagnostics).toEqual([{ code: "settings.invalid-root", path: "$" }]);
    expect(result.value).toEqual(createBuiltInSettings());
  });

  it("rejects an overlong custom path as one invalid placement field", () => {
    const input = createBuiltInSettings();
    input.filePlacement = { mode: "custom-vault-folder", folder: "x".repeat(4097) };

    const result = loadSettings(input);

    expect(result.value.filePlacement).toEqual({ mode: "obsidian-attachment-folder" });
    expect(result.diagnostics).toEqual([{ code: "settings.invalid-field", path: "filePlacement" }]);
  });

  it("rejects fill fields on outline-only shapes", () => {
    const input = createBuiltInSettings() as unknown as Record<string, unknown>;
    const toolDefaults = input.toolDefaults as Record<string, unknown>;
    const shapes = toolDefaults.shapes as Record<string, unknown>;
    shapes.line = {
      ...(shapes.line as Record<string, unknown>),
      fillColor: null,
      fillOpacity: 0.15,
    };

    const result = loadSettings(input);

    expect(result.value.toolDefaults.shapes.line).not.toHaveProperty("fillColor");
    expect(result.diagnostics).toContainEqual({
      code: "settings.invalid-field",
      path: "toolDefaults.shapes.line",
    });
  });

  it("rejects invalid discrete values without clamping", () => {
    const input = createBuiltInSettings() as unknown as Record<string, unknown>;
    const toolDefaults = input.toolDefaults as Record<string, unknown>;
    const pen = toolDefaults.pen as Record<string, unknown>;
    pen.width = 9;
    pen.opacity = 0.25;

    const result = loadSettings(input);

    expect(result.value.toolDefaults.pen.width).toBe(4);
    expect(result.value.toolDefaults.pen.opacity).toBe(0.25);
  });

  it("invalidates a containing object with unknown or missing properties", () => {
    const input = createBuiltInSettings() as unknown as Record<string, unknown>;
    const toolDefaults = input.toolDefaults as Record<string, unknown>;
    delete toolDefaults.arrow;
    toolDefaults.extra = true;

    const result = loadSettings(input);

    expect(result.value.toolDefaults).toEqual(createBuiltInSettings().toolDefaults);
    expect(result.diagnostics).toContainEqual({
      code: "settings.invalid-field",
      path: "toolDefaults",
    });
  });

  it("falls back completely for malformed roots and unsupported versions", () => {
    expect(loadSettings(null)).toEqual({
      value: createBuiltInSettings(),
      diagnostics: [{ code: "settings.invalid-root", path: "$" }],
    });

    const result = loadSettings({ version: 5 });
    expect(result.value).toEqual(createBuiltInSettings());
    expect(result.diagnostics).toEqual([{ code: "settings.unsupported-version", path: "version" }]);
  });
});

describe("vault settings current-version validation", () => {
  it("adds safe snapping defaults to legacy V4 settings without a version bump", () => {
    const current = createBuiltInSettings();
    const { snapping: _snapping, ...legacy } = current;

    const result = loadSettings(legacy);

    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual(current);
  });

  it("falls back only invalid snapping fields and rejects unknown snapping properties", () => {
    const input = createBuiltInSettings() as unknown as Record<string, unknown>;
    const snapping = input.snapping as Record<string, unknown>;
    snapping.enabled = false;
    snapping.angles = "sometimes";

    const fieldResult = loadSettings(input);

    expect(fieldResult.value.snapping).toEqual({
      ...createBuiltInSettings().snapping,
      enabled: false,
    });
    expect(fieldResult.diagnostics).toEqual([
      { code: "settings.invalid-field", path: "snapping.angles" },
    ]);

    const unknown = createBuiltInSettings() as unknown as Record<string, unknown>;
    (unknown.snapping as Record<string, unknown>).grid = true;
    const objectResult = loadSettings(unknown);
    expect(objectResult.value.snapping).toEqual(createBuiltInSettings().snapping);
    expect(objectResult.diagnostics).toEqual([
      { code: "settings.invalid-field", path: "snapping" },
    ]);
  });

  it.each([1, 2])("rejects unsupported pre-release version %j without migration", (version) => {
    const input = { ...createBuiltInSettings(), version };

    const result = loadSettings(input);

    expect(result.value).toEqual(createBuiltInSettings());
    expect(result.diagnostics).toEqual([{ code: "settings.unsupported-version", path: "version" }]);
  });

  it.each(["fast", 75, 360, null])("rejects invalid refresh-rate preference %j", (value) => {
    const input = { ...createBuiltInSettings(), refreshRatePreference: value };

    const result = loadSettings(input);

    expect(result.value.refreshRatePreference).toBe("auto");
    expect(result.diagnostics).toContainEqual({
      code: "settings.invalid-field",
      path: "refreshRatePreference",
    });
  });

  it.each([
    ["area", "ellipse"],
    ["inclusion", "crossing"],
  ])("rejects invalid Select %s values", (property, value) => {
    const input = createBuiltInSettings() as unknown as Record<string, unknown>;
    const toolDefaults = input.toolDefaults as Record<string, unknown>;
    const select = toolDefaults.select as Record<string, unknown>;
    select[property] = value;

    const result = loadSettings(input);

    expect(result.value.toolDefaults.select).toEqual({ area: "lasso", inclusion: "touched" });
    expect(result.diagnostics).toContainEqual({
      code: "settings.invalid-field",
      path: "toolDefaults.select",
    });
  });
});

describe("device settings loading", () => {
  it("loads valid values", () => {
    const input = {
      version: 1,
      fingerDrawingEnabled: true,
      penTapInsertion: "handwriting",
      leftHandedToolbar: true,
      motion: "reduced",
    };

    expect(loadDeviceSettings(input)).toEqual({
      value: {
        ...input,
        version: 2,
        scrollPreloadMarginPx: 300,
        keyboardShortcuts: createBuiltInKeyboardShortcuts(),
      },
      diagnostics: [],
    });
  });

  it("falls back field by field", () => {
    const input = createBuiltInDeviceSettings() as unknown as Record<string, unknown>;
    input.fingerDrawingEnabled = "yes";
    input.penTapInsertion = "draw";
    input.leftHandedToolbar = true;
    input.motion = "none";

    const result = loadDeviceSettings(input);

    expect(result.value).toEqual({
      version: 2,
      scrollPreloadMarginPx: 300,
      fingerDrawingEnabled: false,
      penTapInsertion: "off",
      leftHandedToolbar: true,
      motion: "system",
      keyboardShortcuts: createBuiltInKeyboardShortcuts(),
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "fingerDrawingEnabled",
      "penTapInsertion",
      "motion",
    ]);
  });

  it("rejects unknown root properties", () => {
    const input = { ...createBuiltInDeviceSettings(), vaultPath: "private" };

    expect(loadDeviceSettings(input)).toEqual({
      value: createBuiltInDeviceSettings(),
      diagnostics: [{ code: "settings.invalid-root", path: "$" }],
    });
  });

  it("loads canonical custom shortcuts and preserves cleared actions", () => {
    const input = createBuiltInDeviceSettings();
    input.keyboardShortcuts = {
      ...input.keyboardShortcuts,
      copy: { key: "K", modifiers: ["shift", "mod"] },
      cut: null,
    };

    const result = loadDeviceSettings(input);

    expect(result.diagnostics).toEqual([]);
    expect(result.value.keyboardShortcuts.copy).toEqual({
      key: "k",
      modifiers: ["mod", "shift"],
    });
    expect(result.value.keyboardShortcuts.cut).toBeNull();
  });

  it("rejects duplicate bindings without creating a second conflict", () => {
    const input = createBuiltInDeviceSettings();
    input.keyboardShortcuts = {
      ...input.keyboardShortcuts,
      copy: { key: "a", modifiers: ["mod"] },
    };

    const result = loadDeviceSettings(input);

    expect(result.diagnostics).toContainEqual({
      code: "settings.invalid-field",
      path: "keyboardShortcuts.copy",
    });
    expect(result.value.keyboardShortcuts.copy).toEqual({ key: "c", modifiers: ["mod"] });
  });
});

describe("selection highlight settings compatibility", () => {
  it.each([true, false])("preserves an explicit %s highlight preference", (enabled) => {
    const input = { ...createBuiltInSettings(), selectionHighlightsEnabled: enabled };
    expect(loadSettings(input)).toEqual({ value: input, diagnostics: [] });
  });

  it.each([true, false])(
    "adds highlights to legacy V4 settings with snapping present=%s",
    (hasSnapping) => {
      const current = createBuiltInSettings();
      current.startupTool = "arrow";
      current.toolDefaults.pen.opacity = 0.35;
      if (hasSnapping) current.snapping.angles = false;
      const legacy = structuredClone(current) as unknown as Record<string, unknown>;
      delete legacy.selectionHighlightsEnabled;
      if (!hasSnapping) delete legacy.snapping;

      expect(loadSettings(legacy)).toEqual({ value: current, diagnostics: [] });
    },
  );

  it.each(["false", 0, null, undefined])(
    "defaults invalid highlight value %j with a field diagnostic",
    (value) => {
      const input = {
        ...createBuiltInSettings(),
        startupTool: "arrow",
        selectionHighlightsEnabled: value,
      };
      const result = loadSettings(input);

      expect(result.value).toEqual({ ...createBuiltInSettings(), startupTool: "arrow" });
      expect(result.diagnostics).toEqual([
        { code: "settings.invalid-field", path: "selectionHighlightsEnabled" },
      ]);
    },
  );
});
