import { createBuiltInDeviceSettings, createBuiltInSettings } from "../../../src/domain/settings";
import { Keymap, type App, type Plugin } from "obsidian";
import { InkbookSettingTab } from "../../../src/obsidian/settings/setting-tab";
import { InkbookSettingsModalController } from "../../../src/obsidian/settings/settings-modal";
import { workSchedulerFromFrames } from "./work-scheduler";
import {
  InkbookSettingsStore,
  type DeviceSettingsPort,
  type VaultSettingsPort,
} from "../../../src/obsidian/settings/storage";

class VaultSettingsFake implements VaultSettingsPort {
  public loadData(): Promise<unknown> {
    return Promise.resolve(createBuiltInSettings());
  }

  public saveData(): Promise<void> {
    return Promise.resolve();
  }
}

class DeviceSettingsFake implements DeviceSettingsPort {
  public value = createBuiltInDeviceSettings();

  public loadLocalStorage(): unknown {
    return this.value;
  }

  public saveLocalStorage(
    _key: string,
    data: ReturnType<typeof createBuiltInDeviceSettings>,
  ): void {
    this.value = structuredClone(data);
  }
}

export function createTestSettingsStore(): InkbookSettingsStore {
  return new InkbookSettingsStore(new VaultSettingsFake(), new DeviceSettingsFake());
}

export function openTestSettingsModal(
  store = createTestSettingsStore(),
  motion: "full" | "reduced" = "full",
) {
  const app = {
    keymap: new Keymap(),
    workspace: { containerEl: document.body.createDiv() },
  } as unknown as App;
  store.updateDeviceSettings((settings) => ({ ...settings, motion }));
  const tab = new InkbookSettingTab(app, {} as Plugin, store, undefined, undefined, {
    workScheduler: () => workSchedulerFromFrames(window),
  });
  const controller = new InkbookSettingsModalController(app, tab, store);
  controller.open("settings");
  return { controller, store, tab };
}
