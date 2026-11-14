import { expect, it } from "vitest";
import { createBuiltInSettings, loadSettings } from "../../../../src/domain/settings";
import type { FontLibraryEntryV2 } from "../../../../src/domain/settings/types";

const id = "a".repeat(64);
const entry: FontLibraryEntryV2 = {
  id,
  path: `Inkbook Fonts/${id}.woff2`,
  family: `custom-${id}`,
  displayName: "My Font",
  weight: 400,
  style: "normal",
  weightRange: [100, 900],
  license: "OFL-1.1",
};

it("loads a bounded vault-local font index and completes older settings without diagnostics", () => {
  const settings = createBuiltInSettings();
  settings.fontLibrary = [entry];
  expect(loadSettings(settings)).toEqual({ value: settings, diagnostics: [] });
  const old = { ...settings } as Record<string, unknown>;
  delete old.fontLibrary;
  expect(loadSettings(old)).toEqual({ value: { ...settings, fontLibrary: [] }, diagnostics: [] });
});

it("rejects unsafe font metadata, duplicate faces and excess library capacity", () => {
  const settings = createBuiltInSettings();
  const result = loadSettings({
    ...settings,
    fontLibrary: [
      entry,
      { ...entry },
      { ...entry, path: "../secret.ttf" },
      { ...entry, data: "base64" },
      { ...entry, weightRange: [500, 600] },
    ],
  });
  expect(result.value.fontLibrary).toEqual([entry]);
  expect(result.diagnostics.map(({ path }) => path)).toEqual([
    "fontLibrary.1",
    "fontLibrary.2",
    "fontLibrary.3",
    "fontLibrary.4",
  ]);
  const excess = loadSettings({
    ...settings,
    fontLibrary: Array.from({ length: 129 }, () => entry),
  });
  expect(excess.value.fontLibrary).toEqual([]);
  expect(excess.diagnostics).toEqual([{ code: "settings.invalid-field", path: "fontLibrary" }]);
});

it("preserves explicitly shared family IDs but rejects overlapping faces without replacement", () => {
  const settings = createBuiltInSettings();
  const boldId = "b".repeat(64);
  const regular = { ...entry, weightRange: [400, 400] as const };
  const bold = {
    ...regular,
    id: boldId,
    path: `Inkbook Fonts/${boldId}.woff2`,
    weight: 700,
    weightRange: [700, 700] as const,
  };
  const result = loadSettings({ ...settings, fontLibrary: [regular, bold] });
  expect(result.diagnostics).toEqual([]);
  expect(result.value.fontLibrary.map((face) => face.family)).toEqual([entry.family, entry.family]);
  const collision = loadSettings({
    ...settings,
    fontLibrary: [regular, { ...bold, weight: 400, weightRange: [400, 400] }],
  });
  expect(collision.value.fontLibrary).toEqual([regular]);
  expect(collision.diagnostics).toEqual([
    { code: "settings.invalid-field", path: "fontLibrary.1" },
  ]);
});
