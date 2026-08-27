import { menuDomWindow } from "./menu-dom";

export interface MenuTitleContentOptions {
  readonly caution?: boolean;
  readonly minWidth?: number;
}

export function createMenuTitleContent(
  ownerDocument: Document,
  title: string,
  options: MenuTitleContentOptions = {},
): DocumentFragment {
  const win = menuDomWindow(ownerDocument, "menu title");
  const fragment = win.createFragment();
  const text = win.createSpan({ cls: "inkbook-menu-title-content", text: title });
  if (options.caution === true) text.classList.add("inkbook-menu-title-content-caution");
  if (options.minWidth !== undefined) {
    text.style.setProperty("--inkbook-menu-title-min-width", `${String(options.minWidth)}px`);
  }
  fragment.append(text);
  return fragment;
}
