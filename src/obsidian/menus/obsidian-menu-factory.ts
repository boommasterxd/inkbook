import { Menu, type MenuItem } from "obsidian";

import type { MenuFactoryPort, MenuItemPort, MenuPort, MenuPosition } from "./menu-ports";

/**
 * Adapts Obsidian's public Menu API to the narrow menu ports used by Inkbook.
 * The adapter is the only menu module that imports the host API.
 */
class ObsidianMenuItemPort implements MenuItemPort {
  readonly #item: MenuItem;

  public constructor(item: MenuItem) {
    this.#item = item;
  }

  public setTitle(title: string): this {
    this.#item.setTitle(title);
    return this;
  }

  public setIcon(icon: string): this {
    this.#item.setIcon(icon);
    return this;
  }

  public setDisabled(disabled: boolean): this {
    this.#item.setDisabled(disabled);
    return this;
  }

  public setWarning(isWarning: boolean): this {
    this.#item.setWarning(isWarning);
    return this;
  }

  public setIsLabel(isLabel: boolean): this {
    this.#item.setIsLabel(isLabel);
    return this;
  }

  public onClick(callback: (event: unknown) => void): this {
    this.#item.onClick((event) => callback(event));
    return this;
  }
}

class ObsidianMenuPort implements MenuPort {
  readonly #menu: Menu;

  public constructor(menu: Menu) {
    this.#menu = menu;
  }

  public addItem(configure: (item: MenuItemPort) => void): this {
    this.#menu.addItem((item) => {
      configure(new ObsidianMenuItemPort(item));
    });
    return this;
  }

  public addSeparator(): this {
    this.#menu.addSeparator();
    return this;
  }

  public showAtPosition(position: MenuPosition, ownerDocument: Document): this {
    this.#menu.showAtPosition(position, ownerDocument);
    return this;
  }

  public onHide(callback: () => void): void {
    this.#menu.onHide(callback);
  }

  public close(): void {
    this.#menu.close();
  }
}

class ObsidianMenuFactory implements MenuFactoryPort {
  public create(): MenuPort {
    return new ObsidianMenuPort(new Menu());
  }

  public forEvent(event: MouseEvent | PointerEvent): MenuPort {
    return new ObsidianMenuPort(Menu.forEvent(event));
  }
}

export const obsidianMenuFactory = new ObsidianMenuFactory();
