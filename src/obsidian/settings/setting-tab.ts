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
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { confirmInkbookAction } from "../dialogs/action-dialog";
import { DEFAULT_REFRESH_RATE, type RefreshRateProfileStatus } from "../performance";
import { SettingsControlValues, type SettingsControlKey } from "./control-values";
import { nativeSettingDefinitions } from "./setting-control-renderer";
import {
  dropdown,
  resetAction,
  settingsAction,
  toggle,
  withSettingsActionFeedback,
} from "./definitions/definition-helpers";
import { createLabels, generalGroup } from "./definitions/general-definitions";
import { pageDefaultsGroup } from "./definitions/page-defaults";
import { performanceGroup } from "./definitions/performance-definitions";
import { createObsidianHotkeyAccess } from "./shortcuts/obsidian-hotkey-conflicts";
import { snappingGroup } from "./definitions/snapping-definitions";
import { shortcutGroup } from "./shortcuts/shortcut-definitions";
import { InkbookSettingsStore } from "./storage";
import { drawingToolsGroup, shapesAndStructuresGroup } from "./definitions/tool-definitions";

export interface CustomFolderPort {
  createFolder(path: string): Promise<void>;
}

interface SettingsScheduling {
  readonly lifetime?: AbortSignal;
  readonly workScheduler?: (ownerWindow: Window | null) => WorkScheduler;
}

function cloneDefaults<K extends keyof InkbookSettingsV4["toolDefaults"]>(
  key: K,
): InkbookSettingsV4["toolDefaults"][K] {
  return structuredClone(createBuiltInSettings().toolDefaults[key]);
}

export class InkbookSettingTab extends PluginSettingTab {
  private readonly controls: SettingsControlValues;
  private readonly updateListeners = new Set<() => void>();
  readonly settingsFeedback = {
    readMotion: () => this.store.getDeviceSettings().motion,
    observeMotion: (listener: () => void) => this.store.subscribeDeviceSettings(listener),
  };

  public constructor(
    app: App,
    plugin: Plugin,
    private readonly store: InkbookSettingsStore,
    private readonly folderPort?: CustomFolderPort,
    private readonly refreshRateStatus?: () => RefreshRateProfileStatus | undefined,
    private readonly scheduling?: SettingsScheduling,
  ) {
    super(app, plugin);
    this.controls = new SettingsControlValues(store);
  }

  public override getControlValue(key: string): unknown {
    return this.controls.get(key as SettingsControlKey);
  }

  public override update(): void {
    super.update();
    for (const listener of [...this.updateListeners]) listener();
  }

  public subscribeUpdates(listener: () => void): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  public override async setControlValue(key: string, value: unknown): Promise<void> {
    await this.controls.set(key as SettingsControlKey, value);
    this.refreshDomState();
  }

  public override getSettingDefinitions(): SettingDefinitionItem<SettingsControlKey>[] {
    return nativeSettingDefinitions(this.getControlDefinitions(), this, this.scheduling?.lifetime);
  }

  public getControlDefinitions(): SettingDefinitionItem<SettingsControlKey>[] {
    const pageValues = {
      get: (key: SettingsControlKey) => this.controls.get(key),
      readMotion: () => this.store.getDeviceSettings().motion,
      observeMotion: (listener: () => void) => this.store.subscribeDeviceSettings(listener),
      set: (key: SettingsControlKey, value: unknown) => this.controls.set(key, value),
      workScheduler: (ownerWindow: Window | null) => this.scheduler(ownerWindow),
    };
    const toolValues = {
      getDefaults: () => this.store.getVaultSettings().toolDefaults,
      getMotion: () => this.store.getDeviceSettings().motion,
      observeMotion: (listener: () => void) => this.store.subscribeDeviceSettings(listener),
      workScheduler: (ownerWindow: Window | null) => this.scheduler(ownerWindow),
      set: (key: SettingsControlKey, value: unknown) => this.controls.set(key, value),
    };
    return [
      generalGroup({
        isCustomFolder: () => this.isCustomFolder(),
        canCreateFolder: () => this.folderPort !== undefined && this.isCustomFolder(),
        createFolder: withSettingsActionFeedback(
          (element: HTMLElement) => this.createCustomFolder(element),
          this.settingsFeedback,
        ),
        reset: withSettingsActionFeedback(() => this.resetGeneral(), this.settingsFeedback),
      }),
      performanceGroup({
        readMotion: () => this.store.getDeviceSettings().motion,
        observeMotion: (listener) => this.store.subscribeDeviceSettings(listener),
        get: (key) => this.controls.get(key),
        set: (key, value) => this.controls.set(key, value),
        refreshRateStatus: () =>
          this.refreshRateStatus?.() ?? {
            kind: "detecting",
            refreshRate: DEFAULT_REFRESH_RATE,
          },
        reset: withSettingsActionFeedback(() => this.resetPerformance(), this.settingsFeedback),
      }),
      pageDefaultsGroup(
        pageValues,
        withSettingsActionFeedback(() => this.resetPageDefaults(), this.settingsFeedback),
      ),
      drawingToolsGroup(
        toolValues,
        withSettingsActionFeedback(() => this.resetDrawingTools(), this.settingsFeedback),
      ),
      shapesAndStructuresGroup(
        toolValues,
        withSettingsActionFeedback(() => this.resetShapesAndStructures(), this.settingsFeedback),
      ),
      snappingGroup({
        observeMotion: (listener) => this.store.subscribeDeviceSettings(listener),
        get: (key) => this.controls.get(key),
        readMotion: () => this.store.getDeviceSettings().motion,
        workScheduler: (ownerWindow: Window | null) => this.scheduler(ownerWindow),
        reset: withSettingsActionFeedback(() => this.resetSnapping(), this.settingsFeedback),
        set: (key, value) => this.controls.set(key, value),
      }),
      ...this.deviceGroups(),
      shortcutGroup(this.store, createObsidianHotkeyAccess(this.app), (ownerWindow) =>
        this.scheduler(ownerWindow),
      ),
      this.resetAllAction(),
    ];
  }

