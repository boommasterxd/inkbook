import {
  ButtonComponent,
  setIcon,
  SettingTab,
  type App,
  type Setting,
  type SettingDefinitionGroup,
} from "obsidian";
import type { NativeControlFeedbackOptions } from "../menus/feedback/native-control-feedback";
import { registerNativeControlFeedback } from "../menus/feedback/native-control-feedback";
import { SettingsPanelMotion } from "./settings-panel-motion";
import { createSettingsWriteError, SettingsWriteFeedback } from "./settings-write-feedback";
import type { InkbookSettingsStore } from "./storage";
import type { SettingsControlKey } from "./control-values";

const READABLE_LINE_LENGTH = "readableLineLength";
type WarningAction = "fix" | "dismiss" | "dismissPermanently";

/** The public base implementation reads and writes Obsidian's own settings. */
class EditorWidthSettings extends SettingTab {
  public constructor(app: App) {
    super();
    this.app = app;
  }
}

interface WidthWarningOptions extends NativeControlFeedbackOptions {
  readonly app: App;
  readonly store: InkbookSettingsStore;
  readonly nativeContainer: HTMLElement;
  readonly onChanged: () => void;
}

/** Shares dismissal across native settings, modal and sheet for one plugin lifetime. */
export class ReadableLineWidthWarning {
  readonly #options: WidthWarningOptions;
  readonly #editorSettings: EditorWidthSettings;
  readonly #views = new Set<SettingsPanelMotion>();
  #dismissed = false;

  public constructor(options: WidthWarningOptions) {
    this.#options = options;
    this.#editorSettings = new EditorWidthSettings(options.app);
  }

  public resetSessionDismissal(): void {
    this.#dismissed = false;
  }

  public definition(): SettingDefinitionGroup<SettingsControlKey> {
    const t = this.#options.store.localization.t;
    return {
      type: "group",
      cls: "inkbook-width-warning-group",
      items: [
        {
          name: t("settings.readableWidth.title"),
          desc: t("settings.readableWidth.description"),
          visible: () => this.#syncVisibility(),
          render: (setting, group) => this.#render(setting, group.listEl),
        },
      ],
    };
  }

  #syncVisibility(): boolean {
    const visible = this.#visible();
    for (const view of [...this.#views]) view.setExpanded(visible);
    return visible;
  }

  #visible(): boolean {
    if (
      this.#dismissed ||
      this.#options.store.getDeviceSettings().readableLineWidthWarningDismissed
    )
      return false;
    try {
      return this.#editorSettings.getControlValue(READABLE_LINE_LENGTH) === true;
    } catch {
      return false;
    }
  }

