import type { Localization } from "../../domain/localization";
import { LocalizedActionMenu } from "./localized-action-menu";
import type { ContextMenuSession } from "./context-menu";
import type { MenuFactoryPort, MenuPosition } from "./menu-ports";

interface ImageContrastMenuOptions {
  readonly contrast: "auto" | "light" | "dark";
  readonly factory: MenuFactoryPort;
  readonly localization?: Localization | undefined;
  readonly onChange: (contrast: "auto" | "light" | "dark") => void;
  readonly onClosed: () => void;
  readonly ownerDocument: Document;
  readonly position: MenuPosition;
}

/** Reuses the same adaptive checked-menu rows as Shape and Background. */
export function openImageContrastMenu(options: ImageContrastMenuOptions): ContextMenuSession {
  const menu = options.factory.create("menu");
  const actions = new LocalizedActionMenu(menu, options.ownerDocument, options.localization);
  menu.onHide(options.onClosed);
  for (const [contrast, icon] of [
    ["auto", "sun-moon"],
    ["light", "sun"],
    ["dark", "moon"],
  ] as const) {
    actions.addItem(`editor.image.underlay-${contrast}`, (item) => {
      item.setIcon(icon);
      item.setChecked?.(options.contrast === contrast);
      item.onClick(() => options.onChange(contrast));
    });
  }
  menu.showAtPosition(options.position, options.ownerDocument);
  return { close: (mode = "animated") => menu.close(mode) };
}