  public scheduler(ownerWindow: Window | null): WorkScheduler {
    if (this.scheduling?.workScheduler === undefined)
      throw new Error("Settings require a work scheduler.");
    return this.scheduling.workScheduler(ownerWindow);
  }

  private dialogOptions() {
    return {
      signal: this.scheduling?.lifetime,
      readMotion: () => this.store.getDeviceSettings().motion,
      observeMotion: (listener: () => void) => this.store.subscribeDeviceSettings(listener),
      workScheduler: (ownerWindow: Window | null) => this.scheduler(ownerWindow),
    };
  }

  private isCustomFolder(): boolean {
    return this.store.getVaultSettings().filePlacement.mode === "custom-vault-folder";
  }

  private async createCustomFolder(element: HTMLElement): Promise<void> {
    const placement = this.store.getVaultSettings().filePlacement;
    if (placement.mode !== "custom-vault-folder") return;
    const confirmed = await confirmInkbookAction(this.app, {
      title: "Create custom folder?",
      description: `Create the vault folder “${placement.folder}”?`,
      confirmLabel: "Create folder",
      ...this.dialogOptions(),
    });
    const current = this.store.getVaultSettings().filePlacement;
    if (
      confirmed &&
      element.isConnected &&
      current.mode === "custom-vault-folder" &&
      current.folder === placement.folder
    ) {
      await this.folderPort?.createFolder(placement.folder);
    }
  }

  private resetGeneral(): Promise<void> {
    const defaults = createBuiltInSettings();
    return this.store
      .updateVaultSettings((settings) => ({
        ...settings,
        startupTool: defaults.startupTool,
        filePlacement: structuredClone(defaults.filePlacement),
      }))
      .then(() => this.update());
  }

  private resetPerformance(): Promise<void> {
    const defaults = createBuiltInSettings();
    return this.store
      .updateVaultSettings((settings) => ({
        ...settings,
        selectionHighlightsEnabled: defaults.selectionHighlightsEnabled,
        refreshRatePreference: defaults.refreshRatePreference,
      }))
      .then(() => {
        this.store.updateDeviceSettings((settings) => ({
          ...settings,
          scrollPreloadMarginPx: createBuiltInDeviceSettings().scrollPreloadMarginPx,
        }));
        this.update();
      });
  }

  private resetPageDefaults(): Promise<void> {
    const defaults = createBuiltInSettings();
    return this.store
      .updateVaultSettings((settings) => ({
        ...settings,
        pageDefaults: structuredClone(defaults.pageDefaults),
      }))
      .then(() => this.update());
  }

  private resetDrawingTools(): Promise<void> {
    return this.store
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

  private resetShapesAndStructures(): Promise<void> {
    return this.store
      .updateVaultSettings((settings) => {
        settings.toolDefaults.shapes = cloneDefaults("shapes");
        settings.toolDefaults.arrow = cloneDefaults("arrow");
        settings.toolDefaults.coordinateSystem = cloneDefaults("coordinateSystem");
        settings.toolDefaults.table = cloneDefaults("table");
        return settings;
      })
      .then(() => this.update());
  }

  private resetSnapping(): Promise<void> {
    const defaults = createBuiltInSettings();
    return this.store
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
        resetAction(
          "Reset group to defaults",
          withSettingsActionFeedback(() => {
            this.store.updateDeviceSettings((settings) => ({
              ...settings,
              fingerDrawingEnabled: defaults.fingerDrawingEnabled,
              penTapInsertion: defaults.penTapInsertion,
            }));
            this.update();
          }, this.settingsFeedback),
        ),
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
        resetAction(
          "Reset group to defaults",
          withSettingsActionFeedback(() => {
            this.store.updateDeviceSettings((settings) => ({
              ...settings,
              leftHandedToolbar: defaults.leftHandedToolbar,
              motion: defaults.motion,
            }));
            this.update();
          }, this.settingsFeedback),
        ),
      ],
    };
  }

  private resetAllAction(): SettingDefinitionRender {
    return settingsAction(
      "Reset all Inkbook settings",
      "Restore every built-in value without changing existing files or elements.",
      "danger",
      withSettingsActionFeedback(
        (element: HTMLElement) => this.confirmResetAll(element),
        this.settingsFeedback,
      ),
    );
  }

  private async confirmResetAll(element: HTMLElement): Promise<void> {
    const confirmed = await confirmInkbookAction(this.app, {
      title: "Reset all settings?",
      description: "Restore every built-in value. Existing files and elements will not change.",
      confirmLabel: "Reset settings",
      ...this.dialogOptions(),
      destructive: true,
    });
    if (!confirmed || !element.isConnected) return;
    await this.store.resetAll();
    this.update();
  }
}
