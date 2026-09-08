import {
  setIcon,
  type Setting,
  type SettingDefinitionGroup,
  type SettingDefinitionRender,
} from "obsidian";

import { LINE_SPACINGS } from "../../domain/settings";
import { createBackgroundMenuContent } from "../menus/background-menu-content";
import type {
  BackgroundMenuState,
  BackgroundSpacing,
  BackgroundType,
  StyleControl,
} from "../menus/editor-menu-types";
import type { SettingsControlKey } from "./control-values";
import { resetAction } from "./definition-helpers";
import { renderSettingsControlContent } from "./settings-control-content";

const SPACINGS = ["s", "m", "l", "xl"] as const satisfies readonly BackgroundSpacing[];
const BUFFER_DESCRIPTION = "Set the writable page buffer copied into newly created files.";

export interface PageDefaultsValues {
  readonly get: (key: SettingsControlKey) => unknown;
  readonly set: (key: SettingsControlKey, value: unknown) => Promise<void>;
}

interface BackgroundRenderContext {
  readonly content: HTMLElement;
  readonly descriptionId: string;
  readonly error: HTMLElement;
  readonly ownerDocument: Document;
  readonly state: {
    readonly latestCommits: Map<SettingsControlKey, number>;
    finishLayout?: () => void;
    layoutStartHeight?: number;
    menu: BackgroundMenuState;
  };
  readonly values: PageDefaultsValues;
}

export function pageDefaultsGroup(
  values: PageDefaultsValues,
  reset: () => void,
): SettingDefinitionGroup<SettingsControlKey> {
  return {
    type: "group",
    heading: "Page defaults",
    cls: "inkbook-settings-page-group",
    items: [
      backgroundDefinition(values),
      bufferDefinition(values),
      resetAction("Reset group to defaults", reset),
    ],
  };
}

function backgroundDefinition(values: PageDefaultsValues): SettingDefinitionRender {
  return {
    name: "Background",
    desc: "Configure the background copied into newly created files.",
    aliases: ["None", "Lines", "Dots", "Squares", "Spacing"],
    render: (setting) => renderBackgroundSetting(setting, values),
  };
}

function renderBackgroundSetting(setting: Setting, values: PageDefaultsValues): void {
  setting.settingEl.replaceChildren();
  setting.settingEl.classList.add("inkbook-settings-visual-row", "inkbook-settings-background-row");
  const description = createSettingHeading(
    setting.settingEl,
    "Background",
    "Choose the pattern and spacing copied into newly created files.",
  );
  const content = setting.settingEl.createDiv({ cls: "inkbook-settings-background-content" });
  const error = setting.settingEl.createDiv({ cls: "inkbook-settings-control-error" });
  error.setAttribute("aria-live", "polite");
  error.hidden = true;
  const context: BackgroundRenderContext = {
    content,
    descriptionId: description.id,
    error,
    ownerDocument: setting.settingEl.ownerDocument,
    state: { latestCommits: new Map(), menu: backgroundState(values) },
    values,
  };
  renderBackgroundMenu(context);
}

function renderBackgroundMenu(context: BackgroundRenderContext): void {
  context.content.replaceChildren(
    createBackgroundMenuContent({
      controlDescriptionId: context.descriptionId,
      getState: () => context.state.menu,
      initialState: context.state.menu,
      onBeforeLayoutChange: () => beginBackgroundLayoutChange(context),
      onLayoutChange: () => animateBackgroundLayoutChange(context),
      onSpacingChange: (spacing) => changeBackgroundSpacing(context, spacing),
      onSpacingPreview: (spacing) => {
        context.state.menu = { ...context.state.menu, spacing };
      },
      onTypeChange: (type) => changeBackgroundType(context, type),
      ownerDocument: context.ownerDocument,
      renderIcon: (element, icon) => setIcon(element, icon),
    }),
  );
}

function beginBackgroundLayoutChange(context: BackgroundRenderContext): void {
  if (!context.content.hasChildNodes() || prefersReducedMotion(context.ownerDocument)) return;
  const currentHeight = context.content.getBoundingClientRect().height;
  context.state.finishLayout?.();
  context.state.layoutStartHeight = currentHeight;
}

