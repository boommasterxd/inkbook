import { BUILT_IN_TEXT_FONT_OPTIONS } from "../menus/text-style-controls";
import { FontOptionPreviews } from "../fonts/font-option-previews";
import type { PluginFontLibrary } from "../fonts/plugin-font-library";
import { bindElementLanguage } from "../../rendering/localization/element-language";
import {
  PluginSettingTab,
  type App,
  type Plugin,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingDefinitionRender,
} from "obsidian";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
  type InkbookSettingsV4,
} from "../../domain/settings";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { confirmInkbookAction } from "../dialogs/action-dialog";
import { DEFAULT_REFRESH_RATE, type RefreshRateProfileStatus } from "../performance";
import { SettingsControlValues, type SettingsControlKey } from "./control-values";
import { SettingsViewState } from "./settings-view-state";
import { nativeSettingDefinitions } from "./setting-control-renderer";
import { refreshSettingsView } from "./settings-view-refresh";
import {
  resetAction,
  settingsAction,
  toggle,
  withSettingsActionFeedback,
} from "./definitions/definition-helpers";
import { appearanceGroup, generalGroup } from "./definitions/general-definitions";
import { pageDefaultsGroup } from "./definitions/page-defaults";
import { performanceGroup } from "./definitions/performance-definitions";
import { createObsidianHotkeyAccess } from "./shortcuts/obsidian-hotkey-conflicts";
import { snappingGroup } from "./definitions/snapping-definitions";
import { holdToShapeGroup } from "./definitions/hold-to-shape-definitions";
import { shortcutGroup } from "./shortcuts/shortcut-definitions";
import { InkbookSettingsStore } from "./storage";
import { drawingToolsGroup, shapesAndStructuresGroup } from "./definitions/tool-definitions";
import type { ToolSectionValues } from "./definitions/tool-section";
import type { InkImportSettingsAccess } from "./import/import-access";
import { importSettingsGroup } from "./import/import-settings";
import type { ImportHistoryState } from "./import/import-history";

export interface CustomFolderPort {
  createFolder(path: string): Promise<void>;
}

interface SettingsScheduling {
  readonly openFontManager?: (trigger: HTMLButtonElement) => void;
  readonly lifetime?: AbortSignal;
  readonly inkImport?: InkImportSettingsAccess;
  readonly fontLibrary?: PluginFontLibrary;
  readonly workScheduler?: (ownerWindow: Window | null) => WorkScheduler;
}

function cloneDefaults<K extends keyof InkbookSettingsV4["toolDefaults"]>(
  key: K,
): InkbookSettingsV4["toolDefaults"][K] {
  return structuredClone(createBuiltInSettings().toolDefaults[key]);
}

export class InkbookSettingTab extends PluginSettingTab {
  private readonly controls: SettingsControlValues;
  private readonly nativeViewState = new SettingsViewState();
  private readonly importHistoryState: ImportHistoryState = {};
  private readonly updateListeners = new Set<() => void>();
  readonly settingsFeedback = {
    t: (
      key: import("../../domain/localization").MessageKey,
      parameters?: import("../../domain/localization").TranslationParameters,
    ) => this.store.localization.t(key, parameters),
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
    plugin.register?.(bindElementLanguage(this.containerEl, store.localization));
    const unsubscribe = store.localization.subscribe(() => this.update());
    plugin.register?.(unsubscribe);
  }

  public get fontLibrary(): PluginFontLibrary | undefined {
    return this.scheduling?.fontLibrary;
  }

  public get openFontManager(): ((trigger: HTMLButtonElement) => void) | undefined {
    return this.scheduling?.openFontManager;
  }

  public override getControlValue(key: string): unknown {
    return this.controls.get(key as SettingsControlKey);
  }

  public override update(): void {
    refreshSettingsView(this.containerEl, () => super.update());
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
    if (key === "holdToShape.enabled") this.update();
    this.refreshDomState();
  }

  public override getSettingDefinitions(): SettingDefinitionItem<SettingsControlKey>[] {
    return nativeSettingDefinitions(this.getControlDefinitions(), this, this.scheduling?.lifetime);
  }

  public getControlDefinitions(
    viewState = this.nativeViewState,
  ): SettingDefinitionItem<SettingsControlKey>[] {
    const pageValues = {
      t: this.store.localization.t,
      get: (key: SettingsControlKey) => this.controls.get(key),
      readMotion: () => this.store.getDeviceSettings().motion,
      observeMotion: (listener: () => void) => this.store.subscribeDeviceSettings(listener),
      set: (key: SettingsControlKey, value: unknown) => this.controls.set(key, value),
      workScheduler: (ownerWindow: Window | null) => this.scheduler(ownerWindow),
    };
    const toolValues = this.toolSectionValues(viewState);
    const definitions = [
      generalGroup({
        t: this.store.localization.t,
        isCustomFolder: () => this.isCustomFolder(),
        canCreateFolder: () => this.folderPort !== undefined && this.isCustomFolder(),
        createFolder: withSettingsActionFeedback(
          (element: HTMLElement) => this.createCustomFolder(element),
          this.settingsFeedback,
        ),
        reset: withSettingsActionFeedback(() => this.resetGeneral(), this.settingsFeedback),
      }),
      appearanceGroup(
        this.store.localization.t,
        withSettingsActionFeedback(() => this.resetAppearance(), this.settingsFeedback),
      ),
      performanceGroup({
        t: this.store.localization.t,
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
        t: this.store.localization.t,
        observeMotion: (listener) => this.store.subscribeDeviceSettings(listener),
        get: (key) => this.controls.get(key),
        readMotion: () => this.store.getDeviceSettings().motion,
        workScheduler: (ownerWindow: Window | null) => this.scheduler(ownerWindow),
        reset: withSettingsActionFeedback(() => this.resetSnapping(), this.settingsFeedback),
        set: (key, value) => this.controls.set(key, value),
      }),
      this.inputGroup(createBuiltInDeviceSettings()),
      holdToShapeGroup(
        pageValues,
        withSettingsActionFeedback(() => this.resetHoldToShape(), this.settingsFeedback),
      ),
      shortcutGroup(
        this.store,
        this.app.keymap,
        createObsidianHotkeyAccess(this.app),
        (ownerWindow) => this.scheduler(ownerWindow),
        viewState,
      ),
      ...(this.scheduling?.inkImport === undefined
        ? []
        : [
            importSettingsGroup({
              access: this.scheduling.inkImport,
              state: this.importHistoryState,
              localization: this.store.localization,
              signal: this.scheduling.lifetime,
              ...this.settingsFeedback,
            }),
          ]),
      this.resetAllAction(),
    ];
    return definitions.map((definition, index) =>
      Object.assign(definition, { settingsIdentity: `settings-group:${String(index)}` }),
    );
  }

