import { LocalizedActionMenu } from "./localized-action-menu";
import { type Localization, type MessageKey } from "../../domain/localization";
import { CAUTION_ERASER_ICON_ID } from "../../rendering/ui/icon-ids";
import type { FocusTargetPort, MenuFactoryPort, MenuPort, MenuPosition } from "./menu-ports";

const CONTEXT_MENU_ICONS = {
  bringForward: "arrow-up",
  bringToFront: "chevrons-up",
  copy: "copy",
  cut: "scissors",
  delete: "trash-2",
  editText: "type",
  cropImage: "crop",
  importImages: "image",
  eraseAll: CAUTION_ERASER_ICON_ID,
  paste: "clipboard-paste",
  lockSelection: "lock",
  unlockSelection: "lock-open",
  selectLocked: "scan",
  sendBackward: "arrow-down",
  sendToBack: "chevrons-down",
} as const;

export type ContextMenuAction =
  | "lock-selection"
  | "unlock-selection"
  | "select-locked"
  | "copy"
  | "copy-text"
  | "copy-element"
  | "cut"
  | "delete"
  | "bring-forward"
  | "send-backward"
  | "bring-to-front"
  | "send-to-back"
  | "paste"
  | "copy-embed"
  | "erase-all"
  | "delete-embed";

export interface ContextMenuState {
  readonly selectionLock?: "none" | "lock" | "unlock";
  readonly canSelectLocked?: boolean;
  readonly canCut?: boolean;
  readonly canDelete?: boolean;
  readonly canCropImage?: boolean;
  readonly imageContrast?: "auto" | "light" | "dark" | undefined;
  readonly canImportImages?: boolean;
  readonly canCopyText?: boolean | undefined;
  readonly canEditText?: boolean;
  readonly hasSelection: boolean;
  readonly canPaste: boolean;
  readonly canBringForward: boolean;
  readonly canSendBackward: boolean;
  readonly canBringToFront: boolean;
  readonly canSendToBack: boolean;
  readonly canCopyEmbed?: boolean;
  readonly canEraseAll?: boolean;
  readonly canDeleteEmbed?: boolean;
}

export interface ContextMenuHandlers {
  readonly lockSelection?: (() => void) | undefined;
  readonly unlockSelection?: (() => void) | undefined;
  readonly selectLocked?: (() => void) | undefined;
  readonly cropImage?: (() => void) | undefined;
  readonly imageContrast?: (() => void) | undefined;
  readonly importImages?: (() => void) | undefined;
  readonly copyText?: (() => void) | undefined;
  readonly copyElement?: (() => void) | undefined;
  readonly editText?: (() => void) | undefined;
  readonly copy: () => void;
  readonly cut: () => void;
  readonly delete: () => void;
  readonly bringForward: () => void;
  readonly sendBackward: () => void;
  readonly bringToFront: () => void;
  readonly sendToBack: () => void;
  readonly paste: () => void;
  readonly copyEmbed: () => void;
  readonly eraseAll: () => void;
  readonly deleteEmbed: () => void;
}

interface ContextMenuInvocationBase {
  readonly localization?: Localization | undefined;
  readonly ownerDocument: Document;
  readonly onClosed?: () => void;
  readonly returnFocus?: FocusTargetPort;
  readonly restoreFocus?: boolean;
  readonly canvasInputSurface: FocusTargetPort;
}

interface EventMenuInvocation extends ContextMenuInvocationBase {
  readonly type: "event";
  readonly event: MouseEvent | PointerEvent;
}

interface PositionMenuInvocation extends ContextMenuInvocationBase {
  readonly type: "position";
  readonly position: MenuPosition;
}

export type ContextMenuInvocation = EventMenuInvocation | PositionMenuInvocation;

export interface ContextMenuSession {
  close(mode?: "animated" | "immediate"): void;
}

function configureItem(
  menu: LocalizedActionMenu,
  title: MessageKey,
  icon: string,
  callback: () => void,
  options: {
    readonly caution?: boolean;
    readonly disabled?: boolean;
    readonly warning?: boolean;
  } = {},
): void {
  menu.addItem(
    title,
    (item) => {
      item.setIcon(icon);
      if (options.disabled === true) item.setDisabled(true);
      if (options.warning === true) item.setWarning(true);
      if (options.disabled !== true) item.onClick(callback);
    },
    options.caution === true,
  );
}

