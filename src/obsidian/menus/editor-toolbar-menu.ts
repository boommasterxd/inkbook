import type {
  BackgroundMenuState,
  BackgroundType,
  EditorMenuCallbacks,
  OverflowMenuState,
  ShapeId,
  StyleControl,
} from "../../rendering/ui/flyout-types";
import {
  activeShapeIconId,
  BACKGROUND_SQUARES_ICON_ID,
  type ActiveShapeIconState,
  CAUTION_ERASER_ICON_ID,
} from "../../rendering/ui/icon-ids";
import { createBackgroundSpacingContent } from "./background-spacing-content";
import {
  createDesktopMenuMotion,
  type MenuMotionBounds,
  type MenuMotionHandle,
} from "./menu-motion";
import { createMenuTitleContent } from "./menu-title-content";
import { createStyleMenuContent } from "./style-menu-content";
import type { FocusTargetPort, MenuFactoryPort, MenuItemPort, MenuPort } from "./menu-ports";

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

const COMPACT_MENU_WIDTH = 199;
const COMPACT_MENU_TITLE_WIDTH = 145;
const STYLE_MENU_WIDTH = 364;
const BACKGROUND_ICONS: Readonly<Record<BackgroundType, string>> = {
  dots: "grip",
  lines: "align-justify",
  none: "ban",
  squares: BACKGROUND_SQUARES_ICON_ID,
};

export class EditorToolbarMenuSession {
  readonly #options: EditorToolbarMenuOptions;
  #closed = false;
  #menu: MenuPort | undefined;
  #motion: MenuMotionHandle | undefined;
  #navigationGeneration = 0;

  public constructor(options: EditorToolbarMenuOptions) {
    this.#options = options;
    this.#show(options.initialMenu);
  }

  public close(mode: "animated" | "immediate" = "animated"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#navigationGeneration += 1;
    const menu = this.#menu;
    this.#menu = undefined;
    if (mode === "immediate") this.#motion?.cancel();
    menu?.close();
    this.#motion = undefined;
    this.#finish();
  }

