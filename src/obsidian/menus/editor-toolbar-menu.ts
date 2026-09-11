import type { PhoneSheetHostPort } from "./phone-sheet-host";
import { Platform, type Keymap } from "obsidian";

import type {
  BackgroundMenuState,
  EditorMenuCallbacks,
  OverflowMenuState,
  StyleControl,
} from "./editor-menu-types";
import type { ShapeId } from "../../rendering/ui/toolbar-types";
import {
  activeShapeIconId,
  type ActiveShapeIconState,
  CAUTION_ERASER_ICON_ID,
} from "../../rendering/ui/icon-ids";
import { AdaptivePanelSession, type AdaptivePanelContentLifecycle } from "./adaptive-panel";
import { backgroundIconId, createBackgroundMenuContent } from "./background-menu-content";
import { acquireNativeMenuSafeAreaFallback, setMenuItemTitle } from "./menu-dom";
import { createStyleMenuContent } from "./style-menu-content";
import type { FocusTargetPort, MenuFactoryPort, MenuPort } from "./menu-ports";

export type EditorToolbarMenuId = "overflow" | "background" | "shape" | "style";

export interface EditorToolbarMenuState {
  readonly background: BackgroundMenuState;
  readonly overflow: OverflowMenuState;
  readonly selectedShape: ShapeId;
  readonly shapeIcon: ActiveShapeIconState;
  readonly styleControls: readonly StyleControl[];
}

export type EditorToolbarMenuHandlers = EditorMenuCallbacks;

export interface EditorToolbarMenuOptions {
  readonly anchor: HTMLElement;
  readonly canvasInputSurface: FocusTargetPort;
  readonly factory: MenuFactoryPort;
  readonly getState: () => EditorToolbarMenuState;
  readonly handlers: EditorToolbarMenuHandlers;
  readonly initialMenu: Exclude<EditorToolbarMenuId, "background">;
  readonly createPhoneSheetHost?: () => PhoneSheetHostPort;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
  readonly onClosed: () => void;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

const SHAPES: readonly (readonly [ShapeId, string, "lines" | "shapes" | "structures"])[] = [
  ["line", "Line", "lines"],
  ["arrow", "Arrow", "lines"],
  ["rectangle", "Rectangle", "shapes"],
  ["ellipse", "Ellipse", "shapes"],
  ["triangle", "Triangle", "shapes"],
  ["octagon", "Octagon", "shapes"],
  ["parallelogram", "Parallelogram", "shapes"],
  ["diamond", "Diamond", "shapes"],
  ["coordinate-system", "Coordinate system", "structures"],
  ["table", "Table", "structures"],
];
const OVERFLOW_BASE_TITLES = [
  "Background",
  "Copy embed",
  "Settings",
  "Keyboard shortcuts",
  "Erase all",
  "Delete embed",
] as const;
const OVERFLOW_SELECTION_TITLES = [
  "Bring forward",
  "Send backward",
  "Bring to front",
  "Send to back",
] as const;

export class EditorToolbarMenuSession {
  #closed = false;
  #menu: MenuPort | undefined;
  #navigationGeneration = 0;
  readonly #options: EditorToolbarMenuOptions;
  #panel: AdaptivePanelSession | undefined;

  public constructor(options: EditorToolbarMenuOptions) {
    this.#options = options;
    this.#show(options.initialMenu);
  }

  public close(mode: "animated" | "immediate" = "animated"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#navigationGeneration += 1;
    const menu = this.#menu;
    const panel = this.#panel;
    this.#menu = undefined;
    menu?.close();
    panel?.close(mode);
    if (panel === undefined) this.#finish();
  }

  #finish(): void {
    const anchor = this.#options.anchor;
    if (anchor.isConnected && anchor.ownerDocument === this.#options.ownerDocument) {
      anchor.focus({ preventScroll: true });
    } else {
      this.#options.canvasInputSurface.focus({ preventScroll: true });
    }
    this.#options.onClosed();
  }

