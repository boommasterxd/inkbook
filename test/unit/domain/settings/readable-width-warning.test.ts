import { expect, it } from "vitest";
import { createBuiltInDeviceSettings, loadDeviceSettings } from "../../../../src/domain/settings";

it("adds the width-warning preference to saved V2 settings without changing existing choices", () => {
  const current = { ...createBuiltInDeviceSettings(), motion: "reduced", leftHandedToolbar: true };
  const { readableLineWidthWarningDismissed: _dismissed, ...previous } = current;
  expect(loadDeviceSettings(previous)).toEqual({ value: current, diagnostics: [] });
});

it("retains a saved width-warning dismissal and rejects invalid present values", () => {
  const current = { ...createBuiltInDeviceSettings(), readableLineWidthWarningDismissed: true };
  expect(loadDeviceSettings(current)).toEqual({ value: current, diagnostics: [] });
  expect(loadDeviceSettings({ ...current, readableLineWidthWarningDismissed: "yes" })).toEqual({
    value: { ...current, readableLineWidthWarningDismissed: false },
    diagnostics: [{ code: "settings.invalid-field", path: "readableLineWidthWarningDismissed" }],
  });
});