function configureSelectionItems(
  menu: LocalizedActionMenu,
  state: ContextMenuState,
  handlers: ContextMenuHandlers,
): void {
  const lock =
    state.selectionLock === "lock"
      ? handlers.lockSelection
      : state.selectionLock === "unlock"
        ? handlers.unlockSelection
        : undefined;
  if (lock !== undefined) {
    configureItem(
      menu,
      state.selectionLock === "lock"
        ? "editor.action.lock-selection"
        : "editor.action.unlock-selection",
      state.selectionLock === "lock"
        ? CONTEXT_MENU_ICONS.lockSelection
        : CONTEXT_MENU_ICONS.unlockSelection,
      lock,
    );
    menu.addSeparator();
  }
  if (state.canCropImage === true && handlers.cropImage !== undefined) {
    configureItem(
      menu,
      "editor.action.crop-image",
      CONTEXT_MENU_ICONS.cropImage,
      handlers.cropImage,
    );
    menu.addSeparator();
  }
  if (state.imageContrast !== undefined && handlers.imageContrast !== undefined) {
    configureItem(
      menu,
      `editor.image.underlay-${state.imageContrast}`,
      "sun-moon",
      handlers.imageContrast,
    );
    menu.addSeparator();
  }
  if (state.canEditText === true && handlers.editText !== undefined) {
    configureItem(menu, "editor.action.edit-text", CONTEXT_MENU_ICONS.editText, handlers.editText);
    menu.addSeparator();
  }
  configureCopyItems(menu, state, handlers);
  configureItem(menu, "editor.action.cut", CONTEXT_MENU_ICONS.cut, handlers.cut, {
    disabled: state.canCut === false,
  });
  if (state.canPaste) {
    configureItem(menu, "editor.action.paste", CONTEXT_MENU_ICONS.paste, handlers.paste);
  }
  menu.addSeparator();
  configureItem(menu, "editor.action.delete", CONTEXT_MENU_ICONS.delete, handlers.delete, {
    warning: true,
    disabled: state.canDelete === false,
  });
  menu.addSeparator();
  configureItem(
    menu,
    "editor.action.bring-forward",
    CONTEXT_MENU_ICONS.bringForward,
    handlers.bringForward,
    { disabled: !state.canBringForward },
  );
  configureItem(
    menu,
    "editor.action.send-backward",
    CONTEXT_MENU_ICONS.sendBackward,
    handlers.sendBackward,
    { disabled: !state.canSendBackward },
  );
  configureItem(
    menu,
    "editor.action.bring-to-front",
    CONTEXT_MENU_ICONS.bringToFront,
    handlers.bringToFront,
    { disabled: !state.canBringToFront },
  );
  configureItem(
    menu,
    "editor.action.send-to-back",
    CONTEXT_MENU_ICONS.sendToBack,
    handlers.sendToBack,
    { disabled: !state.canSendToBack },
  );
}

function configureCopyItems(
  menu: LocalizedActionMenu,
  state: ContextMenuState,
  handlers: ContextMenuHandlers,
): void {
  const copyElement = state.canCopyText === true ? handlers.copyElement : undefined;
  configureItem(
    menu,
    copyElement === undefined ? "editor.action.copy" : "editor.action.copy-element",
    CONTEXT_MENU_ICONS.copy,
    copyElement ?? handlers.copy,
  );
  if (state.canCopyText === true && handlers.copyText !== undefined) {
    configureItem(menu, "editor.action.copy-text", CONTEXT_MENU_ICONS.copy, handlers.copyText);
  }
}

