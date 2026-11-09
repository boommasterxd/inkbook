import { expect, it } from "vitest";

import { createBuiltInDeviceSettings, loadDeviceSettings } from "../../../../src/domain/settings";

it("accepts existing device settings without language and validates explicit preferences", () => {
  const previous: Record<string, unknown> = { ...createBuiltInDeviceSettings() };
  delete previous.language;
  expect(loadDeviceSettings(previous)).toMatchObject({
    value: { language: "auto" },
    diagnostics: [],
  });
  expect(loadDeviceSettings({ ...previous, language: "de" })).toMatchObject({
    value: { language: "de" },
    diagnostics: [],
  });
  expect(loadDeviceSettings({ ...previous, language: "invalid" })).toMatchObject({
    value: { language: "auto" },
    diagnostics: [{ path: "language" }],
  });
});
