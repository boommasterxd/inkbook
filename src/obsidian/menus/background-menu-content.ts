import {
  menuTranslator,
  updateMenuText,
  type MenuLocalizationOptions,
} from "./localized-menu-text";
import type { BackgroundMenuState, BackgroundSpacing, BackgroundType } from "./editor-menu-types";
import { BACKGROUND_SQUARES_ICON_ID } from "../../rendering/ui/icon-ids";
import { createBackgroundSpacingContent } from "./background-spacing-content";
import { menuDomWindow } from "./menu-dom";

const BACKGROUND_CHOICES: readonly (readonly [BackgroundType, string])[] = [
  ["none", "ban"],
  ["lines", "align-justify"],
  ["dots", "grip"],
  ["squares", BACKGROUND_SQUARES_ICON_ID],
];

export interface BackgroundMenuContentOptions extends MenuLocalizationOptions {
  readonly controlDescriptionId?: string;
  readonly getState: () => BackgroundMenuState;
  readonly initialState: BackgroundMenuState;
  readonly mutateLayout?: (update: () => void) => void;
  readonly onSpacingChange: (spacing: BackgroundSpacing) => void;
  readonly onSpacingPreview: (spacing: BackgroundSpacing) => void;
  readonly onTypeChange: (type: BackgroundType) => void;
  readonly ownerDocument: Document;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly registerUpdate?: (update: (state: BackgroundMenuState) => void) => void;
}

export function backgroundIconId(type: BackgroundType): string {
  return BACKGROUND_CHOICES.find(([candidate]) => candidate === type)?.[1] ?? "ban";
}

export function createBackgroundMenuContent(
  options: BackgroundMenuContentOptions,
): DocumentFragment {
  const win = menuDomWindow(options.ownerDocument, "background menu");
  const fragment = win.createFragment();
  const root = win.createDiv({ cls: "inkbook-menu-background-options" });
  const choices = win.createDiv({ cls: "inkbook-menu-background-choices" });
  const spacing = win.createDiv({ cls: "inkbook-menu-background-spacing" });
  const retainedSpacing = win.createFragment();
  let updateSpacing: ((value: BackgroundSpacing) => void) | undefined;

  for (const [type, iconId] of BACKGROUND_CHOICES) {
    const button = win.createEl("button", { cls: "inkbook-menu-background-choice" });
    button.type = "button";
    button.dataset.backgroundType = type;

    if (options.controlDescriptionId !== undefined) {
      button.setAttribute("aria-describedby", options.controlDescriptionId);
    }
    const icon = win.createSpan({ cls: "inkbook-menu-background-choice-icon" });
    options.renderIcon(icon, iconId);
    const title = win.createSpan({ cls: "inkbook-menu-background-choice-title", text: "" });
    updateMenuText(options, () => {
      const label = menuTranslator(options)(`editor.background.${type}`);
      title.textContent = label;
      button.setAttribute("aria-label", label);
    });
    const check = win.createSpan({ cls: "inkbook-menu-background-choice-check" });
    check.setAttribute("aria-hidden", "true");
    options.renderIcon(check, "check");
    button.append(icon, title, check);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.getAttribute("aria-pressed") === "true") return;
      options.onTypeChange(type);
      update(options.getState());
    });
    choices.append(button);
  }

  const update = (state: BackgroundMenuState): void => {
    const apply = (): void => {
      for (const button of choices.querySelectorAll<HTMLButtonElement>(
        ".inkbook-menu-background-choice",
      )) {
        const selected = button.dataset.backgroundType === state.type;
        button.setAttribute("aria-pressed", String(selected));
        const check = button.querySelector<HTMLElement>(".inkbook-menu-background-choice-check");
        if (check !== null && check.dataset.inkbookMotionCheck !== "true") check.hidden = !selected;
      }
      if (state.type === "none") {
        retainedSpacing.append(...spacing.childNodes);
        return;
      }
      if (updateSpacing !== undefined) {
        spacing.append(retainedSpacing);
        updateSpacing(state.spacing ?? "m");
        return;
      }
      const separator = win.createDiv({ cls: "inkbook-menu-background-separator" });
      separator.setAttribute("role", "separator");
      spacing.append(
        separator,
        createBackgroundSpacingContent({
          t: options.t,
          localization: options.localization,
          registerLocaleUpdate: options.registerLocaleUpdate,
          onChange: options.onSpacingChange,
          onPreview: options.onSpacingPreview,
          ownerDocument: options.ownerDocument,
          renderIcon: options.renderIcon,
          spacing: state.spacing ?? "m",
          registerUpdate: (update) => {
            updateSpacing = update;
          },
          ...(options.controlDescriptionId === undefined
            ? {}
            : { describedBy: options.controlDescriptionId }),
        }),
      );
    };
    if (options.mutateLayout !== undefined) options.mutateLayout(apply);
    else apply();
  };

  update(options.initialState);
  options.registerUpdate?.(update);
  root.append(choices, spacing);
  fragment.append(root);
  return fragment;
}
