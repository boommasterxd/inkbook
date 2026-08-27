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
