import { Platform, setIcon, type Setting, type SettingDefinitionRender } from "obsidian";

import type { InkbookDeviceSettingsV1, StartupToolV1, ToolDefaultsV1 } from "../../domain/settings";
import { createToolStyleControls } from "../menus/tool-style-controls";
import type { SettingsControlKey } from "./control-values";
import { renderSettingsControlContent } from "./settings-control-content";

const TOOL_PANEL_TRANSITION_TIMEOUT_MS = 300;

export interface ToolSectionSpec {
  readonly controlDescriptions: Readonly<Record<string, string>>;
  readonly controlKeys: Readonly<Record<string, SettingsControlKey>>;
  readonly description: string;
  readonly name: string;
  readonly tool: StartupToolV1;
}

export interface ToolSectionValues {
  readonly getDefaults: () => ToolDefaultsV1;
  readonly getMotion: () => InkbookDeviceSettingsV1["motion"];
  readonly set: (key: SettingsControlKey, value: unknown) => Promise<void>;
}

export function toolSectionDefinition(
  spec: ToolSectionSpec,
  values: ToolSectionValues,
): SettingDefinitionRender {
  return {
    name: spec.name,
    desc: spec.description,
    render: (setting) => renderToolSection(setting, spec, values),
  };
}

function renderToolSection(
  setting: Setting,
  spec: ToolSectionSpec,
  values: ToolSectionValues,
): () => void {
  setting.settingEl.replaceChildren();
  setting.settingEl.classList.add("inkbook-settings-tool-row");
  const section = setting.settingEl.createEl("section", { cls: "inkbook-settings-tool-section" });
  const trigger = section.createEl("button", { cls: "inkbook-settings-tool-trigger" });
  if (Platform.isMobile) trigger.classList.add("inkbook-settings-tool-trigger-touch");
  const panelId = `inkbook-settings-tool-${spec.tool}`;
  const descriptionId = `${panelId}-description`;
  trigger.type = "button";
  trigger.setAttribute("aria-controls", panelId);
  trigger.setAttribute("aria-describedby", descriptionId);
  trigger.setAttribute("aria-expanded", "false");
  trigger.createSpan({ cls: "inkbook-settings-tool-title", text: spec.name });
  const accessibleDescription = trigger.createSpan({
    cls: "inkbook-menu-visually-hidden",
    text: spec.description,
  });
  accessibleDescription.id = descriptionId;
  const chevron = trigger.createSpan({ cls: "inkbook-settings-tool-chevron" });
  setIcon(chevron, "chevron-right");

  const panel = section.createDiv({ cls: "inkbook-settings-tool-panel" });
  panel.id = panelId;
  panel.hidden = true;
  panel.inert = true;
  const panelContent = panel.createDiv({ cls: "inkbook-settings-tool-panel-content" });
  panelContent.createEl("p", {
    cls: "inkbook-settings-tool-description",
    text: spec.description,
  });
  const controls = panelContent.createDiv({ cls: "inkbook-settings-tool-controls" });
  renderSettingsControlContent(controls, {
    controls: () => createToolStyleControls(values.getDefaults(), spec.tool),
    descriptions: spec.controlDescriptions,
    idPrefix: panelId,
    onChange: (controlId, value) => setToolControl(spec, values, controlId, value),
    ownerDocument: setting.settingEl.ownerDocument,
  });

  const panelMotion = new ToolPanelMotion(panel, values.getMotion);
  const toggle = (): void => {
    const expanded = trigger.getAttribute("aria-expanded") !== "true";
    trigger.setAttribute("aria-expanded", String(expanded));
    panelMotion.setExpanded(expanded);
  };
  trigger.addEventListener("click", toggle);
  return () => {
    trigger.removeEventListener("click", toggle);
    panelMotion.dispose();
  };
}

class ToolPanelMotion {
  readonly #ownerWindow: Window | null;
  readonly #panel: HTMLElement;
  readonly #readMotion: () => InkbookDeviceSettingsV1["motion"];
  #cancelTransition: (() => void) | undefined;

  public constructor(panel: HTMLElement, readMotion: () => InkbookDeviceSettingsV1["motion"]) {
    this.#ownerWindow = panel.ownerDocument.defaultView;
    this.#panel = panel;
    this.#readMotion = readMotion;
  }

  public setExpanded(expanded: boolean): void {
    if (this.#reducedMotion()) {
      this.#cancelTransition?.();
      this.#panel.inert = !expanded;
      this.#applyFinalState(expanded);
      return;
    }

    const currentHeight = this.#panel.hidden ? 0 : this.#panel.getBoundingClientRect().height;
    this.#cancelTransition?.();
    this.#panel.inert = !expanded;
    this.#panel.hidden = false;
    const targetHeight = expanded ? this.#panel.getBoundingClientRect().height : 0;
    this.#startTransition(currentHeight, targetHeight, expanded);
  }

  public dispose(): void {
    this.#cancelTransition?.();
  }

  #applyFinalState(expanded: boolean): void {
    this.#panel.hidden = !expanded;
    delete this.#panel.dataset.resizing;
    this.#panel.style.removeProperty("block-size");
  }

  #reducedMotion(): boolean {
    const motion = this.#readMotion();
    if (motion !== "system") return motion === "reduced";
    return this.#ownerWindow?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? true;
  }

  #startTransition(start: number, target: number, expanded: boolean): void {
    const ownerWindow = this.#ownerWindow;
    if (ownerWindow === null || Math.abs(target - start) < 0.5) {
      this.#applyFinalState(expanded);
      return;
    }

    const panel = this.#panel;
    panel.dataset.resizing = "true";
    panel.style.blockSize = `${String(start)}px`;
    void panel.offsetHeight;
    panel.style.blockSize = `${String(target)}px`;
    this.#listenForCompletion(ownerWindow, expanded);
  }

  #listenForCompletion(ownerWindow: Window, expanded: boolean): void {
    let timeout: number | undefined;
    const cancel = (): void => {
      this.#panel.removeEventListener("transitionend", onTransitionEnd);
      this.#panel.removeEventListener("transitioncancel", finish);
      if (timeout !== undefined) ownerWindow.clearTimeout(timeout);
      this.#cancelTransition = undefined;
      delete this.#panel.dataset.resizing;
      this.#panel.style.removeProperty("block-size");
    };
    const finish = (): void => {
      cancel();
      this.#applyFinalState(expanded);
    };
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (
        event.target === this.#panel &&
        (event.propertyName === "block-size" || event.propertyName === "height")
      )
        finish();
    };
    this.#cancelTransition = cancel;
    this.#panel.addEventListener("transitionend", onTransitionEnd);
    this.#panel.addEventListener("transitioncancel", finish);
    timeout = ownerWindow.setTimeout(finish, TOOL_PANEL_TRANSITION_TIMEOUT_MS);
  }
}

function setToolControl(
  spec: ToolSectionSpec,
  values: ToolSectionValues,
  controlId: string,
  value: boolean | number | string,
): Promise<void> {
  const key = spec.controlKeys[controlId];
  return key === undefined
    ? Promise.reject(new RangeError(`Missing settings key for ${spec.tool}.${controlId}.`))
    : values.set(key, value);
}
