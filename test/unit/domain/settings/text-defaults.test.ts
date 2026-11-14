import { expect, it } from "vitest";
import { createBuiltInSettings, loadSettings } from "../../../../src/domain/settings";

it("completes legacy text defaults without discarding custom settings", () => {
  const input = createBuiltInSettings();
  input.toolDefaults.pen.opacity = 0.375;
  const legacy = structuredClone(input) as unknown as { toolDefaults: Record<string, unknown> };
  delete legacy.toolDefaults.text;
  const result = loadSettings(legacy);
  expect(result.diagnostics).toEqual([]);
  expect(result.value).toEqual(input);
});

it("preserves every text default and falls back only for invalid text fields", () => {
  const input = createBuiltInSettings();
  Object.assign(input.toolDefaults.text, {
    fontFamily: "custom-font",
    fontSize: 23.125,
    bold: true,
    italic: true,
    underline: true,
    strikethrough: true,
    alignment: "justify",
    backgroundOpacity: 0.25,
  });
  expect(loadSettings(input)).toEqual({ value: input, diagnostics: [] });
  const invalid = structuredClone(input);
  invalid.toolDefaults.text.fontSize = -1;
  expect(loadSettings(invalid)).toEqual({
    value: {
      ...input,
      toolDefaults: { ...input.toolDefaults, text: { ...input.toolDefaults.text, fontSize: 24 } },
    },
    diagnostics: [{ code: "settings.invalid-field", path: "toolDefaults.text.fontSize" }],
  });
});
