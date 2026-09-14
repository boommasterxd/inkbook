import type { PhoneSheetNavigation } from "./panel-page";
import { Component, Platform, setIcon, type Keymap } from "obsidian";
import { installMenuEscapeScope } from "./menu-escape-scope";

import { effectiveTransitionDuration } from "../runtime/effective-motion";
import { AdaptivePanelSession, type AdaptivePanelCloseMode } from "./adaptive-panel";
import type { MenuFactoryPort, MenuItemPort, MenuPort, MenuPosition } from "./menu-ports";
import type { PhoneSheetHostPort } from "./phone-sheet-host";
import { prepareWideMenuExit } from "./wide-menu-motion";
import { menuDomWindow } from "./menu-dom";
import { readMenuViewport } from "./menu-viewport";
import { navigateOwnedMenu, OwnedMenuItem, renderOwnedMenuItems } from "./owned-menu-item";

export interface OwnedMenuFactoryOptions {
  readonly anchor: HTMLElement;
  readonly createPhoneSheetHost?: () => PhoneSheetHostPort;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
}

class OwnedMenu extends Component implements MenuPort {
  readonly #items: (OwnedMenuItem | null)[] = [];
  readonly #callbacks: (() => void)[] = [];
  readonly #options: OwnedMenuFactoryOptions;
  readonly #kind: "context" | "menu";
  #anchor: HTMLElement;
  #closed = false;
  #closing = false;
  #shown = false;
  #panel: AdaptivePanelSession | undefined;
  #surface: HTMLElement | undefined;
  #buttons: HTMLElement[] = [];
  #popupDuration = 0;
  #ownerWindow: Window | undefined;

  public constructor(options: OwnedMenuFactoryOptions, kind: "context" | "menu") {
    super();
    this.#options = options;
    this.#anchor = options.anchor;
    this.#kind = kind;
  }

  public addItem(configure: (item: MenuItemPort) => void): this {
    const item = new OwnedMenuItem();
    configure(item);
    this.#items.push(item);
    return this;
  }

  public addSeparator(): this {
    this.#items.push(null);
    return this;
  }
  public setParentElement(element: HTMLElement): this {
    this.#anchor = element;
    return this;
  }
  public getPhoneNavigation(): PhoneSheetNavigation | undefined {
    return this.#panel?.navigation;
  }

  public onHide(callback: () => void): void {
    this.#callbacks.push(callback);
  }

  public showAtPosition(position: MenuPosition, ownerDocument: Document): this {
    if (this.#closed || this.#shown) return this;
    if (this.#items.every((item) => item === null)) {
      this.#finish();
      return this;
    }
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) return this;
    this.#shown = true;
    this.load();
    this.registerDomEvent(ownerWindow, "pagehide", () => this.close("immediate"));
    if (Platform.isPhone) this.#showPhone(ownerDocument, ownerWindow);
    else this.#showPopup(position, ownerDocument, ownerWindow);
    return this;
  }

