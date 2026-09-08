import { createBuiltInDeviceSettings, createBuiltInSettings } from "../../../src/domain/settings";
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
