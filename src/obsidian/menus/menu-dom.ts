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
  const ownerWindow = menuDomWindow(ownerDocument, "native menu title");
  const fragment = ownerWindow.createFragment();
  const content = ownerWindow.createSpan();
  content.className = "inkbook-menu-title-content";
  content.dataset.tone = "caution";
  content.textContent = title;
  fragment.append(content);
  item.setTitleFragment(fragment);
}

interface SafeAreaFallbackState {
  count: number;
  readonly originalPriority: string;
  readonly originalValue: string;
}

const safeAreaFallbacks = new WeakMap<Document, SafeAreaFallbackState>();

export function acquireNativeMenuSafeAreaFallback(ownerDocument: Document): () => void {
  const existing = safeAreaFallbacks.get(ownerDocument);
  if (existing !== undefined) {
    existing.count += 1;
    return releaseSafeAreaFallback(ownerDocument, existing);
  }
  const ownerWindow = menuDomWindow(ownerDocument, "native menu spacing");
  const styles = ownerWindow.getComputedStyle(ownerDocument.body);
  const safeArea = cssPixels(styles.getPropertyValue("--safe-area-inset-bottom"));
  const minimum = cssPixels(styles.getPropertyValue("--size-4-4")) || 16;
  if (safeArea >= minimum) return () => undefined;
  const bodyStyle = ownerDocument.body.style;
  const state: SafeAreaFallbackState = {
    count: 1,
    originalPriority: bodyStyle.getPropertyPriority("--safe-area-inset-bottom"),
    originalValue: bodyStyle.getPropertyValue("--safe-area-inset-bottom"),
  };
  safeAreaFallbacks.set(ownerDocument, state);
  bodyStyle.setProperty("--safe-area-inset-bottom", `${String(minimum)}px`);
  return releaseSafeAreaFallback(ownerDocument, state);
}

function releaseSafeAreaFallback(
  ownerDocument: Document,
  state: SafeAreaFallbackState,
): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.count -= 1;
    if (state.count > 0) return;
    safeAreaFallbacks.delete(ownerDocument);
    const bodyStyle = ownerDocument.body.style;
    if (state.originalValue === "") bodyStyle.removeProperty("--safe-area-inset-bottom");
    else {
      bodyStyle.setProperty(
        "--safe-area-inset-bottom",
        state.originalValue,
        state.originalPriority,
      );
    }
  };
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
