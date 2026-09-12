import { setIcon } from "obsidian";

import type { MenuItemPort } from "./menu-ports";

export class OwnedMenuItem implements MenuItemPort {
  public title: string | DocumentFragment = "";
  public icon = "";
  public checked: boolean | null = null;
  public disabled = false;
  public warning = false;
  public label = false;
  public callback: ((event: unknown) => void) | undefined;

  public setTitle(title: string): this {
    this.title = title;
    return this;
  }
  public setTitleFragment(title: DocumentFragment): this {
    this.title = title;
    return this;
  }
  public setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }
  public setChecked(checked: boolean | null): this {
    this.checked = checked;
    return this;
  }
  public setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  public setWarning(warning: boolean): this {
    this.warning = warning;
    return this;
  }
  public setIsLabel(label: boolean): this {
    this.label = label;
    return this;
  }
  public onClick(callback: (event: unknown) => void): this {
    this.callback = callback;
    return this;
  }
}

export function renderOwnedMenuItems(
  container: HTMLElement,
  items: readonly (OwnedMenuItem | null)[],
  activate: (item: OwnedMenuItem, event: Event) => void,
): HTMLElement[] {
  const buttons: HTMLElement[] = [];
  for (const item of items) {
    if (item === null) {
      if (!container.lastElementChild?.classList.contains("inkbook-owned-menu-item")) continue;
      container
        .createDiv({ cls: "inkbook-owned-menu-separator" })
        .setAttribute("role", "separator");
      continue;
    }
    const row = container.createDiv({ cls: "inkbook-owned-menu-item" });
    row.dataset.disabled = String(item.disabled);
    row.dataset.warning = String(item.warning);
    row.dataset.label = String(item.label);
    row.setAttribute(
      "role",
      item.label ? "presentation" : item.checked === null ? "menuitem" : "menuitemcheckbox",
    );
    if (item.checked !== null) row.setAttribute("aria-checked", String(item.checked));
    if (item.disabled) row.setAttribute("aria-disabled", "true");
    if (item.icon !== "") setIcon(row.createDiv({ cls: "inkbook-owned-menu-icon" }), item.icon);
    const title = row.createDiv({ cls: "inkbook-owned-menu-title" });
    if (typeof item.title === "string") title.textContent = item.title;
    else title.append(item.title.cloneNode(true));
    if (item.checked === true) setIcon(row.createDiv({ cls: "inkbook-owned-menu-check" }), "check");
    if (item.disabled || item.label) continue;
    row.tabIndex = -1;
    row.addEventListener("click", (event) => activate(item, event));
    row.addEventListener("pointermove", (event) => {
      if (event.pointerType === "mouse") row.focus({ preventScroll: true });
    });
    buttons.push(row);
  }
  if (container.lastElementChild?.getAttribute("role") === "separator")
    container.lastElementChild.remove();
  return buttons;
}

export function navigateOwnedMenu(
  event: KeyboardEvent,
  buttons: readonly HTMLElement[],
  activate: (button: HTMLElement) => void,
): boolean {
  const index = buttons.findIndex((button) => button === button.ownerDocument.activeElement);
  let next: number;
  switch (event.key) {
    case "ArrowDown":
      next = (index + 1) % buttons.length;
      break;
    case "ArrowUp":
      next = (index <= 0 ? buttons.length : index) - 1;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = buttons.length - 1;
      break;
    case "Enter":
    case " ":
      if (index >= 0) activate(buttons[index]!);
      return true;
    default:
      return false;
  }
  buttons[next]?.focus({ preventScroll: true });
  buttons[next]?.scrollIntoView({ block: "nearest" });
  return true;
}
