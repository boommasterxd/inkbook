import type { App, Plugin } from "obsidian";
import { expect } from "vitest";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import type { ComparisonScenario } from "./contracts";

export const OBSIDIAN_SETTINGS_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "obsidian-settings-unrelated-device-change",
    modules: [
      "obsidian/settings/setting-tab",
      "obsidian/settings/settings-modal-content",
      "obsidian/settings/storage",
      "domain/settings",
    ],
    covers: [
      {
        file: "test/performance/obsidian/settings-render-performance.test.ts",
        test: "keeps unopened settings bounded and unrelated device changes within the strictest frame budget",
        ordinals: [1],
      },
    ],
    statistics: [
      { kind: "p99", population: "operations", minimumSamples: 100, minimumOperations: 2 },
    ],
    execution: "sync",

    warmupOperations: 20,
    create(implementation) {
      installObsidianDomHelpers();
      const { InkbookSettingTab } = implementation.get<
        typeof import("../../../src/obsidian/settings/setting-tab")
      >("obsidian/settings/setting-tab");
      const { SettingsModalContent } = implementation.get<
        typeof import("../../../src/obsidian/settings/settings-modal-content")
      >("obsidian/settings/settings-modal-content");
      const { InkbookSettingsStore } = implementation.get<
        typeof import("../../../src/obsidian/settings/storage")
      >("obsidian/settings/storage");
      const { createBuiltInSettings, createBuiltInDeviceSettings } =
        implementation.get<typeof import("../../../src/domain/settings")>("domain/settings");
      const container = document.body.createDiv();
      const app = { workspace: { containerEl: container } } as unknown as App;
      const store = new InkbookSettingsStore(
        { loadData: async () => createBuiltInSettings(), saveData: async () => undefined },
        {
          loadLocalStorage: () => createBuiltInDeviceSettings(),
          saveLocalStorage: () => undefined,
        },
      );
      const content = new SettingsModalContent(container, {
        app,
        settingTab: new InkbookSettingTab(app, {} as Plugin, store),
        store,
        view: "settings",
      });
      const initialNodes = [...container.querySelectorAll("*")];
      let reduced = false;
      return {
        run() {
          reduced = !reduced;
          store.updateDeviceSettings((settings) => ({
            ...settings,
            motion: reduced ? "reduced" : "full",
          }));
        },
        verify() {
          expect(
            container.querySelectorAll(".inkbook-settings-tool-controls [data-control]"),
          ).toHaveLength(0);
          expect(initialNodes.length).toBeLessThan(800);
          expect([...container.querySelectorAll("*")]).toEqual(initialNodes);
        },
        dispose() {
          content.dispose();
          container.remove();
        },
      };
    },
  },
];