  private toolSectionValues(viewState: SettingsViewState): ToolSectionValues {
    return {
      keymap: this.app.keymap,
      createFontPreviews: (document: Document) => this.createFontOptionPreviews(document),
      ...(this.openFontManager === undefined
        ? {}
        : {
            fontManagementAction: {
              label: () => this.store.localization.t("fonts.manage"),
              onActivate: this.openFontManager,
            },
          }),
      t: this.store.localization.t,
      viewState,
      getDefaults: () => this.store.getVaultSettings().toolDefaults,
      getTextFontOptions: () => [
        ...BUILT_IN_TEXT_FONT_OPTIONS,
        ...(this.scheduling?.fontLibrary?.choices() ?? []),
      ],
      getMotion: () => this.store.getDeviceSettings().motion,
      observeMotion: (listener: () => void) => this.store.subscribeDeviceSettings(listener),
      workScheduler: (ownerWindow: Window | null) => this.scheduler(ownerWindow),
      set: (key: SettingsControlKey, value: unknown) => this.controls.set(key, value),
    };
  }

  private createFontOptionPreviews(document: Document): FontOptionPreviews {
    return new FontOptionPreviews({
      document,
      scheduler: this.scheduler(document.defaultView),
      ...(this.scheduling?.fontLibrary === undefined
        ? {}
        : { library: this.scheduling.fontLibrary }),
    });
  }

  public scheduler(ownerWindow: Window | null): WorkScheduler {
    if (this.scheduling?.workScheduler === undefined)
      throw new Error("Settings require a work scheduler.");
    return this.scheduling.workScheduler(ownerWindow);
  }

  private dialogOptions() {
    return {
      localization: this.store.localization,
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
      title: () => this.store.localization.t("settings.folderTitle"),
      description: () =>
        this.store.localization.t("settings.folderConfirmation", {
          folder: placement.folder,
        }),
      confirmLabel: () => this.store.localization.t("settings.folderConfirm"),
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
        copyTextFieldsAsText: defaults.copyTextFieldsAsText,
      }))
      .then(() => this.update());
  }

  private resetAppearance(): void {
    const defaults = createBuiltInDeviceSettings();
    this.store.updateDeviceSettings((settings) => ({
      ...settings,
      leftHandedToolbar: defaults.leftHandedToolbar,
      motion: defaults.motion,
      language: defaults.language,
    }));
    this.update();
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
        settings.toolDefaults.text = cloneDefaults("text");
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
        settings.toolDefaults.line = cloneDefaults("line");
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

  private resetHoldToShape(): Promise<void> {
    return this.store
      .updateVaultSettings((settings) => ({
        ...settings,
        holdToShape: createBuiltInSettings().holdToShape,
      }))
      .then(() => this.update());
  }

  private inputGroup(
    defaults: ReturnType<typeof createBuiltInDeviceSettings>,
  ): SettingDefinitionGroup<SettingsControlKey> {
    return {
      type: "group",
      heading: this.store.localization.t("settings.input"),
      cls: "inkbook-settings-input-group",
      items: [
        toggle(
          "device.fingerDrawingEnabled",
          this.store.localization.t("settings.fingerDrawing"),
          this.store.localization.t("settings.fingerDrawingDescription"),
        ),
        toggle(
          "device.penTapInsertionEnabled",
          this.store.localization.t("settings.penTap"),
          this.store.localization.t("settings.penTapDescription"),
        ),
        resetAction(
          this.store.localization.t("settings.resetGroup"),
          withSettingsActionFeedback(() => {
            this.store.updateDeviceSettings((settings) => ({
              ...settings,
              fingerDrawingEnabled: defaults.fingerDrawingEnabled,
              penTapInsertion: defaults.penTapInsertion,
            }));
            this.update();
          }, this.settingsFeedback),
          this.store.localization.t,
        ),
      ],
    };
  }

  private resetAllAction(): SettingDefinitionRender {
    return settingsAction(
      this.store.localization.t("settings.resetAll"),
      this.store.localization.t("settings.resetDescription"),
      "danger",
      withSettingsActionFeedback(
        (element: HTMLElement) => this.confirmResetAll(element),
        this.settingsFeedback,
      ),
    );
  }

  private async confirmResetAll(element: HTMLElement): Promise<void> {
    const confirmed = await confirmInkbookAction(this.app, {
      title: () => this.store.localization.t("settings.resetTitle"),
      description: () => this.store.localization.t("settings.resetConfirmation"),
      confirmLabel: () => this.store.localization.t("settings.resetConfirm"),
      ...this.dialogOptions(),
      destructive: true,
    });
    if (!confirmed || !element.isConnected) return;
    await this.store.resetAll();
    this.update();
  }
}
