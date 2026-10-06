import { describe, expect, it } from "vitest";

import { createBuiltInDeviceSettings, loadDeviceSettings } from "../../../../src/domain/settings";
import { isScrollPreloadMarginPx } from "../../../../src/domain/settings/validation";

describe("scroll preload margin device settings", () => {
  it.each([100, 101, 300, 799, 800])("loads valid integer margin %s", (scrollPreloadMarginPx) => {
    const input = { ...createBuiltInDeviceSettings(), scrollPreloadMarginPx };

    expect(isScrollPreloadMarginPx(scrollPreloadMarginPx)).toBe(true);
    expect(loadDeviceSettings(input)).toEqual({ value: input, diagnostics: [] });
  });

  it("adds the default to an older V2 record while preserving other preferences", () => {
    const current = createBuiltInDeviceSettings();
    current.leftHandedToolbar = true;
    current.keyboardShortcuts = { ...current.keyboardShortcuts, copy: null };
    const input = structuredClone(current) as unknown as Record<string, unknown>;
    delete input.scrollPreloadMarginPx;

    expect(loadDeviceSettings(input)).toEqual({ value: current, diagnostics: [] });
  });

  it.each([99, 801, 300.5, Number.NaN, Infinity, -Infinity, "300", true, null, undefined])(
    "defaults invalid margin %s without clamping or resetting other settings",
    (scrollPreloadMarginPx) => {
      const input = {
        ...createBuiltInDeviceSettings(),
        fingerDrawingEnabled: true,
        scrollPreloadMarginPx,
      };

      expect(isScrollPreloadMarginPx(scrollPreloadMarginPx)).toBe(false);
      expect(loadDeviceSettings(input)).toEqual({
        value: { ...createBuiltInDeviceSettings(), fingerDrawingEnabled: true },
        diagnostics: [{ code: "settings.invalid-field", path: "scrollPreloadMarginPx" }],
      });
    },
  );
});
