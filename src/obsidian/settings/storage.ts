import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
  DEVICE_SETTINGS_STORAGE_KEY,
  LEGACY_DEVICE_SETTINGS_STORAGE_KEY,
  loadDeviceSettings,
  loadSettings,
  type InkbookDeviceSettingsV2,
  type InkbookSettingsV4,
  type SettingsDiagnostic,
} from "../../domain/settings";

export interface VaultSettingsPort {
  loadData(): Promise<unknown>;
  saveData(data: InkbookSettingsV4): Promise<void>;
}

export interface DeviceSettingsPort {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: InkbookDeviceSettingsV2): void;
}

export interface LoadedSettingsDiagnostics {
  readonly vault: readonly SettingsDiagnostic[];
  readonly device: readonly SettingsDiagnostic[];
}

export type DeviceSettingsListener = (settings: Readonly<InkbookDeviceSettingsV2>) => void;
export type VaultSettingsListener = (settings: Readonly<InkbookSettingsV4>) => void;

function deviceSettingsEqual(
  left: InkbookDeviceSettingsV2,
  right: InkbookDeviceSettingsV2,
): boolean {
  return (
    left.scrollPreloadMarginPx === right.scrollPreloadMarginPx &&
    left.fingerDrawingEnabled === right.fingerDrawingEnabled &&
    left.penTapInsertion === right.penTapInsertion &&
    left.leftHandedToolbar === right.leftHandedToolbar &&
    left.motion === right.motion &&
    JSON.stringify(left.keyboardShortcuts) === JSON.stringify(right.keyboardShortcuts)
  );
}

export class InkbookSettingsStore {
  private vaultSettings = createBuiltInSettings();
  private deviceSettings = createBuiltInDeviceSettings();
  private readonly deviceSettingsListeners = new Set<DeviceSettingsListener>();
  private readonly vaultSettingsListeners = new Set<VaultSettingsListener>();
  private vaultWrites: Promise<void> = Promise.resolve();

  public constructor(
    private readonly vaultPort: VaultSettingsPort,
    private readonly devicePort: DeviceSettingsPort,
  ) {}

  public async load(): Promise<LoadedSettingsDiagnostics> {
    const vaultResult = loadSettings(await this.vaultPort.loadData());
    const storedDevice = this.devicePort.loadLocalStorage(DEVICE_SETTINGS_STORAGE_KEY);
    const legacyDevice =
      storedDevice === null || storedDevice === undefined
        ? this.devicePort.loadLocalStorage(LEGACY_DEVICE_SETTINGS_STORAGE_KEY)
        : undefined;
    const deviceResult = loadDeviceSettings(storedDevice ?? legacyDevice);
    this.vaultSettings = vaultResult.value;
    this.setDeviceSettings(deviceResult.value);
    if (
      (storedDevice === null || storedDevice === undefined) &&
      legacyDevice !== null &&
      legacyDevice !== undefined
    ) {
      this.devicePort.saveLocalStorage(DEVICE_SETTINGS_STORAGE_KEY, deviceResult.value);
    }
    return { vault: vaultResult.diagnostics, device: deviceResult.diagnostics };
  }

  public getVaultSettings(): InkbookSettingsV4 {
    return structuredClone(this.vaultSettings);
  }

  public getDeviceSettings(): InkbookDeviceSettingsV2 {
    return structuredClone(this.deviceSettings);
  }

  public subscribeDeviceSettings(listener: DeviceSettingsListener): () => void {
    this.deviceSettingsListeners.add(listener);
    return () => {
      this.deviceSettingsListeners.delete(listener);
    };
  }

  public subscribeVaultSettings(listener: VaultSettingsListener): () => void {
    this.vaultSettingsListeners.add(listener);
    return () => {
      this.vaultSettingsListeners.delete(listener);
    };
  }

  public async replaceVaultSettings(value: InkbookSettingsV4): Promise<void> {
    await this.enqueueVaultWrite(() => value);
  }

  public replaceDeviceSettings(value: InkbookDeviceSettingsV2): void {
    const result = loadDeviceSettings(value);
    if (result.diagnostics.length > 0) throw new Error("Invalid device settings");
    this.devicePort.saveLocalStorage(DEVICE_SETTINGS_STORAGE_KEY, result.value);
    this.setDeviceSettings(result.value);
  }

  public async updateVaultSettings(
    update: (settings: InkbookSettingsV4) => InkbookSettingsV4,
  ): Promise<void> {
    await this.enqueueVaultWrite(update);
  }

  public updateDeviceSettings(
    update: (settings: InkbookDeviceSettingsV2) => InkbookDeviceSettingsV2,
  ): void {
    this.replaceDeviceSettings(update(structuredClone(this.deviceSettings)));
  }

  public async resetAll(): Promise<void> {
    const vault = createBuiltInSettings();
    const device = createBuiltInDeviceSettings();
    await this.replaceVaultSettings(vault);
    this.replaceDeviceSettings(device);
  }

  private async enqueueVaultWrite(
    update: (settings: InkbookSettingsV4) => InkbookSettingsV4,
  ): Promise<void> {
    const operation = this.vaultWrites.then(async () => {
      const candidate = update(structuredClone(this.vaultSettings));
      const result = loadSettings(candidate);
      if (result.diagnostics.length > 0) throw new Error("Invalid vault settings");
      await this.vaultPort.saveData(result.value);
      this.vaultSettings = result.value;
      for (const listener of [...this.vaultSettingsListeners]) {
        listener(structuredClone(this.vaultSettings));
      }
    });
    this.vaultWrites = operation.catch(() => undefined);
    await operation;
  }

  private setDeviceSettings(settings: InkbookDeviceSettingsV2): void {
    if (deviceSettingsEqual(this.deviceSettings, settings)) return;
    this.deviceSettings = structuredClone(settings);
    for (const listener of [...this.deviceSettingsListeners]) {
      listener(structuredClone(this.deviceSettings));
    }
  }
}