function configureCanvasItems(
  menu: LocalizedActionMenu,
  state: ContextMenuState,
  handlers: ContextMenuHandlers,
): void {
  if (state.canSelectLocked === true && handlers.selectLocked !== undefined) {
    configureItem(
      menu,
      "editor.action.select-locked",
      CONTEXT_MENU_ICONS.selectLocked,
      handlers.selectLocked,
    );
    menu.addSeparator();
  }
  if (state.canImportImages === true && handlers.importImages !== undefined) {
    configureItem(
      menu,
      "editor.action.image",
      CONTEXT_MENU_ICONS.importImages,
      handlers.importImages,
    );
    menu.addSeparator();
  }
  if (!state.hasSelection && state.canPaste) {
    configureItem(menu, "editor.action.paste", CONTEXT_MENU_ICONS.paste, handlers.paste);
    menu.addSeparator();
  }
  configureItem(menu, "editor.action.copy-embed", CONTEXT_MENU_ICONS.copy, handlers.copyEmbed, {
    disabled: state.canCopyEmbed === false,
  });
  menu.addSeparator();
  configureItem(menu, "editor.action.erase-all", CONTEXT_MENU_ICONS.eraseAll, handlers.eraseAll, {
    caution: true,
    disabled: state.canEraseAll === false,
  });
  configureItem(
    menu,
    "editor.action.delete-embed",
    CONTEXT_MENU_ICONS.delete,
    handlers.deleteEmbed,
    { disabled: state.canDeleteEmbed === false, warning: true },
  );
}

/**
 * Adds the complete context menu in the contract's stable order.
 * The menu port owns presentation, keyboard navigation, and dismissal.
 */
export function populateContextMenu(
  menu: MenuPort,
  ownerDocument: Document,
  state: ContextMenuState,
  handlers: ContextMenuHandlers,
  localization?: Localization,
): void {
  const actions = new LocalizedActionMenu(menu, ownerDocument, localization);
  if (state.hasSelection) {
    configureSelectionItems(actions, state, handlers);
    menu.addSeparator();
  }
  configureCanvasItems(actions, state, handlers);
}

function canFocus(
  target: FocusTargetPort | undefined,
  ownerDocument: Document,
): target is FocusTargetPort {
  if (target === undefined || target.isConnected === false) return false;
  return target.ownerDocument === undefined || target.ownerDocument === ownerDocument;
}

function focusAfterClose(invocation: ContextMenuInvocation): void {
  if (invocation.restoreFocus === false) return;
  const target = canFocus(invocation.returnFocus, invocation.ownerDocument)
    ? invocation.returnFocus
    : invocation.canvasInputSurface;
  if (canFocus(target, invocation.ownerDocument)) target.focus({ preventScroll: true });
}

/**
 * Opens an owned menu and returns a lifecycle handle for presentation unload.
 * Focus is restored at most once, including when `close()` triggers `onHide`.
 */
export function openContextMenu(
  factory: MenuFactoryPort,
  invocation: ContextMenuInvocation,
  state: ContextMenuState,
  handlers: ContextMenuHandlers,
): ContextMenuSession {
  const menu =
    invocation.type === "event" ? factory.forEvent(invocation.event) : factory.create("context");
  let closed = false;
  let closing = false;
  menu.onHide(() => {
    if (closed) return;
    closed = true;
    focusAfterClose(invocation);
    invocation.onClosed?.();
  });
  populateContextMenu(
    menu,
    invocation.ownerDocument,
    state,
    {
      ...handlers,
      ...(handlers.imageContrast === undefined
        ? {}
        : {
            imageContrast: () => {
              menu.close("handoff");
              handlers.imageContrast?.();
            },
          }),
      ...(handlers.cropImage === undefined
        ? {}
        : {
            cropImage: () => {
              menu.close("handoff");
              handlers.cropImage?.();
            },
          }),
      ...(handlers.importImages === undefined
        ? {}
        : {
            importImages: () => {
              menu.close("handoff");
              handlers.importImages?.();
            },
          }),
      ...(handlers.editText === undefined
        ? {}
        : {
            editText: () => {
              menu.close("handoff");
              handlers.editText?.();
            },
          }),
      eraseAll: () => {
        // Restore focus before the confirmation dialog captures its return target.
        menu.close("handoff");
        handlers.eraseAll();
      },
    },
    invocation.localization,
  );
  if (invocation.type === "position") {
    menu.showAtPosition(invocation.position, invocation.ownerDocument);
  }
  return {
    close: (mode = "animated") => {
      if (closed || (closing && mode === "animated")) return;
      closing = true;
      menu.close(mode);
    },
  };
}
