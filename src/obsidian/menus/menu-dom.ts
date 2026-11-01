import { setTooltip } from "obsidian";

import type { MenuItemPort } from "./menu-ports";

let nextSurfaceLabel = 0;

export interface MenuDomWindow extends Window {
  createDiv(options?: { readonly cls?: string; readonly text?: string }): HTMLDivElement;
  createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: { readonly cls?: string; readonly text?: string },
  ): HTMLElementTagNameMap[K];
  createFragment(): DocumentFragment;
  createSpan(options?: { readonly cls?: string; readonly text?: string }): HTMLSpanElement;
}

export function menuDomWindow(ownerDocument: Document, menuName: string): MenuDomWindow {
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error(`The ${menuName} requires an owning window.`);
  return ownerWindow;
}

export function configureMenuTooltips(container: HTMLElement | DocumentFragment): void {
  const elements = [...container.querySelectorAll<HTMLElement>("[aria-label]")];
  if ("getAttribute" in container) elements.unshift(container);
  for (const element of elements) {
    const label = element.getAttribute("aria-label");
    if (label) setTooltip(element, label, { delay: 700 });
  }
}

export function setMenuSurfaceLabel(surface: HTMLElement, text: string): void {
  let label = surface.querySelector<HTMLElement>(":scope > .inkbook-menu-surface-label");
  if (label === null) {
    label = surface.createSpan({ cls: "inkbook-menu-surface-label" });
    label.id = `inkbook-menu-surface-label-${++nextSurfaceLabel}`;
    label.hidden = true;
  }
  label.textContent = text;
  surface.removeAttribute("aria-label");
  surface.setAttribute("aria-labelledby", label.id);
}

export function setMenuItemTitle(
  item: MenuItemPort,
  ownerDocument: Document,
  title: string,
  caution = false,
): void {
  if (!caution || item.setTitleFragment === undefined) {
    item.setTitle(title);
    return;
  }
  const ownerWindow = menuDomWindow(ownerDocument, "menu title");
  const fragment = ownerWindow.createFragment();
  const content = ownerWindow.createSpan();
  content.className = "inkbook-menu-title-content";
  content.dataset.tone = "caution";
  content.textContent = title;
  fragment.append(content);
  item.setTitleFragment(fragment);
}
