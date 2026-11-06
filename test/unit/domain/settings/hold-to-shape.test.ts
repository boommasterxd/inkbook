import { describe, expect, it } from "vitest";

import { createBuiltInSettings, loadSettings } from "../../../../src/domain/settings";

describe("hold-to-shape vault settings", () => {
  it("completes old V4 settings without losing existing choices", () => {
    const current = createBuiltInSettings();
    current.startupTool = "arrow";
    current.snapping.enabled = false;
    const { holdToShape: _holdToShape, ...legacy } = current;
    const result = loadSettings(legacy);
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual(current);
    expect(result.value.holdToShape).toEqual({
      enabled: true,
      holdDurationMs: 600,
      jitterTolerancePx: 12,
    });
  });

  it.each([
    [200, 1],
    [2000, 32],
    [601, 5],
  ])(
    "retains disabled values at delay %i and tolerance %i",
    (holdDurationMs, jitterTolerancePx) => {
      const input = createBuiltInSettings();
      input.holdToShape = { enabled: false, holdDurationMs, jitterTolerancePx };
      const result = loadSettings(input);
      expect(result.diagnostics).toEqual([]);
      expect(result.value.holdToShape).toEqual(input.holdToShape);
      expect(result.value.holdToShape).not.toBe(input.holdToShape);
    },
  );

  it.each([
    ["enabled", "yes"],
    ["holdDurationMs", 199],
    ["holdDurationMs", 2001],
    ["holdDurationMs", 600.5],
    ["jitterTolerancePx", 0],
    ["jitterTolerancePx", 33],
    ["jitterTolerancePx", Number.NaN],
  ])("falls back only invalid field %s=%s", (key, value) => {
    const input = createBuiltInSettings();
    input.holdToShape.enabled = false;
    const invalid = { ...input, holdToShape: { ...input.holdToShape, [key]: value } };
    const result = loadSettings(invalid);
    expect(result.diagnostics).toEqual([
      { code: "settings.invalid-field", path: `holdToShape.${key}` },
    ]);
    expect(result.value.holdToShape).toEqual({
      ...input.holdToShape,
      [key]: createBuiltInSettings().holdToShape[key as keyof typeof input.holdToShape],
    });
  });

  it("rejects unknown nested settings without changing unrelated values", () => {
    const input = createBuiltInSettings();
    input.startupTool = "line";
    const result = loadSettings({ ...input, holdToShape: { ...input.holdToShape, extra: true } });
    expect(result.diagnostics).toEqual([{ code: "settings.invalid-field", path: "holdToShape" }]);
    expect(result.value).toEqual(input);
  });
});
