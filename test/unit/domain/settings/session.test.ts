import { describe, expect, it } from "vitest";

import {
  DEVICE_SETTINGS_STORAGE_KEY,
  SETTINGS_SCOPE,
  createBuiltInSettings,
  createPageSettings,
  initializeEditorSettingsSession,
  resolveSettingPrecedence,
} from "../../../../src/domain/settings";

describe("settings scope and session behavior", () => {
  it("initializes independent per-tool session values from vault defaults", () => {
    const settings = createBuiltInSettings();
    settings.startupTool = "eraser";
    settings.toolDefaults.pen.opacity = 0.5;

    const session = initializeEditorSettingsSession(settings);
    settings.toolDefaults.pen.opacity = 0.25;

    expect(session).toMatchObject({ currentTool: "eraser", fingerDrawingEnabled: false });
    expect(session.toolValues.pen.opacity).toBe(0.5);
  });

  it("resolves explicit, session, vault, and built-in values in order", () => {
    const missing = { present: false } as const;

    expect(
      resolveSettingPrecedence(
        { present: true, value: null },
        { present: true, value: "session" },
        { present: true, value: "vault" },
        "built-in",
      ),
    ).toBeNull();
    expect(
      resolveSettingPrecedence(missing, { present: true, value: "session" }, missing, "built-in"),
    ).toBe("session");
    expect(resolveSettingPrecedence(missing, missing, { present: true, value: 3 }, 4)).toBe(3);
    expect(resolveSettingPrecedence(missing, missing, missing, 4)).toBe(4);
  });

  it("copies only the selected background spacing into a new page", () => {
    const settings = createBuiltInSettings();
    settings.pageDefaults.backgroundType = "lines";
    settings.pageDefaults.backgroundSpacing.lines = 150;
    settings.pageDefaults.backgroundSpacing.dots = 80;

    expect(createPageSettings(settings)).toEqual({
      background: { type: "lines", spacing: 150 },
      writingLineHeight: 100,
      activeBufferLines: 3,
      lockedBufferLines: 1,
    });
  });

  it("declares persistence scopes and the versioned device key", () => {
    expect(DEVICE_SETTINGS_STORAGE_KEY).toBe("inkbook:device-settings:v1");
    expect(SETTINGS_SCOPE.toolDefaults).toBe("vault");
    expect(SETTINGS_SCOPE.motion).toBe("device-vault");
    expect(SETTINGS_SCOPE.background).toBe("file");
    expect(SETTINGS_SCOPE.zoom).toBe("session");
  });
});