  public close(mode: AdaptivePanelCloseMode = "animated"): void {
    const wasClosing = this.#closing;
    this.#closing = true;
    if (this.#panel !== undefined) {
      this.#panel.close(mode);
      return;
    }
    if (
      mode !== "animated" ||
      this.#popupDuration === 0 ||
      this.#surface === undefined ||
      this.#ownerWindow === undefined
    ) {
      this.#finish();
      return;
    }
    if (wasClosing || this.#closed) return;
    prepareWideMenuExit(this.#surface, this.#ownerWindow);
    this.#surface.inert = true;
    this.#surface.setAttribute("aria-hidden", "true");
    this.#surface.dataset.state = "closing";
    const ownerWindow = this.#ownerWindow;
    const timer = ownerWindow.setTimeout(() => this.#finish(), this.#popupDuration);
    this.register(() => ownerWindow.clearTimeout(timer));
  }

  public schedule(event: MouseEvent | PointerEvent): void {
    this.load();
    event.preventDefault();
    const ownerDocument =
      event.target !== null && "ownerDocument" in event.target
        ? ((event.target as Node).ownerDocument ?? this.#anchor.ownerDocument)
        : this.#anchor.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const timer = ownerWindow.setTimeout(() => {
      this.showAtPosition({ x: event.clientX, y: event.clientY }, ownerDocument);
    }, 0);
    this.register(() => ownerWindow.clearTimeout(timer));
  }

  #createContent(ownerDocument: Document): HTMLElement {
    const content = menuDomWindow(ownerDocument, "owned menu").createDiv();
    content.className = "inkbook-owned-menu-content";
    content.setAttribute("role", "menu");
    content.setAttribute("aria-label", this.#kind === "context" ? "Context menu" : "Menu");
    this.#buttons = renderOwnedMenuItems(content, this.#items, (item, event) => {
      if (this.#closing || this.#closed || !content.isConnected) return;
      this.#closing = !item.keepOpen;
      try {
        item.callback?.(event);
      } finally {
        if (!item.keepOpen) this.close("handoff");
      }
    });
    this.registerDomEvent(
      ownerDocument,
      "keydown",
      (event) => {
        if (event.defaultPrevented || this.#closing || this.#closed || !content.isConnected) return;
        if (event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          this.close();
          return;
        }
        if (!navigateOwnedMenu(event, this.#buttons, (button) => button.click())) return;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
    return content;
  }

  #showPhone(ownerDocument: Document, ownerWindow: Window): void {
    const content = this.#createContent(ownerDocument);
    const fragment = menuDomWindow(ownerDocument, "owned menu").createFragment();
    fragment.append(content);
    this.#panel = new AdaptivePanelSession({
      anchor: this.#anchor,
      canvasInputSurface: this.#anchor,
      createContent: () => fragment,
      ...(this.#options.createPhoneSheetHost === undefined
        ? {}
        : { createPhoneSheetHost: this.#options.createPhoneSheetHost }),
      ...(this.#options.keymap === undefined ? {} : { keymap: this.#options.keymap }),
      kind: "menu",
      restoreFocus: this.#kind !== "context",
      label: this.#kind === "context" ? "Context menu" : "Menu",
      onClosing: () => {
        this.#closing = true;
      },
      onClosed: () => this.#finish(),
      ownerDocument,
      ownerWindow,
      renderIcon: setIcon,
      ...(this.#kind === "context"
        ? {
            entryDurationMs: effectiveTransitionDuration(
              this.#anchor,
              ownerWindow,
              "nativeModalEnterExit",
            ),
          }
        : {}),
    });
  }

  #showPopup(position: MenuPosition, ownerDocument: Document, ownerWindow: Window): void {
    const surface = menuDomWindow(ownerDocument, "owned menu").createDiv();
    this.#surface = surface;
    surface.className = "inkbook-owned-menu";
    surface.dataset.mobile = String(Platform.isMobile);
    surface.tabIndex = -1;
    surface.append(this.#createContent(ownerDocument));
    this.#ownerWindow = ownerWindow;
    const duration = effectiveTransitionDuration(this.#anchor, ownerWindow, "nativeModalEnterExit");
    this.#popupDuration = duration;
    surface.style.setProperty("--inkbook-owned-menu-duration", `${String(duration)}ms`);
    ownerDocument.body.append(surface);
    this.register(() => surface.remove());
    const viewport = readMenuViewport(ownerWindow);
    surface.style.setProperty("max-block-size", `${String(Math.max(0, viewport.height - 10))}px`);
    const width = surface.offsetWidth;
    const height = surface.offsetHeight;
    const right =
      position.width === undefined
        ? position.x + 2
        : position.x + (position.overlap === true ? 0 : position.width);
    const left =
      position.width === undefined
        ? position.x - 2
        : position.x + (position.overlap === true ? position.width : 0);
    const x =
      right + width <= viewport.left + viewport.width &&
      !(position.left === true && left - width >= viewport.left)
        ? right
        : Math.max(viewport.left, left - width);
    const y =
      (position.y + height > viewport.top + viewport.height
        ? Math.max(viewport.top, position.y - height)
        : position.y) + 2;
    const centeredX = Math.max(
      viewport.left,
      Math.min(
        position.x + ((position.width ?? 0) - width) / 2,
        viewport.left + viewport.width - width,
      ),
    );
    surface.style.setProperty(
      "inset-inline-start",
      `${String(position.centered === true ? centeredX : x)}px`,
    );
    surface.style.setProperty("inset-block-start", `${String(y)}px`);
    const content = surface.firstElementChild as HTMLElement;
    content.tabIndex = -1;
    content.focus({ preventScroll: true });
    this.register(installMenuEscapeScope(this.#options.keymap, () => this.close()));
    this.registerDomEvent(
      ownerDocument,
      "pointerdown",
      (event) => {
        if (
          event.target !== null &&
          "nodeType" in event.target &&
          !surface.contains(event.target as Node) &&
          !(this.#kind === "menu" && this.#anchor.contains(event.target as Node))
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.close();
        }
      },
      true,
    );
    this.registerDomEvent(
      ownerDocument,
      "keydown",
      (event) => {
        if (event.key !== "Escape" && event.key !== "Tab") return;
        event.preventDefault();
        event.stopPropagation();
        this.close();
      },
      true,
    );
    this.registerDomEvent(ownerWindow, "resize", () => this.close());
    this.registerDomEvent(ownerWindow, "blur", () => this.close());
    this.registerDomEvent(
      ownerDocument,
      "scroll",
      (event) => {
        if (
          event.target !== null &&
          "nodeType" in event.target &&
          surface.contains(event.target as Node)
        )
          return;
        this.close();
      },
      true,
    );
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;
    this.unload();
    this.#surface?.remove();
    for (const callback of this.#callbacks) callback();
  }
}

export function createOwnedMenuFactory(options: OwnedMenuFactoryOptions): MenuFactoryPort {
  const events = new WeakMap<Event, OwnedMenu>();
  return {
    create: (kind = "menu") => new OwnedMenu(options, kind),
    forEvent: (event) => {
      const existing = events.get(event);
      if (existing !== undefined) return existing;
      const menu = new OwnedMenu(options, "context");
      events.set(event, menu);
      menu.schedule(event);
      return menu;
    },
  };
}
