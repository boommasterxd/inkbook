import type { createOwnedMenuFactory } from "../../../src/obsidian/menus/owned-menu-factory";

/** Complete twelve-action menu operation shared by absolute and relative measurements. */
export function renderAndDisposeActionMenu(
  factory: ReturnType<typeof createOwnedMenuFactory>,
  onHide: () => void,
): void {
  const menu = factory.create("context");
  for (let index = 0; index < 12; index += 1) {
    if (index > 0 && index % 3 === 0) menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle(`Action ${String(index)}`)
        .setIcon("copy")
        .setDisabled(index === 3);
      item.setChecked?.(index === 0);
    });
  }
  menu.onHide(onHide);
  menu.showAtPosition({ x: 50, y: 50 }, document);
  menu.close("immediate");
}
