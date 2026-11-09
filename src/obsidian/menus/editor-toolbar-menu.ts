import type { MessageKey } from "../../domain/localization";
import { LocalizedActionMenu } from "./localized-action-menu";
import { menuTranslator, type MenuLocalizationOptions } from "./localized-menu-text";
import type { PhoneSheetHostPort } from "./panels/phone-sheet-host";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
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
import { AdaptivePanelSession, type AdaptivePanelContentLifecycle } from "./panels/adaptive-panel";
import { backgroundIconId, createBackgroundMenuContent } from "./background-menu-content";
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

export interface EditorToolbarMenuOptions extends MenuLocalizationOptions {
  readonly workScheduler: WorkScheduler;
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

const SHAPES: readonly (readonly [ShapeId, "lines" | "shapes" | "structures"])[] = [
  ["line", "lines"],
  ["arrow", "lines"],
  ["rectangle", "shapes"],
  ["ellipse", "shapes"],
  ["triangle", "shapes"],
  ["star", "shapes"],
  ["octagon", "shapes"],
  ["parallelogram", "shapes"],
  ["diamond", "shapes"],
  ["coordinate-system", "structures"],
  ["table", "structures"],
];
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
    if (this.#closed) {
      if (mode === "immediate") {
        this.#menu?.close(mode);
        this.#panel?.close(mode);
      }
      return;
    }
    this.#closed = true;
    this.#navigationGeneration += 1;
    if (this.#menu !== undefined) this.#menu.close(mode);
    else if (this.#panel !== undefined) this.#panel.close(mode);
    else this.#finish();
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
    const navigation = this.#menu?.getPhoneNavigation?.();
    if (id === "background" && navigation !== undefined) {
      navigation.push({
        kind: "background",
        label: menuTranslator(this.#options)("editor.action.background"),
        readLabel: () => menuTranslator(this.#options)("editor.action.background"),
        ...(this.#options.localization === undefined
          ? {}
          : {
              subscribeLabel: (listener: () => void) =>
                this.#options.localization!.subscribe(listener),
            }),
        createContent: (lifecycle) => this.#createPanelContent("background", lifecycle),
      });
      return;
    }
    const previousMenu = this.#menu;
    const previousPanel = this.#panel;
    this.#menu = undefined;
    this.#panel = undefined;
    previousMenu?.close("handoff");
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
    this.#showActionMenu(id);
  }

  #showActionMenu(id: "overflow" | "shape"): void {
    const menu = this.#options.factory.create();
    this.#menu = menu;
    menu.onHide(() => {
      if (this.#menu !== menu) return;
      this.#menu = undefined;
      this.#closed = true;
      this.#finish();
    });
    populateToolbarActionMenu(menu, id, this.#options, (next) => this.#navigate(next));
    menu.setParentElement?.(this.#options.anchor);
    menu.showAtPosition(menuPositionBelow(this.#options.anchor, id), this.#options.ownerDocument);
  }

  #showPanel(id: "background" | "style"): void {
    let panel: AdaptivePanelSession;
    panel = new AdaptivePanelSession({
      workScheduler: this.#options.workScheduler,
      anchor: this.#options.anchor,
      canvasInputSurface: this.#options.canvasInputSurface,
      createContent: (lifecycle) => this.#createPanelContent(id, lifecycle),
      ...(this.#options.keymap === undefined ? {} : { keymap: this.#options.keymap }),
      ...(this.#options.createPhoneSheetHost === undefined
        ? {}
        : { createPhoneSheetHost: this.#options.createPhoneSheetHost }),
      kind: id,
      label: menuTranslator(this.#options)(
        id === "style" ? "editor.action.style" : "editor.action.background",
      ),
      localization: this.#options.localization,
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
        localization: this.#options.localization,
        registerLocaleUpdate: lifecycle.registerLocaleUpdate,
        onChange: this.#options.handlers.onStyleChange,
        ownerDocument: this.#options.ownerDocument,
        renderIcon: this.#options.renderIcon,
      });
    }
    return createBackgroundMenuContent({
      getState: () => this.#options.getState().background,
      localization: this.#options.localization,
      registerLocaleUpdate: lifecycle.registerLocaleUpdate,
      initialState: state.background,
      mutateLayout: (update) => lifecycle.mutateLayout(update),
      onSpacingChange: this.#options.handlers.onBackgroundSpacingChange,
      onSpacingPreview: this.#options.handlers.onBackgroundSpacingPreview,
      onTypeChange: this.#options.handlers.onBackgroundTypeChange,
      ownerDocument: this.#options.ownerDocument,
      renderIcon: this.#options.renderIcon,
    });
  }
}

export function menuPositionBelow(anchor: HTMLElement, id: "overflow" | "shape") {
  const bounds = anchor.getBoundingClientRect();
  const y = bounds.bottom + (Platform.isMobile && !Platform.isPhone ? 0 : 2);
  if (id !== "overflow" || Platform.isPhone) {
    return { overlap: true, x: bounds.left, y };
  }
  return { centered: true, width: bounds.width, x: bounds.left, y };
}

export function populateToolbarActionMenu(
  menu: MenuPort,
  id: "overflow" | "shape",
  options: EditorToolbarMenuOptions,
  navigate: (id: EditorToolbarMenuId) => void,
): void {
  const actions = new LocalizedActionMenu(menu, options.ownerDocument, options.localization);
  const state = options.getState();
  if (id === "overflow") populateOverflow(actions, state, options, navigate);
  else populateShapes(actions, state, options);
}

function populateOverflow(
  menu: LocalizedActionMenu,
  state: EditorToolbarMenuState,
  options: EditorToolbarMenuOptions,
  navigate: (id: EditorToolbarMenuId) => void,
): void {
  const handlers = options.handlers;
  addAction(
    menu,
    "editor.action.background",
    backgroundIconId(state.background.type),
    () => navigate("background"),
    { keepOpen: Platform.isPhone && menu.getPhoneNavigation !== undefined },
  );
  if (state.overflow.hasSelection) {
    menu.addSeparator();
    addAction(
      menu,
      "editor.action.bring-forward",
      "arrow-up",
      () => handlers.onOverflowAction("bring-forward"),
      { disabled: !state.overflow.arrange["bring-forward"] },
    );
    addAction(
      menu,
      "editor.action.send-backward",
      "arrow-down",
      () => handlers.onOverflowAction("send-backward"),
      {
        disabled: !state.overflow.arrange["send-backward"],
      },
    );
    addAction(
      menu,
      "editor.action.bring-to-front",
      "chevrons-up",
      () => handlers.onOverflowAction("bring-to-front"),
      {
        disabled: !state.overflow.arrange["bring-to-front"],
      },
    );
    addAction(
      menu,
      "editor.action.send-to-back",
      "chevrons-down",
      () => handlers.onOverflowAction("send-to-back"),
      {
        disabled: !state.overflow.arrange["send-to-back"],
      },
    );
  }
  menu.addSeparator();
  addAction(menu, "editor.action.copy-embed", "copy", () =>
    handlers.onOverflowAction("copy-embed"),
  );
  menu.addSeparator();
  addSettingsActions(menu, options);
  menu.addSeparator();
  addAction(
    menu,
    "editor.action.erase-all",
    state.overflow.canEraseAll ? CAUTION_ERASER_ICON_ID : "eraser",
    () => afterMenuHandoff(options.ownerWindow, () => handlers.onOverflowAction("erase-all")),
    {
      caution: true,
      disabled: !state.overflow.canEraseAll,
    },
  );
  addAction(
    menu,
    "editor.action.delete-embed",
    "trash-2",
    () => afterMenuHandoff(options.ownerWindow, () => handlers.onOverflowAction("delete-embed")),
    { warning: true },
  );
}

function addSettingsActions(menu: LocalizedActionMenu, options: EditorToolbarMenuOptions): void {
  const add = (
    label: MessageKey,
    icon: string,
    open: EditorMenuCallbacks["onOpenSettings"],
  ): void => {
    addAction(
      menu,
      label,
      icon,
      () => {
        const navigation = menu.getPhoneNavigation?.();
        if (navigation === undefined) afterMenuHandoff(options.ownerWindow, () => open());
        else open(navigation);
      },
      { keepOpen: Platform.isPhone && menu.getPhoneNavigation !== undefined },
    );
  };
  add("editor.action.settings", "settings", options.handlers.onOpenSettings);
  add("editor.action.shortcuts", "keyboard", options.handlers.onOpenShortcuts);
  const openTour = options.handlers.onOpenTour;
  if (openTour !== undefined)
    addAction(menu, "editor.action.tour", "circle-help", () =>
      afterMenuHandoff(options.ownerWindow, openTour),
    );
}

function afterMenuHandoff(ownerWindow: Window, open: () => void): void {
  // Menu teardown restores the anchor before a dialog captures its return-focus target.
  ownerWindow.queueMicrotask(open);
}

function populateShapes(
  menu: LocalizedActionMenu,
  state: EditorToolbarMenuState,
  options: EditorToolbarMenuOptions,
): void {
  let group: (typeof SHAPES)[number][1] | undefined;
  for (const [shape, nextGroup] of SHAPES) {
    if (group !== undefined && nextGroup !== group) menu.addSeparator();
    group = nextGroup;
    addAction(
      menu,
      `editor.shape.${shape}`,
      activeShapeIconId(shape, state.shapeIcon),
      () => options.handlers.onShapeChange(shape),
      { checked: state.selectedShape === shape },
    );
  }
}

function addAction(
  menu: LocalizedActionMenu,
  title: MessageKey,
  icon: string,
  onClick: () => void,
  state: {
    readonly caution?: boolean;
    readonly checked?: boolean;
    readonly disabled?: boolean;
    readonly warning?: boolean;
    readonly keepOpen?: boolean;
  } = {},
): void {
  menu.addItem(
    title,
    (item) => {
      item.setIcon(icon);
      if (state.checked !== undefined) item.setChecked?.(state.checked);
      if (state.disabled === true) item.setDisabled(true);
      if (state.warning === true) item.setWarning(true);
      if (state.keepOpen === true) item.setKeepOpen?.(true);
      if (state.disabled !== true) item.onClick(onClick);
    },
    state.caution === true && state.disabled !== true,
  );
}