  #navigate(id: EditorToolbarMenuId): void {
    if (this.#closed) return;
    const previousMenu = this.#menu;
    const previousPanel = this.#panel;
    this.#menu = undefined;
    this.#panel = undefined;
    previousMenu?.close();
    previousPanel?.close("handoff");
    const generation = ++this.#navigationGeneration;
    this.#options.ownerWindow.queueMicrotask(() => {
      if (generation !== this.#navigationGeneration || this.#closed) return;
      this.#show(id);
    });
  }

  #show(id: EditorToolbarMenuId): void {
    if (this.#closed) return;
    if (id === "background" || id === "style") {
      this.#showPanel(id);
      return;
    }
    this.#showNativeMenu(id);
  }

  #showNativeMenu(id: "overflow" | "shape"): void {
    const releaseSafeArea = Platform.isPhone
      ? acquireNativeMenuSafeAreaFallback(this.#options.ownerDocument)
      : () => undefined;
    const menu = this.#options.factory.create();
    this.#menu = menu;
    menu.onHide(() => {
      releaseSafeArea();
      if (this.#menu !== menu) return;
      this.#menu = undefined;
      this.#closed = true;
      this.#finish();
    });
    populateNativeToolbarMenu(menu, id, this.#options, (next) => this.#navigate(next));
    menu.setParentElement?.(this.#options.anchor);
    const state = this.#options.getState();
    const titles = state.overflow.hasSelection
      ? [...OVERFLOW_BASE_TITLES, ...OVERFLOW_SELECTION_TITLES]
      : OVERFLOW_BASE_TITLES;
    menu.showAtPosition(
      menuPositionBelow(this.#options.anchor, id, titles),
      this.#options.ownerDocument,
    );
  }

  #showPanel(id: "background" | "style"): void {
    let panel: AdaptivePanelSession;
    panel = new AdaptivePanelSession({
      anchor: this.#options.anchor,
      canvasInputSurface: this.#options.canvasInputSurface,
      createContent: (lifecycle) => this.#createPanelContent(id, lifecycle),
      ...(this.#options.keymap === undefined ? {} : { keymap: this.#options.keymap }),
      ...(this.#options.createPhoneSheetHost === undefined
        ? {}
        : { createPhoneSheetHost: this.#options.createPhoneSheetHost }),
      kind: id,
      label: id === "style" ? "Style" : "Background",
      ...(id === "background" ? { onBack: () => this.#navigate("overflow") } : {}),
      onClosed: () => {
        if (this.#panel !== panel) return;
        this.#panel = undefined;
        this.#closed = true;
        this.#options.onClosed();
      },
      ownerDocument: this.#options.ownerDocument,
      ownerWindow: this.#options.ownerWindow,
      renderIcon: this.#options.renderIcon,
    });
    this.#panel = panel;
  }

  #createPanelContent(
    id: "background" | "style",
    lifecycle: AdaptivePanelContentLifecycle,
  ): DocumentFragment {
    const state = this.#options.getState();
    if (id === "style") {
      return createStyleMenuContent({
        controls: state.styleControls,
        onChange: this.#options.handlers.onStyleChange,
        ownerDocument: this.#options.ownerDocument,
        renderIcon: this.#options.renderIcon,
      });
    }
    return createBackgroundMenuContent({
      getState: () => this.#options.getState().background,
      initialState: state.background,
      onBeforeLayoutChange: () => lifecycle.prepareLayoutChange(),
      onLayoutChange: () => lifecycle.requestLayout(),
      onSpacingChange: this.#options.handlers.onBackgroundSpacingChange,
      onSpacingPreview: this.#options.handlers.onBackgroundSpacingPreview,
      onTypeChange: this.#options.handlers.onBackgroundTypeChange,
      ownerDocument: this.#options.ownerDocument,
      renderIcon: this.#options.renderIcon,
    });
  }
}

export function menuPositionBelow(
  anchor: HTMLElement,
  id: "overflow" | "shape",
  titles: readonly string[] = [],
) {
  const bounds = anchor.getBoundingClientRect();
  const y = bounds.bottom + (Platform.isMobile && !Platform.isPhone ? 0 : 2);
  if (id !== "overflow" || Platform.isPhone) {
    return { overlap: true, x: bounds.left, y };
  }
  const menuWidth = measureNativeMenuInlineSize(anchor.ownerDocument, titles) ?? bounds.width;
  return {
    overlap: true,
    width: bounds.width,
    x: bounds.left + (bounds.width - menuWidth) / 2,
    y,
  };
}

function measureNativeMenuInlineSize(
  ownerDocument: Document,
  titles: readonly string[],
): number | undefined {
  if (titles.length === 0) return undefined;
  const body = ownerDocument.body;
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) return undefined;
  const context = ownerWindow.createEl("canvas").getContext("2d");
  if (context === null) return undefined;
  const styles = ownerWindow.getComputedStyle(body);
  const fontSize = styles
    .getPropertyValue(Platform.isMobile ? "--font-ui-medium" : "--font-ui-small")
    .trim();
  context.font = `${styles.fontStyle} ${styles.fontWeight} ${fontSize} ${styles.fontFamily}`;
  const titleWidth = titles.reduce(
    (widest, title) => Math.max(widest, context.measureText(title).width),
    0,
  );
  const itemSpacing = cssPixelValue(styles, "--size-4-2");
  const iconWidth = cssPixelValue(styles, "--icon-s");
  const scrollPadding = cssPixelValue(styles, "--menu-padding");
  const borderWidth = Platform.isMobile ? 0 : cssPixelValue(styles, "--menu-border-width");
  return titleWidth + iconWidth + itemSpacing * 3 + scrollPadding * 2 + borderWidth * 2;
}

function cssPixelValue(styles: CSSStyleDeclaration, property: string): number {
  const value = Number.parseFloat(styles.getPropertyValue(property));
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function populateNativeToolbarMenu(
  menu: MenuPort,
  id: "overflow" | "shape",
  options: EditorToolbarMenuOptions,
  navigate: (id: EditorToolbarMenuId) => void,
): void {
  const state = options.getState();
  if (id === "overflow") populateOverflow(menu, state, options, navigate);
  else populateShapes(menu, state, options);
}

function populateOverflow(
  menu: MenuPort,
  state: EditorToolbarMenuState,
  options: EditorToolbarMenuOptions,
  navigate: (id: EditorToolbarMenuId) => void,
): void {
  const handlers = options.handlers;
  addAction(
    menu,
    options.ownerDocument,
    "Background",
    backgroundIconId(state.background.type),
    () => navigate("background"),
  );
  if (state.overflow.hasSelection) {
    menu.addSeparator();
    addAction(
      menu,
      options.ownerDocument,
      "Bring forward",
      "arrow-up",
      () => handlers.onOverflowAction("bring-forward"),
      { disabled: !state.overflow.arrange["bring-forward"] },
    );
    addAction(
      menu,
      options.ownerDocument,
      "Send backward",
      "arrow-down",
      () => handlers.onOverflowAction("send-backward"),
      {
        disabled: !state.overflow.arrange["send-backward"],
      },
    );
    addAction(
      menu,
      options.ownerDocument,
      "Bring to front",
      "chevrons-up",
      () => handlers.onOverflowAction("bring-to-front"),
      {
        disabled: !state.overflow.arrange["bring-to-front"],
      },
    );
    addAction(
      menu,
      options.ownerDocument,
      "Send to back",
      "chevrons-down",
      () => handlers.onOverflowAction("send-to-back"),
      {
        disabled: !state.overflow.arrange["send-to-back"],
      },
    );
  }
  menu.addSeparator();
  addAction(menu, options.ownerDocument, "Copy embed", "copy", () =>
    handlers.onOverflowAction("copy-embed"),
  );
  menu.addSeparator();
  addAction(menu, options.ownerDocument, "Settings", "settings", () =>
    options.ownerWindow.queueMicrotask(handlers.onOpenSettings),
  );
  addAction(menu, options.ownerDocument, "Keyboard shortcuts", "keyboard", () =>
    options.ownerWindow.queueMicrotask(handlers.onOpenShortcuts),
  );
  menu.addSeparator();
  addAction(
    menu,
    options.ownerDocument,
    "Erase all",
    state.overflow.canEraseAll ? CAUTION_ERASER_ICON_ID : "eraser",
    () => handlers.onOverflowAction("erase-all"),
    {
      caution: true,
      disabled: !state.overflow.canEraseAll,
    },
  );
  addAction(
    menu,
    options.ownerDocument,
    "Delete embed",
    "trash-2",
    () => handlers.onOverflowAction("delete-embed"),
    { warning: true },
  );
}

function populateShapes(
  menu: MenuPort,
  state: EditorToolbarMenuState,
  options: EditorToolbarMenuOptions,
): void {
  let group: (typeof SHAPES)[number][2] | undefined;
  for (const [shape, title, nextGroup] of SHAPES) {
    if (group !== undefined && nextGroup !== group) menu.addSeparator();
    group = nextGroup;
    addAction(
      menu,
      options.ownerDocument,
      title,
      activeShapeIconId(shape, state.shapeIcon),
      () => options.handlers.onShapeChange(shape),
      { checked: state.selectedShape === shape },
    );
  }
}

function addAction(
  menu: MenuPort,
  ownerDocument: Document,
  title: string,
  icon: string,
  onClick: () => void,
  state: {
    readonly caution?: boolean;
    readonly checked?: boolean;
    readonly disabled?: boolean;
    readonly warning?: boolean;
  } = {},
): void {
  menu.addItem((item) => {
    setMenuItemTitle(item, ownerDocument, title, state.caution === true && state.disabled !== true);
    item.setIcon(icon);
    if (state.checked !== undefined) item.setChecked?.(state.checked);
    if (state.disabled === true) item.setDisabled(true);
    if (state.warning === true) item.setWarning(true);
    if (state.disabled !== true) item.onClick(onClick);
  });
}
