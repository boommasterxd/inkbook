// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FontSettingsPreview } from "../../../../src/obsidian/settings/fonts/font-settings-preview";
import type {
  LibraryFontFace,
  VaultFontLibrary,
} from "../../../../src/obsidian/fonts/vault-font-library";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  installFontPreviewHost,
  previewFontResource,
} from "../../../fixtures/obsidian/native-font-preview";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retains one loaded preview font and releases it when replaced or disposed", async () => {
  const host = installFontPreviewHost(document);
  const { retained } = host;
  const resource = await previewFontResource();
  const face: LibraryFontFace = {
    id: resource.id,
    family: resource.family,
    displayName: "My font",
    path: `Inkbook Fonts/${resource.id}.woff2`,
    weight: 400,
    style: "normal",
  };
  const read = vi.fn(async () => resource);
  const library = { resource: read } as unknown as VaultFontLibrary;
  const sample = document.body.createEl("p");
  const preview = new FontSettingsPreview(
    sample,
    { library, scheduler: new TestWorkScheduler() },
    (update) => update(),
  );
  await preview.show(face);
  expect(retained.size).toBe(1);
  expect(sample.hidden).toBe(false);
  preview.cancelPending();
  expect(retained.size).toBe(1);
  expect(sample.hidden).toBe(false);
  await preview.show(face);
  expect(retained.size).toBe(1);
  let release!: (value: typeof resource) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = preview.show(face);
  const second = preview.show(face);
  const latest = preview.show(face);
  expect(read).toHaveBeenCalledTimes(3);
  release(resource);
  await Promise.all([first, second, latest]);
  expect(read).toHaveBeenCalledTimes(4);
  expect(retained.size).toBe(1);
  preview.dispose();
  expect(retained.size).toBe(0);
  expect(sample.hidden).toBe(true);
  host.restore();
});
