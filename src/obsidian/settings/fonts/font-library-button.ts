import type { ButtonComponent } from "obsidian";

/** Keeps library actions icon-only while retaining native tooltips and keyboard semantics. */
export function configureFontLibraryButton(
  button: ButtonComponent,
  icon: string,
  label: string,
  action: () => void,
): HTMLButtonElement {
  button.setIcon(icon).setTooltip(label).onClick(action);
  const element = button.buttonEl;
  element.type = "button";
  element.classList.add("clickable-icon", "inkbook-font-library-icon-button");
  element.setAttribute("aria-label", label);
  element.querySelector("svg")?.setAttribute("aria-hidden", "true");
  return element;
}
