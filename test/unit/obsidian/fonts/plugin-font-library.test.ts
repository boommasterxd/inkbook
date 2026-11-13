import type { Plugin } from "obsidian";
import { expect, it, vi } from "vitest";
import { createPluginFontLibrary } from "../../../../src/obsidian/fonts/plugin-font-library";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

it("matches the latest family metadata without rereading vault binaries or settings snapshots", async () => {
  const store = createTestSettingsStore();
  const id = "a".repeat(64);
  const family = `custom-${id}`;
  const regular = {
    id,
    family,
    path: `Inkbook Fonts/${id}.woff2`,
    displayName: "Inter",
    weight: 400,
    style: "normal" as const,
  };
  await store.updateVaultSettings((current) => ({ ...current, fontLibrary: [regular] }));
  const readSettings = vi.spyOn(store, "getVaultSettings");
  const readFile = vi.fn();
  const disposals: (() => void)[] = [];
  const plugin = {
    app: { vault: { getFileByPath: readFile } },
    register: (dispose: () => void) => {
      disposals.push(dispose);
    },
  } as unknown as Plugin;
  const service = createPluginFontLibrary(plugin, store, () => new TestWorkScheduler());
  expect(service.match({ family, weight: 400, style: "normal" })?.id).toBe(id);
  expect(service.match({ family, weight: 700, style: "italic" })?.id).toBe(id);
  const boldId = "b".repeat(64);
  await store.updateVaultSettings((current) => ({
    ...current,
    fontLibrary: [
      ...current.fontLibrary,
      { ...regular, id: boldId, path: `Inkbook Fonts/${boldId}.woff2`, weight: 700 },
    ],
  }));
  expect(service.match({ family, weight: 700, style: "normal" })?.id).toBe(boldId);
  expect(service.choices()).toHaveLength(1);
  expect(readFile).not.toHaveBeenCalled();
  expect(readSettings).toHaveBeenCalledOnce();
  for (const dispose of disposals) dispose();
  expect(() => service.match({ family, weight: 400, style: "normal" })).toThrow("disposed");
});
