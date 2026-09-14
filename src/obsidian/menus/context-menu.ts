import { CAUTION_ERASER_ICON_ID } from "../../rendering/ui/icon-ids";
import { setMenuItemTitle } from "./menu-dom";
import type { FocusTargetPort, MenuFactoryPort, MenuPort, MenuPosition } from "./menu-ports";

const CONTEXT_MENU_ICONS = {
  bringForward: "arrow-up",
  bringToFront: "chevrons-up",
  copy: "copy",
  cut: "scissors",
  delete: "trash-2",
  eraseAll: CAUTION_ERASER_ICON_ID,
  paste: "clipboard-paste",
  sendBackward: "arrow-down",
  sendToBack: "chevrons-down",
} as const;

export type ContextMenuAction =
  | "copy"
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
  menu: MenuPort,
  ownerDocument: Document,
  title: string,
  icon: string,
  callback: () => void,
  options: {
    readonly caution?: boolean;
    readonly disabled?: boolean;
    readonly warning?: boolean;
  } = {},
): void {
  menu.addItem((item) => {
    setMenuItemTitle(item, ownerDocument, title, options.caution === true);
    item.setIcon(icon);
    if (options.disabled === true) item.setDisabled(true);
    if (options.warning === true) item.setWarning(true);
    if (options.disabled !== true) item.onClick(callback);
  });
}

function configureSelectionItems(
  menu: MenuPort,
  ownerDocument: Document,
  state: ContextMenuState,
  handlers: ContextMenuHandlers,
): void {
  configureItem(menu, ownerDocument, "Copy", CONTEXT_MENU_ICONS.copy, handlers.copy);
  configureItem(menu, ownerDocument, "Cut", CONTEXT_MENU_ICONS.cut, handlers.cut);
  if (state.canPaste) {
    configureItem(menu, ownerDocument, "Paste", CONTEXT_MENU_ICONS.paste, handlers.paste);
  }
  menu.addSeparator();
  configureItem(menu, ownerDocument, "Delete", CONTEXT_MENU_ICONS.delete, handlers.delete, {
    warning: true,
  });
  menu.addSeparator();
  configureItem(
    menu,
    ownerDocument,
    "Bring forward",
    CONTEXT_MENU_ICONS.bringForward,
    handlers.bringForward,
    { disabled: !state.canBringForward },
  );
  configureItem(
    menu,
    ownerDocument,
    "Send backward",
    CONTEXT_MENU_ICONS.sendBackward,
    handlers.sendBackward,
    { disabled: !state.canSendBackward },
  );
  configureItem(
    menu,
    ownerDocument,
    "Bring to front",
    CONTEXT_MENU_ICONS.bringToFront,
    handlers.bringToFront,
    { disabled: !state.canBringToFront },
  );
  configureItem(
    menu,
    ownerDocument,
    "Send to back",
    CONTEXT_MENU_ICONS.sendToBack,
    handlers.sendToBack,
    { disabled: !state.canSendToBack },
  );
}

function configureCanvasItems(
  menu: MenuPort,
  ownerDocument: Document,
  state: ContextMenuState,
  handlers: ContextMenuHandlers,
): void {
  if (!state.hasSelection && state.canPaste) {
    configureItem(menu, ownerDocument, "Paste", CONTEXT_MENU_ICONS.paste, handlers.paste);
    menu.addSeparator();
  }
  configureItem(menu, ownerDocument, "Copy embed", CONTEXT_MENU_ICONS.copy, handlers.copyEmbed, {
    disabled: state.canCopyEmbed === false,
  });
  menu.addSeparator();
  configureItem(menu, ownerDocument, "Erase all", CONTEXT_MENU_ICONS.eraseAll, handlers.eraseAll, {
    caution: true,
    disabled: state.canEraseAll === false,
  });
  configureItem(
    menu,
    ownerDocument,
    "Delete embed",
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
): void {
  if (state.hasSelection) {
    configureSelectionItems(menu, ownerDocument, state, handlers);
    menu.addSeparator();
  }
  configureCanvasItems(menu, ownerDocument, state, handlers);
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
  populateContextMenu(menu, invocation.ownerDocument, state, handlers);
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
