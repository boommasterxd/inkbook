import type { MenuItemPort } from "./menu-ports";

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
