import { describe, expect, it } from "vitest";

import { createBuiltInSettings, loadSettings } from "../../../../src/domain/settings";

describe("tool behavior preferences", () => {
  it.each([3, 4])("completes legacy V%i preferences without resetting custom paint", (version) => {
    const expected = createBuiltInSettings();
    expected.toolDefaults.pen.opacity = 0.35;
    expected.toolDefaults.pen.pressureEnabled = false;
    expected.toolDefaults.arrow.startNode = "circle";
    expected.snapping.enabled = false;
    const input = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    delete input.copyTextFieldsAsText;
    const tools = input.toolDefaults as Record<string, Record<string, unknown>>;
    delete tools.pen?.holdToShapeEnabled;
    delete tools.line;
    delete tools.arrow?.snappingEnabled;
    input.version = version;
    if (version === 3) {
      delete tools.select;
      delete input.snapping;
      delete input.selectionHighlightsEnabled;
      delete input.holdToShape;
      expected.snapping.enabled = true;
    }
    const result = loadSettings(input);
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual(expected);
  });

  it("retains explicit disabled preferences through loading", () => {
    const input = createBuiltInSettings();
    input.toolDefaults.pen.holdToShapeEnabled = false;
    input.toolDefaults.line.snappingEnabled = false;
    input.toolDefaults.arrow.snappingEnabled = false;
    const result = loadSettings(input);
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual(input);
  });

  it("loads explicit text-copy choices and rejects invalid persisted values", () => {
    const defaults = createBuiltInSettings();
    for (const enabled of [true, false]) {
      const input = { ...defaults, copyTextFieldsAsText: enabled };
      expect(loadSettings(input)).toEqual({ value: input, diagnostics: [] });
    }
    const loaded = loadSettings({ ...defaults, copyTextFieldsAsText: "true" });
    expect(loaded.value).toEqual(defaults);
    expect(loaded.diagnostics).toEqual([
      { code: "settings.invalid-field", path: "copyTextFieldsAsText" },
    ]);
  });

  it("diagnoses explicitly invalid preferences instead of treating them as legacy", () => {
    const input = createBuiltInSettings();
    const result = loadSettings({
      ...input,
      toolDefaults: {
        ...input.toolDefaults,
        pen: { ...input.toolDefaults.pen, holdToShapeEnabled: undefined },
        line: { snappingEnabled: "false" },
        arrow: { ...input.toolDefaults.arrow, snappingEnabled: 0 },
      },
    });
    expect(result.diagnostics).toEqual([
      { code: "settings.invalid-field", path: "toolDefaults.pen.holdToShapeEnabled" },
      { code: "settings.invalid-field", path: "toolDefaults.line" },
      { code: "settings.invalid-field", path: "toolDefaults.arrow" },
    ]);
    expect(result.value).toEqual(input);
  });
});
