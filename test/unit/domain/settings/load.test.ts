import { describe, expect, it } from "vitest";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
  loadDeviceSettings,
  loadSettings,
  migrateVaultSettingsToV3,
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
    expect(result.value.toolDefaults.table.columns).toBe(3);
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

    expect(result.value.toolDefaults.pen.width).toBe(8);
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

    const result = loadSettings({ version: 4 });
    expect(result.value).toEqual(createBuiltInSettings());
    expect(result.diagnostics).toEqual([{ code: "settings.unsupported-version", path: "version" }]);
  });
});

describe("vault settings version three migration", () => {
  it("does not mutate versioned input", () => {
    const input = createBuiltInSettings();
    const migrated = migrateVaultSettingsToV3(input);

    expect(migrated).toEqual({ value: input, diagnostics: [] });
    expect(migrated.value).toBe(input);
  });

  it("migrates version-two spacing labels to the shared absolute size series", () => {
    const current = createBuiltInSettings();
    const input = {
      ...current,
      version: 2,
      pageDefaults: {
        ...current.pageDefaults,
        backgroundSpacing: { lines: 150, dots: 20, squares: 80 },
      },
    };

    const result = loadSettings(input);

    expect(result.diagnostics).toEqual([]);
    expect(result.value.pageDefaults.backgroundSpacing).toEqual({
      lines: 50,
      dots: 25,
      squares: 100,
    });
    expect(input.pageDefaults.backgroundSpacing).toEqual({ lines: 150, dots: 20, squares: 80 });
  });

  it("migrates version-one vault settings and adds automatic refresh-rate detection", () => {
    const current = createBuiltInSettings();
    const input = {
      ...current,
      version: 1,
      pageDefaults: {
        ...current.pageDefaults,
        backgroundSpacing: { lines: 50, dots: 20, squares: 20 },
      },
    } as Record<string, unknown>;
    delete input.refreshRatePreference;

    const result = loadSettings(input);

    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual(current);
    expect(input).not.toHaveProperty("refreshRatePreference");
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

    expect(loadDeviceSettings(input)).toEqual({ value: input, diagnostics: [] });
  });

  it("falls back field by field", () => {
    const input = createBuiltInDeviceSettings() as unknown as Record<string, unknown>;
    input.fingerDrawingEnabled = "yes";
    input.penTapInsertion = "draw";
    input.leftHandedToolbar = true;
    input.motion = "none";

    const result = loadDeviceSettings(input);

    expect(result.value).toEqual({
      version: 1,
      fingerDrawingEnabled: false,
      penTapInsertion: "off",
      leftHandedToolbar: true,
      motion: "system",
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
});