function animateBackgroundLayoutChange(context: BackgroundRenderContext): void {
  const startHeight = context.state.layoutStartHeight;
  delete context.state.layoutStartHeight;
  if (startHeight === undefined) return;
  const targetHeight = context.content.getBoundingClientRect().height;
  if (Math.abs(targetHeight - startHeight) < 0.5) return;

  const content = context.content;
  const win = context.ownerDocument.defaultView;
  if (win === null) return;
  content.dataset.resizing = "true";
  content.style.blockSize = `${String(startHeight)}px`;
  void content.offsetHeight;

  let frame: number | undefined;
  let timeout: number | undefined;
  const finish = (): void => {
    content.removeEventListener("transitionend", onTransitionEnd);
    content.removeEventListener("transitioncancel", finish);
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    if (timeout !== undefined) win.clearTimeout(timeout);
    frame = undefined;
    delete content.dataset.resizing;
    content.style.removeProperty("block-size");
    if (context.state.finishLayout === finish) delete context.state.finishLayout;
  };
  const onTransitionEnd = (event: TransitionEvent): void => {
    if (
      event.target === content &&
      (event.propertyName === "block-size" || event.propertyName === "height")
    )
      finish();
  };
  context.state.finishLayout = finish;
  content.addEventListener("transitionend", onTransitionEnd);
  content.addEventListener("transitioncancel", finish);
  frame = win.requestAnimationFrame(() => {
    frame = undefined;
    content.style.blockSize = `${String(targetHeight)}px`;
    timeout = win.setTimeout(finish, 300);
  });
}

function prefersReducedMotion(ownerDocument: Document): boolean {
  return ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
}

function changeBackgroundSpacing(
  context: BackgroundRenderContext,
  spacing: BackgroundSpacing,
): void {
  context.state.menu = { ...context.state.menu, spacing };
  if (context.state.menu.type === "none") return;
  clearBackgroundError(context.error);
  commitBackgroundValue(
    context,
    `pageDefaults.backgroundSpacing.${context.state.menu.type}`,
    spacingValue(spacing),
  );
}

function changeBackgroundType(context: BackgroundRenderContext, type: BackgroundType): void {
  context.state.menu = stateForType(context.values, type);
  clearBackgroundError(context.error);
  commitBackgroundValue(context, "pageDefaults.backgroundType", type);
}

function commitBackgroundValue(
  context: BackgroundRenderContext,
  key: SettingsControlKey,
  value: unknown,
): void {
  const commit = (context.state.latestCommits.get(key) ?? 0) + 1;
  context.state.latestCommits.set(key, commit);
  void context.values.set(key, value).catch(() => {
    if (commit === context.state.latestCommits.get(key)) recoverBackground(context);
  });
}

function recoverBackground(context: BackgroundRenderContext): void {
  context.state.menu = backgroundState(context.values);
  renderBackgroundMenu(context);
  context.error.textContent = "The background default could not be saved.";
  context.error.hidden = false;
}

function clearBackgroundError(error: HTMLElement): void {
  error.textContent = "";
  error.hidden = true;
}

function bufferDefinition(values: PageDefaultsValues): SettingDefinitionRender {
  return {
    name: "Page buffer",
    desc: BUFFER_DESCRIPTION,
    render: (setting) => {
      setting.settingEl.replaceChildren();
      setting.settingEl.classList.add("inkbook-settings-visual-row");
      createSettingHeading(setting.settingEl, "Page buffer", BUFFER_DESCRIPTION);
      const content = setting.settingEl.createDiv({ cls: "inkbook-settings-inline-controls" });
      renderSettingsControlContent(content, {
        controls: () => [bufferControl(values)],
        descriptions: { "active-buffer-lines": BUFFER_DESCRIPTION },
        idPrefix: "inkbook-setting-page-buffer",
        onChange: (_controlId, value) => values.set("pageDefaults.activeBufferLines", value),
        ownerDocument: setting.settingEl.ownerDocument,
      });
    },
  };
}

function bufferControl(values: PageDefaultsValues): StyleControl {
  return {
    id: "active-buffer-lines",
    kind: "number",
    label: "Active buffer lines",
    min: 1,
    max: 8,
    step: 1,
    value: Number(values.get("pageDefaults.activeBufferLines")),
  };
}

function backgroundState(values: PageDefaultsValues): BackgroundMenuState {
  return stateForType(values, values.get("pageDefaults.backgroundType") as BackgroundType);
}

function stateForType(values: PageDefaultsValues, type: BackgroundType): BackgroundMenuState {
  if (type === "none") return { type, spacing: null };
  const value = Number(values.get(`pageDefaults.backgroundSpacing.${type}`));
  const index = LINE_SPACINGS.indexOf(value as (typeof LINE_SPACINGS)[number]);
  return { type, spacing: SPACINGS[index < 0 ? 0 : index] ?? "s" };
}

function spacingValue(spacing: BackgroundSpacing): (typeof LINE_SPACINGS)[number] {
  return LINE_SPACINGS[SPACINGS.indexOf(spacing)] ?? LINE_SPACINGS[0];
}

function createSettingHeading(
  container: HTMLElement,
  name: string,
  description: string,
): HTMLElement {
  const info = container.createDiv({ cls: "inkbook-settings-visual-info" });
  info.createDiv({ cls: "setting-item-name", text: name });
  const descriptionElement = info.createDiv({ cls: "setting-item-description", text: description });
  descriptionElement.id = `inkbook-setting-${name.toLowerCase().replaceAll(" ", "-")}-description`;
  return descriptionElement;
}