  async #apply(action: WarningAction): Promise<void> {
    if (action === "fix") {
      await this.#editorSettings.setControlValue(READABLE_LINE_LENGTH, false);
      if (this.#editorSettings.getControlValue(READABLE_LINE_LENGTH) !== false)
        throw new Error("Obsidian did not confirm the updated note width.");
    } else if (action === "dismiss") this.#dismissed = true;
    else
      this.#options.store.updateDeviceSettings((settings) => ({
        ...settings,
        readableLineWidthWarningDismissed: true,
      }));
  }

  #close(): void {
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      this.#options.onChanged();
    };
    if (this.#views.size === 0) complete();
    for (const view of [...this.#views]) view.setExpanded(false, complete);
  }

  #render(setting: Setting, footprint: HTMLElement): () => void {
    const row = setting.settingEl;
    row.replaceChildren();
    row.classList.add("inkbook-width-warning", "inkbook-settings-validation-surface");
    const icon = row.createSpan({ cls: "inkbook-width-warning-icon" });
    setIcon(icon, "triangle-alert");
    icon.setAttribute("aria-hidden", "true");
    const content = row.createDiv({ cls: "inkbook-width-warning-content" });
    const t = this.#options.store.localization.t;
    content.createDiv({ cls: "setting-item-name", text: t("settings.readableWidth.title") });
    content.createDiv({
      cls: "setting-item-description",
      text: t("settings.readableWidth.description"),
    });
    const actions = content.createDiv({ cls: "inkbook-width-warning-actions" });
    const writes = new SettingsWriteFeedback(t);
    const error = createSettingsWriteError(content, this.#options);
    let disposed = false;
    let busy = false;
    let pendingFocus: ReturnType<typeof transferWarningActionFocus> | undefined;
    const buttons = new Map<WarningAction, HTMLButtonElement>();
    const enableButtons = (): void => {
      if (!disposed) for (const button of buttons.values()) button.disabled = false;
    };
    const activate = (action: WarningAction): void => {
      if (busy || disposed) return;
      busy = true;
      pendingFocus = transferWarningActionFocus(row, this.#options.nativeContainer);
      for (const button of buttons.values()) button.disabled = true;
      void writes
        .run("width-warning", () => this.#apply(action), {
          error: error.set,
          restore: () => {
            enableButtons();
            pendingFocus?.restore();
          },
          ...(action === "fix" ? { failureMessage: t("settings.readableWidth.failure") } : {}),
          saved: () => this.#close(),
        })
        .finally(() => {
          busy = false;
          pendingFocus?.dispose();
          pendingFocus = undefined;
          enableButtons();
        });
    };
    for (const [action, iconName] of [
      ["fix", "move-horizontal"],
      ["dismiss", "x"],
      ["dismissPermanently", "eye-off"],
    ] as const) {
      const label = t(`settings.readableWidth.${action}`);
      const button = new ButtonComponent(actions);
      button
        .setIcon(iconName)
        .setTooltip(label)
        .onClick(() => activate(action));
      button.buttonEl.type = "button";
      button.buttonEl.classList.add("clickable-icon", "inkbook-width-warning-button");
      button.buttonEl.setAttribute("aria-label", label);
      button.buttonEl.querySelector("svg")?.setAttribute("aria-hidden", "true");
      if (action === "fix") button.buttonEl.createSpan({ text: label });
      buttons.set(action, button.buttonEl);
      error.associate(button.buttonEl);
    }
    const hidden = footprint.hidden;
    const inert = footprint.inert;
    footprint.classList.add("inkbook-width-warning-footprint");
    const motion = new SettingsPanelMotion(
      footprint,
      this.#options.readMotion,
      this.#options.observeMotion,
    );
    this.#views.add(motion);
    const feedback = registerNativeControlFeedback(actions, this.#options);
    return () => {
      disposed = true;
      this.#views.delete(motion);
      motion.dispose();
      footprint.classList.remove("inkbook-width-warning-footprint");
      footprint.hidden = hidden;
      footprint.inert = inert;
      pendingFocus?.dispose();
      feedback();
      writes.dispose();
      error.dispose();
    };
  }
}

/** Move focus before disabled native buttons blur; failed writes may return it unless input moved on. */
function transferWarningActionFocus(row: HTMLElement, nativeContainer: HTMLElement) {
  const document = row.ownerDocument;
  const previous = document.activeElement as HTMLElement | null;
  const scope = row.closest<HTMLElement>(".inkbook-settings-modal-body") ?? nativeContainer;
  const target = scope.querySelector<HTMLElement>(
    ".inkbook-settings-general-group select, .inkbook-settings-general-group button",
  );
  if (!previous || !row.contains(previous) || !target)
    return { restore: () => undefined, dispose: () => undefined };
  target.focus({ preventScroll: true });
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
  };
  const events = ["pointerdown", "keydown", "focusin"] as const;
  for (const event of events) document.addEventListener(event, interrupt, true);
  return {
    restore: (): void => {
      if (!interrupted && document.activeElement === target && previous.isConnected)
        previous.focus({ preventScroll: true });
    },
    dispose: (): void => {
      for (const event of events) document.removeEventListener(event, interrupt, true);
    },
  };
}
