import type { BackgroundMenuState, BackgroundSpacing, BackgroundType } from "./editor-menu-types";
import { BACKGROUND_SQUARES_ICON_ID } from "../../rendering/ui/icon-ids";
import { createBackgroundSpacingContent } from "./background-spacing-content";
import { menuDomWindow } from "./menu-dom";

const BACKGROUND_CHOICES: readonly (readonly [BackgroundType, string, string])[] = [
  ["none", "None", "ban"],
  ["lines", "Lines", "align-justify"],
  ["dots", "Dots", "grip"],
  ["squares", "Squares", BACKGROUND_SQUARES_ICON_ID],
];

export interface BackgroundMenuContentOptions {
  readonly getState: () => BackgroundMenuState;
  readonly initialState: BackgroundMenuState;
  readonly onBeforeLayoutChange?: () => void;
  readonly onLayoutChange?: () => void;
  readonly onSpacingChange: (spacing: BackgroundSpacing) => void;
  readonly onSpacingPreview: (spacing: BackgroundSpacing) => void;
  readonly onTypeChange: (type: BackgroundType) => void;
  readonly ownerDocument: Document;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

export function backgroundIconId(type: BackgroundType): string {
  return BACKGROUND_CHOICES.find(([candidate]) => candidate === type)?.[2] ?? "ban";
}

export function createBackgroundMenuContent(
  options: BackgroundMenuContentOptions,
): DocumentFragment {
  const win = menuDomWindow(options.ownerDocument, "background menu");
  const fragment = win.createFragment();
  const root = win.createDiv({ cls: "inkbook-menu-background-options" });
  const choices = win.createDiv({ cls: "inkbook-menu-background-choices" });
  const spacing = win.createDiv({ cls: "inkbook-menu-background-spacing" });

  for (const [type, label, iconId] of BACKGROUND_CHOICES) {
    const button = win.createEl("button", { cls: "inkbook-menu-background-choice" });
    button.type = "button";
    button.dataset.backgroundType = type;
    button.setAttribute("aria-label", label);
    const icon = win.createSpan({ cls: "inkbook-menu-background-choice-icon" });
    options.renderIcon(icon, iconId);
    const title = win.createSpan({ cls: "inkbook-menu-background-choice-title", text: label });
    const check = win.createSpan({ cls: "inkbook-menu-background-choice-check" });
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
    options.onBeforeLayoutChange?.();
    for (const button of choices.querySelectorAll<HTMLButtonElement>(
      ".inkbook-menu-background-choice",
    )) {
      const selected = button.dataset.backgroundType === state.type;
      button.setAttribute("aria-pressed", String(selected));
      const check = button.querySelector<HTMLElement>(".inkbook-menu-background-choice-check");
      if (check !== null) check.hidden = !selected;
    }
    spacing.replaceChildren();
    if (state.type === "none") {
      options.onLayoutChange?.();
      return;
    }
    const separator = win.createDiv({ cls: "inkbook-menu-background-separator" });
    separator.setAttribute("role", "separator");
    spacing.append(
      separator,
      createBackgroundSpacingContent({
        onChange: options.onSpacingChange,
        onPreview: options.onSpacingPreview,
        ownerDocument: options.ownerDocument,
        renderIcon: options.renderIcon,
        spacing: state.spacing ?? "m",
      }),
    );
    options.onLayoutChange?.();
  };

  update(options.initialState);
  root.append(choices, spacing);
  fragment.append(root);
  return fragment;
}