  #show(id: EditorToolbarMenuId, previousBounds?: MenuMotionBounds): void {
    if (this.#closed) return;
    const menu = this.#options.factory.create();
    let motion: MenuMotionHandle | undefined;
    this.#menu = menu;
    menu.onHide(() => {
      motion?.exit();
      if (this.#menu !== menu) return;
      this.#menu = undefined;
      this.#motion = undefined;
      this.#closed = true;
      this.#finish();
    });
    const marker = populateToolbarMenu(menu, id, this.#options, (next) => this.#navigate(next));
    menu.setParentElement?.(this.#options.anchor);
    menu.showAtPosition(
      menuPositionBelow(this.#options.anchor, id, this.#options.ownerDocument),
      this.#options.ownerDocument,
    );
    if (marker !== undefined) {
      motion = createDesktopMenuMotion({
        kind: id === "style" ? "cards" : "surface",
        marker,
        motionSource: this.#options.anchor,
        ownerWindow: this.#options.ownerWindow,
        ...(previousBounds === undefined ? {} : { previousBounds }),
      });
    }
    this.#motion = motion;
  }

  #navigate(id: EditorToolbarMenuId): void {
    if (this.#closed) return;
    const previous = this.#menu;
    const previousMotion = this.#motion;
    const previousBounds = previousMotion?.bounds;
    this.#menu = undefined;
    this.#motion = undefined;
    previousMotion?.exit();
    previous?.close();
    const generation = ++this.#navigationGeneration;
    this.#options.ownerWindow.queueMicrotask(() => {
      if (generation !== this.#navigationGeneration || this.#closed) return;
      this.#show(id, previousBounds);
    });
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
}

export function menuPositionBelow(
  anchor: HTMLElement,
  id: EditorToolbarMenuId,
  ownerDocument: Document,
) {
  const bounds = anchor.getBoundingClientRect();
  const requestedWidth = id === "style" ? STYLE_MENU_WIDTH : COMPACT_MENU_WIDTH;
  const viewportWidth =
    ownerDocument.documentElement.clientWidth ||
    ownerDocument.defaultView?.innerWidth ||
    requestedWidth;
  const width = Math.min(requestedWidth, viewportWidth);
  const centeredX = bounds.left + bounds.width / 2 - width / 2;
  const x = Math.min(Math.max(0, centeredX), Math.max(0, viewportWidth - width));
  return { overlap: true, width, x, y: bounds.bottom + 6 };
}

export function populateToolbarMenu(
  menu: MenuPort,
  id: EditorToolbarMenuId,
  options: EditorToolbarMenuOptions,
  navigate: (id: EditorToolbarMenuId) => void,
): HTMLElement | undefined {
  const state = options.getState();
  if (id === "overflow") return populateOverflow(menu, state, options, navigate);
  if (id === "background") return populateBackground(menu, state.background, options, navigate);
  if (id === "shape") return populateShapes(menu, state, options);
  return populateStyle(menu, state.styleControls, options);
}

function populateOverflow(
  menu: MenuPort,
  state: EditorToolbarMenuState,
  options: EditorToolbarMenuOptions,
  navigate: (id: EditorToolbarMenuId) => void,
): HTMLElement | undefined {
  const handlers = options.handlers;
  const marker = addAction(
    menu,
    "Background",
    BACKGROUND_ICONS[state.background.type],
    () => navigate("background"),
    {
      minTitleWidth: COMPACT_MENU_TITLE_WIDTH,
      motionMarker: true,
      ownerDocument: options.ownerDocument,
    },
  );
  if (state.overflow.hasSelection) {
    menu.addSeparator();
    addLabel(menu, "Arrange", "layers");
    addAction(menu, "Bring forward", "arrow-up", () => handlers.onOverflowAction("bring-forward"), {
      disabled: !state.overflow.arrange["bring-forward"],
    });
    addAction(
      menu,
      "Send backward",
      "arrow-down",
      () => handlers.onOverflowAction("send-backward"),
      {
        disabled: !state.overflow.arrange["send-backward"],
      },
    );
    addAction(
      menu,
      "Bring to front",
      "chevrons-up",
      () => handlers.onOverflowAction("bring-to-front"),
      {
        disabled: !state.overflow.arrange["bring-to-front"],
      },
    );
    addAction(
      menu,
      "Send to back",
      "chevrons-down",
      () => handlers.onOverflowAction("send-to-back"),
      {
        disabled: !state.overflow.arrange["send-to-back"],
      },
    );
  }
  menu.addSeparator();
  addAction(menu, "Copy embed", "copy", () => handlers.onOverflowAction("copy-embed"));
  menu.addSeparator();
  addAction(
    menu,
    "Erase all",
    CAUTION_ERASER_ICON_ID,
    () => handlers.onOverflowAction("erase-all"),
    {
      caution: true,
      disabled: !state.overflow.canEraseAll,
      ownerDocument: options.ownerDocument,
    },
  );
  addAction(menu, "Delete embed", "trash-2", () => handlers.onOverflowAction("delete-embed"), {
    warning: true,
  });
  return marker;
}

function populateBackground(
  menu: MenuPort,
  state: BackgroundMenuState,
  options: EditorToolbarMenuOptions,
  navigate: (id: EditorToolbarMenuId) => void,
): HTMLElement | undefined {
  const handlers = options.handlers;
  const marker = addAction(menu, "Back", "arrow-left", () => navigate("overflow"), {
    minTitleWidth: COMPACT_MENU_TITLE_WIDTH,
    motionMarker: true,
    ownerDocument: options.ownerDocument,
  });
  menu.addSeparator();
  const types: readonly (readonly [BackgroundType, string, string])[] = [
    ["none", "None", BACKGROUND_ICONS.none],
    ["lines", "Lines", BACKGROUND_ICONS.lines],
    ["dots", "Dots", BACKGROUND_ICONS.dots],
    ["squares", "Squares", BACKGROUND_ICONS.squares],
  ];
  for (const [type, title, icon] of types) {
    addAction(
      menu,
      title,
      icon,
      () => {
        handlers.onBackgroundTypeChange(type);
        if (type !== "none") navigate("background");
      },
      { checked: state.type === type },
    );
  }
  if (state.type === "none") return marker;
  menu.addSeparator();
  menu.addItem((item) => {
    item.setIsLabel(true);
    item.setTitleFragment?.(
      createBackgroundSpacingContent({
        onChange: handlers.onBackgroundSpacingChange,
        onPreview: handlers.onBackgroundSpacingPreview,
        ownerDocument: options.ownerDocument,
        renderIcon: options.renderIcon,
        spacing: state.spacing ?? "m",
      }),
    );
  });
  return marker;
}

function populateShapes(
  menu: MenuPort,
  state: EditorToolbarMenuState,
  options: EditorToolbarMenuOptions,
): HTMLElement | undefined {
  const handlers = options.handlers;
  let group: (typeof SHAPES)[number][2] | undefined;
  let marker: HTMLElement | undefined;
  for (const [shape, title, nextGroup] of SHAPES) {
    if (group !== undefined && nextGroup !== group) menu.addSeparator();
    group = nextGroup;
    const itemMarker = addAction(
      menu,
      title,
      activeShapeIconId(shape, state.shapeIcon),
      () => handlers.onShapeChange(shape),
      {
        checked: state.selectedShape === shape,
        ...(marker === undefined
          ? { motionMarker: true, ownerDocument: options.ownerDocument }
          : {}),
      },
    );
    marker ??= itemMarker;
  }
  return marker;
}

function populateStyle(
  menu: MenuPort,
  controls: readonly StyleControl[],
  options: EditorToolbarMenuOptions,
): HTMLElement {
  const content = createStyleMenuContent({
    controls,
    onChange: options.handlers.onStyleChange,
    ownerDocument: options.ownerDocument,
    renderIcon: options.renderIcon,
  });
  const marker = content.querySelector<HTMLElement>(".inkbook-menu-controls");
  if (marker === null) throw new Error("The Style menu requires its owned control root.");
  menu.addItem((item) => {
    item.setIsLabel(true);
    item.setTitleFragment?.(content);
  });
  return marker;
}

function addAction(
  menu: MenuPort,
  title: string,
  icon: string,
  onClick: () => void,
  state: {
    readonly caution?: boolean;
    readonly checked?: boolean;
    readonly disabled?: boolean;
    readonly minTitleWidth?: number;
    readonly motionMarker?: boolean;
    readonly ownerDocument?: Document;
    readonly warning?: boolean;
  } = {},
): HTMLElement | undefined {
  let marker: HTMLElement | undefined;
  menu.addItem((item) => {
    if (
      state.caution === true ||
      state.minTitleWidth !== undefined ||
      state.motionMarker === true
    ) {
      if (state.ownerDocument === undefined)
        throw new Error("Custom menu titles require an owning document.");
      if (item.setTitleFragment === undefined) item.setTitle(title);
      else {
        const content = createMenuTitleContent(state.ownerDocument, title, {
          ...(state.caution === undefined ? {} : { caution: state.caution }),
          ...(state.minTitleWidth === undefined ? {} : { minWidth: state.minTitleWidth }),
          ...(state.motionMarker === undefined ? {} : { motionMarker: state.motionMarker }),
        });
        marker = content.querySelector<HTMLElement>(".inkbook-menu-motion-marker") ?? undefined;
        item.setTitleFragment(content);
      }
    } else item.setTitle(title);
    item.setIcon(icon);
    if (state.checked !== undefined) item.setChecked?.(state.checked);
    if (state.disabled === true) item.setDisabled(true);
    if (state.warning === true) item.setWarning(true);
    if (state.disabled !== true) item.onClick(onClick);
  });
  return marker;
}

function addLabel(
  menu: MenuPort,
  title: string,
  icon: string,
  minTitleWidth?: number,
  ownerDocument?: Document,
): void {
  menu.addItem((item: MenuItemPort) => {
    if (
      minTitleWidth !== undefined &&
      ownerDocument !== undefined &&
      item.setTitleFragment !== undefined
    ) {
      item.setTitleFragment(
        createMenuTitleContent(ownerDocument, title, { minWidth: minTitleWidth }),
      );
    } else item.setTitle(title);
    item.setIcon(icon).setIsLabel(true);
  });
}
