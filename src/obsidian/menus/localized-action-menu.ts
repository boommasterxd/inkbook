import {
  createEnglishLocalization,
  type Localization,
  type MessageKey,
} from "../../domain/localization";
import { setMenuItemTitle } from "./menu-dom";
import type { MenuItemPort, MenuPort } from "./menu-ports";

/** Owns semantic action captions without changing the underlying item's capabilities. */
export class LocalizedActionMenu {
  readonly #updates: (() => void)[] = [];
  readonly #localization: Localization;
  public readonly getPhoneNavigation: MenuPort["getPhoneNavigation"];

  public constructor(
    private readonly menu: MenuPort,
    private readonly ownerDocument: Document,
    localization?: Localization,
  ) {
    this.#localization = localization ?? createEnglishLocalization();
    this.getPhoneNavigation =
      menu.getPhoneNavigation === undefined ? undefined : () => menu.getPhoneNavigation?.();
    const unsubscribe = localization?.subscribe(() => {
      for (const update of this.#updates) update();
    });
    if (unsubscribe !== undefined)
      menu.onHide(() => {
        unsubscribe();
        this.#updates.length = 0;
      });
  }

  public addItem(key: MessageKey, configure: (item: MenuItemPort) => void, caution = false): void {
    this.menu.addItem((item) => {
      const update = () =>
        setMenuItemTitle(item, this.ownerDocument, this.#localization.t(key), caution);
      this.#updates.push(update);
      update();
      configure(item);
    });
  }

  public addSeparator(): void {
    this.menu.addSeparator();
  }
}
