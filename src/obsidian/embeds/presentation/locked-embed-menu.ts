import { Component } from "obsidian";
import { Localization, type MessageKey } from "../../../domain/localization";

import type { MenuFactoryPort, MenuItemPort, MenuPort, MenuPosition } from "../../menus/menu-ports";
import { isTouchCompatibilityEvent } from "../active-editor/input/controller-touch";
import { LockedEmbedTouch } from "./locked-embed-touch";

export interface LockedEmbedMenuOptions {
  readonly localization?: Localization | undefined;
  readonly root: HTMLElement;
  readonly preview: HTMLElement;
  readonly factory: MenuFactoryPort;
  readonly onEdit: () => void;
  readonly onOpenSvg: () => void;
  readonly onDeleteEmbed: () => void;
}

/** A presentation-owned menu that never activates an editor merely to show actions. */
export class LockedEmbedMenu extends Component {
  readonly #options: LockedEmbedMenuOptions;
  readonly #touch: LockedEmbedTouch;
  #menu: MenuPort | undefined;
  #dismissal: Component | undefined;
  #restoreFocus = false;
  #keyboardInvocation = false;
  #disposed = false;
  readonly #localization: Localization;
  readonly #labels = new Map<MenuItemPort, MessageKey>();

  public constructor(options: LockedEmbedMenuOptions) {
    super();
    this.#options = options;
    this.#localization = options.localization ?? new Localization();
    this.register(
      this.#localization.subscribe(() => {
        for (const [item, key] of this.#labels) item.setTitle(this.#localization.t(key));
      }),
    );
    this.#touch = this.addChild(
      new LockedEmbedTouch({
        preview: options.preview,
        available: () => this.#available(),
        open: (position) => this.#open(position, false),
      }),
    );
    this.registerDomEvent(options.preview, "contextmenu", (event) => this.#contextMenu(event));
    this.registerDomEvent(options.preview, "keydown", (event) => this.#keyDown(event));
    const ownerWindow = options.root.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The locked embed has no owning window.");
    const observer = new ownerWindow.MutationObserver(() => {
      if (!this.#available()) this.close();
    });
    observer.observe(options.root, { attributeFilter: ["data-inkbook-state"], attributes: true });
    this.register(() => observer.disconnect());
    this.load();
  }

  public close(): void {
    this.#restoreFocus = false;
    this.#keyboardInvocation = false;
    this.#touch.cancel();
    this.#releaseDismissal();
    this.#menu?.close("immediate");
    this.#menu = undefined;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.close();
    this.unload();
  }

  #available(): boolean {
    const { root, preview } = this.#options;
    return (
      !this.#disposed &&
      root.dataset.inkbookState === "locked" &&
      preview.isConnected &&
      !preview.hidden
    );
  }

  #contextMenu(event: MouseEvent): void {
    if (!this.#available()) return;
    event.preventDefault();
    event.stopPropagation();
    if (
      ("pointerType" in event && event.pointerType === "touch") ||
      isTouchCompatibilityEvent(event) ||
      (this.#keyboardInvocation && event.button !== 2)
    )
      return;
    this.#open({ x: event.clientX, y: event.clientY }, true);
  }

  #keyDown(event: KeyboardEvent): void {
    if (!this.#available()) return;
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = this.#options.preview.getBoundingClientRect();
    this.#open({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, true);
    this.#keyboardInvocation = true;
  }

  #open(position: MenuPosition, restoreFocus: boolean): void {
    if (!this.#available()) return;
    this.close();
    this.#restoreFocus = restoreFocus;
    const menu = this.#options.factory.create("context");
    this.#menu = menu;
    this.#addAction(menu, "presentation.menu.edit", "pencil", this.#options.onEdit);
    this.#addAction(menu, "presentation.menu.openSvg", "file-image", this.#options.onOpenSvg);
    menu.addSeparator();
    this.#addAction(menu, "presentation.menu.delete", "trash-2", this.#options.onDeleteEmbed, true);
    menu.onHide(() => {
      if (this.#menu !== menu) return;
      this.#menu = undefined;
      this.#releaseDismissal();
      this.#keyboardInvocation = false;
      if (this.#restoreFocus && this.#available())
        this.#options.preview.focus({ preventScroll: true });
      this.#restoreFocus = false;
    });
    this.#watchDismissal(menu);
    menu.showAtPosition(position, this.#options.preview.ownerDocument);
  }

  #watchDismissal(menu: MenuPort): void {
    const owner = new Component();
    const preview = this.#options.preview;
    owner.registerDomEvent(
      preview.ownerDocument,
      "pointerdown",
      (event) => {
        // A disappearing phone backdrop can retarget the click onto the preview.
        if (this.#menu === menu && event.pointerType === "touch") this.#touch.consumeClick();
      },
      true,
    );
    this.#dismissal = owner;
    owner.load();
  }

  #releaseDismissal(): void {
    this.#labels.clear();
    this.#dismissal?.unload();
    this.#dismissal = undefined;
  }

  #addAction(
    menu: MenuPort,
    title: MessageKey,
    icon: string,
    callback: () => void,
    warning = false,
  ) {
    menu.addItem((item) => {
      this.#labels.set(item, title);
      item.setTitle(this.#localization.t(title)).setIcon(icon);
      if (warning) item.setWarning(true);
      item.onClick(() => {
        if (!this.#available() || this.#menu !== menu) return;
        this.#restoreFocus = false;
        menu.close("handoff");
        this.#options.preview.focus({ preventScroll: true });
        callback();
      });
    });
  }
}
