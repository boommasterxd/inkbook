import {
  PluginSettingTab,
  type App,
  type Plugin,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingDefinitionRender,
} from "obsidian";

import {
  MOTION_PREFERENCES,
  createBuiltInDeviceSettings,
  createBuiltInSettings,
  type InkbookSettingsV4,
} from "../../domain/settings";
import { DEFAULT_REFRESH_RATE, type RefreshRateProfileStatus } from "../performance";
import { SettingsControlValues, type SettingsControlKey } from "./control-values";
import { dropdown, resetAction, settingsAction, toggle } from "./definition-helpers";
import { createLabels, generalGroup } from "./general-definitions";
import { pageDefaultsGroup } from "./page-defaults";
import { createObsidianHotkeyAccess } from "./obsidian-hotkey-conflicts";
import { snappingGroup } from "./snapping-definitions";
import { shortcutGroup } from "./shortcut-definitions";
import { InkbookSettingsStore } from "./storage";
import { drawingToolsGroup, shapesAndStructuresGroup } from "./tool-definitions";

export interface CustomFolderPort {
  createFolder(path: string): Promise<void>;
}

function cloneDefaults<K extends keyof InkbookSettingsV4["toolDefaults"]>(
  key: K,
): InkbookSettingsV4["toolDefaults"][K] {
  return structuredClone(createBuiltInSettings().toolDefaults[key]);
}

export class InkbookSettingTab extends PluginSettingTab {
  private readonly controls: SettingsControlValues;

  public constructor(
    app: App,
    plugin: Plugin,
    private readonly store: InkbookSettingsStore,
    private readonly folderPort?: CustomFolderPort,
    private readonly refreshRateStatus?: () => RefreshRateProfileStatus | undefined,
  ) {
    super(app, plugin);
    this.controls = new SettingsControlValues(store);
  }

  public override getControlValue(key: string): unknown {
    return this.controls.get(key as SettingsControlKey);
  }

  public override async setControlValue(key: string, value: unknown): Promise<void> {
    await this.controls.set(key as SettingsControlKey, value);
    this.refreshDomState();
  }

  public override getSettingDefinitions(): SettingDefinitionItem<SettingsControlKey>[] {
    const pageValues = {
      get: (key: SettingsControlKey) => this.controls.get(key),
      set: (key: SettingsControlKey, value: unknown) => this.controls.set(key, value),
    };
    const toolValues = {
      getDefaults: () => this.store.getVaultSettings().toolDefaults,
      getMotion: () => this.store.getDeviceSettings().motion,
      set: (key: SettingsControlKey, value: unknown) => this.controls.set(key, value),
    };
    return [
      generalGroup({
        isCustomFolder: () => this.isCustomFolder(),
        canCreateFolder: () => this.folderPort !== undefined && this.isCustomFolder(),
        createFolder: (element) => this.createCustomFolder(element),
        refreshRateStatus: () =>
          this.refreshRateStatus?.() ?? {
            kind: "detecting",
            refreshRate: DEFAULT_REFRESH_RATE,
          },
        reset: () => this.resetGeneral(),
      }),
      pageDefaultsGroup(pageValues, () => this.resetPageDefaults()),
      drawingToolsGroup(toolValues, () => this.resetDrawingTools()),
      shapesAndStructuresGroup(toolValues, () => this.resetShapesAndStructures()),
      snappingGroup({
        get: (key) => this.controls.get(key),
        readMotion: () => this.store.getDeviceSettings().motion,
        reset: () => this.resetSnapping(),
        set: (key, value) => this.controls.set(key, value),
      }),
      ...this.deviceGroups(),
      shortcutGroup(this.store, createObsidianHotkeyAccess(this.app)),
      this.resetAllAction(),
    ];
  }

  private isCustomFolder(): boolean {
    return this.store.getVaultSettings().filePlacement.mode === "custom-vault-folder";
  }

  private createCustomFolder(element: HTMLElement): void {
    const placement = this.store.getVaultSettings().filePlacement;
    if (placement.mode !== "custom-vault-folder") return;
    const confirmed = element.ownerDocument.defaultView?.confirm(
      `Create the vault folder “${placement.folder}”?`,
    );
    if (confirmed === true) void this.folderPort?.createFolder(placement.folder);
  }

  private resetGeneral(): void {
    const defaults = createBuiltInSettings();
    void this.store
      .updateVaultSettings((settings) => ({
        ...settings,
        startupTool: defaults.startupTool,
        refreshRatePreference: defaults.refreshRatePreference,
        filePlacement: structuredClone(defaults.filePlacement),
      }))
      .then(() => this.update());
  }

  private resetPageDefaults(): void {
    const defaults = createBuiltInSettings();
    void this.store
      .updateVaultSettings((settings) => ({
        ...settings,
        pageDefaults: structuredClone(defaults.pageDefaults),
      }))
      .then(() => this.update());
  }

  private resetDrawingTools(): void {
    void this.store
      .updateVaultSettings((settings) => {
        settings.toolDefaults.select = cloneDefaults("select");
        settings.toolDefaults.pen = cloneDefaults("pen");
        settings.toolDefaults.highlighter = cloneDefaults("highlighter");
        settings.toolDefaults.straightHighlighter = cloneDefaults("straightHighlighter");
        settings.toolDefaults.eraser = cloneDefaults("eraser");
        return settings;
      })
      .then(() => this.update());
  }

  private resetShapesAndStructures(): void {
    void this.store
      .updateVaultSettings((settings) => {
        settings.toolDefaults.shapes = cloneDefaults("shapes");
        settings.toolDefaults.arrow = cloneDefaults("arrow");
        settings.toolDefaults.coordinateSystem = cloneDefaults("coordinateSystem");
        settings.toolDefaults.table = cloneDefaults("table");
        return settings;
      })
      .then(() => this.update());
  }

  private resetSnapping(): void {
    const defaults = createBuiltInSettings();
    void this.store
      .updateVaultSettings((settings) => ({
        ...settings,
        snapping: structuredClone(defaults.snapping),
      }))
      .then(() => this.update());
  }

  private deviceGroups(): SettingDefinitionGroup<SettingsControlKey>[] {
    const defaults = createBuiltInDeviceSettings();
    return [this.inputGroup(defaults), this.interfaceGroup(defaults)];
  }

  private inputGroup(
    defaults: ReturnType<typeof createBuiltInDeviceSettings>,
  ): SettingDefinitionGroup<SettingsControlKey> {
    return {
      type: "group",
      heading: "Input",
      cls: "inkbook-settings-input-group",
      items: [
        toggle(
          "device.fingerDrawingEnabled",
          "Finger drawing",
          "Show the session-only finger drawing toggle in each embed.",
        ),
        toggle(
          "device.penTapInsertionEnabled",
          "Pen-tap insertion",
          "Insert an Inkbook embed when tapping with a pen.",
        ),
        resetAction("Reset group to defaults", () => {
          this.store.updateDeviceSettings((settings) => ({
            ...settings,
            fingerDrawingEnabled: defaults.fingerDrawingEnabled,
            penTapInsertion: defaults.penTapInsertion,
          }));
          this.update();
        }),
      ],
    };
  }

  private interfaceGroup(
    defaults: ReturnType<typeof createBuiltInDeviceSettings>,
  ): SettingDefinitionGroup<SettingsControlKey> {
    return {
      type: "group",
      heading: "Interface",
      cls: "inkbook-settings-interface-group",
      items: [
        toggle(
          "device.leftHandedToolbar",
          "Left-handed toolbar",
          "Align the toolbar for left-handed use.",
        ),
        dropdown(
          "device.motion",
          "Motion",
          "Choose how Inkbook presents non-essential motion.",
          createLabels(MOTION_PREFERENCES),
        ),
        resetAction("Reset group to defaults", () => {
          this.store.updateDeviceSettings((settings) => ({
            ...settings,
            leftHandedToolbar: defaults.leftHandedToolbar,
            motion: defaults.motion,
          }));
          this.update();
        }),
      ],
    };
  }

  private resetAllAction(): SettingDefinitionRender {
    return settingsAction(
      "Reset all Inkbook settings",
      "Restore every built-in value without changing existing files or elements.",
      "danger",
      (element) => {
        if (element.ownerDocument.defaultView?.confirm("Reset all Inkbook settings?") === true) {
          void this.store.resetAll().then(() => this.update());
        }
      },
    );
  }
}
