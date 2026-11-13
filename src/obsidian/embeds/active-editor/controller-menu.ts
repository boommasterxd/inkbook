import type { Localization } from "../../../domain/localization";
import type { PhoneSheetHostPort } from "../../menus/panels/phone-sheet-host";
import {
  EditorToolbarMenuSession,
  openContextMenu,
  type ContextMenuSession,
  type EditorToolbarMenuHandlers,
  type EditorToolbarMenuId,
  type EditorToolbarMenuState,
  type FocusTargetPort,
  type MenuFactoryPort,
} from "../../menus/index";
import type { ArrangeAction } from "../../../domain/commands/arrange";
import type { InputPoint } from "../../../editor/input/index";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { ActiveEditorActions } from "./controller-actions";
import type { Keymap } from "obsidian";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { FontOptionPreviews } from "../../fonts/font-option-previews";
import type { FontPreviewSource } from "../../fonts/font-preview-source";
import { menuTranslator } from "../../menus/localized-menu-text";

interface ActiveEditorMenuOptions {
  readonly canCopyText?: boolean | undefined;
  readonly localization?: Localization | undefined;
  readonly event?: MouseEvent;
  readonly factory: MenuFactoryPort;
  readonly inputSurface: SvgSceneRenderer["inputSurface"];
  readonly ownerDocument: Document;
  readonly position: InputPoint;
  readonly returnFocus?: FocusTargetPort;
  readonly restoreFocus: boolean;
  readonly canEraseAll: boolean;
  readonly canPaste: boolean;
  readonly arrangeAvailability: Readonly<Record<ArrangeAction, boolean>>;
  readonly hasSelection: boolean;
  readonly onCopy: () => void;
  readonly onCopyText?: (() => void) | undefined;
  readonly onCopyElement?: (() => void) | undefined;
  readonly onCut: () => void;
  readonly onDelete: () => void;
  readonly onEraseAll: () => void;
  readonly onCopyEmbed: () => void;
  readonly onDeleteEmbed: () => void;
  readonly onClosed: () => void;
  readonly onArrange: (action: ArrangeAction) => void;
  readonly onPaste: () => void;
  readonly onEditText?: (() => void) | undefined;
}

function openActiveEditorMenu(options: ActiveEditorMenuOptions): ContextMenuSession {
  const invocation =
    options.event === undefined
      ? {
          localization: options.localization,
          type: "position" as const,
          canvasInputSurface: options.inputSurface,
          ownerDocument: options.ownerDocument,
          onClosed: options.onClosed,
          position: options.position,
          restoreFocus: options.restoreFocus,
          ...(options.returnFocus === undefined ? {} : { returnFocus: options.returnFocus }),
        }
      : {
          localization: options.localization,
          type: "event" as const,
          canvasInputSurface: options.inputSurface,
          event: options.event,
          ownerDocument: options.ownerDocument,
          onClosed: options.onClosed,
          restoreFocus: options.restoreFocus,
          ...(options.returnFocus === undefined ? {} : { returnFocus: options.returnFocus }),
        };
  return openContextMenu(
    options.factory,
    invocation,
    {
      canCopyText: options.canCopyText,
      canBringForward: options.arrangeAvailability["bring-forward"],
      canBringToFront: options.arrangeAvailability["bring-to-front"],
      canCopyEmbed: true,
      canDeleteEmbed: true,
      canEraseAll: options.canEraseAll,
      canPaste: options.canPaste,
      canSendBackward: options.arrangeAvailability["send-backward"],
      canSendToBack: options.arrangeAvailability["send-to-back"],
      hasSelection: options.hasSelection,
      canEditText: options.onEditText !== undefined,
    },
    {
      bringForward: () => options.onArrange("bring-forward"),
      bringToFront: () => options.onArrange("bring-to-front"),
      copy: options.onCopy,
      copyText: options.onCopyText,
      copyElement: options.onCopyElement,
      copyEmbed: options.onCopyEmbed,
      cut: options.onCut,
      delete: options.onDelete,
      deleteEmbed: options.onDeleteEmbed,
      eraseAll: options.onEraseAll,
      paste: options.onPaste,
      sendBackward: () => options.onArrange("send-backward"),
      sendToBack: () => options.onArrange("send-to-back"),
      editText: options.onEditText,
    },
  );
}

export interface ActiveEditorMenuControllerOptions extends FontPreviewSource {
  readonly onOpenFonts?: ((trigger: HTMLButtonElement) => void) | undefined;
  readonly localization?: Localization | undefined;
  readonly workScheduler: WorkScheduler;
  readonly actions: ActiveEditorActions;
  readonly factory: MenuFactoryPort;
  readonly inputSurface: SvgSceneRenderer["inputSurface"];
  readonly createPhoneSheetHost?: () => PhoneSheetHostPort;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
  readonly ownerDocument: Document;
  readonly selectionSize: () => number;
  readonly storeSize: () => number;
  readonly toScreenPoint: (point: InputPoint) => InputPoint;
  readonly visibleSelectionCenter?: () => InputPoint | null;
}

interface ToolbarMenuConfiguration {
  readonly getState: () => EditorToolbarMenuState;
  readonly handlers: EditorToolbarMenuHandlers;
  readonly onOpenChange: (id: Exclude<EditorToolbarMenuId, "background"> | null) => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

export interface ActiveEditorTextMenu {
  readonly selectedId: () => string | undefined;
  readonly onEdit: (id: string) => void;
  readonly focusTarget?: () => HTMLElement | undefined;
  readonly onOcclusionChanged?: (top: number | undefined) => void;
}

export class ActiveEditorMenuController {
  readonly #options: ActiveEditorMenuControllerOptions;
  #event: MouseEvent | undefined;
  #openGeneration = 0;
  #session: ContextMenuSession | undefined;
  #toolbarSession: EditorToolbarMenuSession | undefined;
  #toolbarMenuId: Exclude<EditorToolbarMenuId, "background"> | undefined;
  #toolbarOptions: ToolbarMenuConfiguration | undefined;
  #textEditing: ActiveEditorTextMenu | undefined;
  readonly #fontPreviews: FontOptionPreviews;

  public constructor(options: ActiveEditorMenuControllerOptions) {
    this.#options = options;
    this.#fontPreviews = new FontOptionPreviews({
      document: options.ownerDocument,
      scheduler: options.workScheduler,
      ...(options.library === undefined ? {} : { library: options.library }),
      ...(options.resources === undefined ? {} : { resources: options.resources }),
    });
  }
  public configureTextEditing(options: ActiveEditorTextMenu): void {
    this.#textEditing = options;
  }

  public get isOpen(): boolean {
    return this.#session !== undefined || this.#toolbarSession !== undefined;
  }
  public get isStyleOpen(): boolean {
    return this.#toolbarMenuId === "style" && this.#toolbarSession !== undefined;
  }
  public get occlusionTop(): number | undefined {
    return this.#toolbarSession?.occlusionTop;
  }

  public dispose(): void {
    this.#openGeneration += 1;
    this.#session?.close("immediate");
    this.#session = undefined;
    this.#toolbarSession?.close("immediate");
    this.#toolbarSession = undefined;
    this.#fontPreviews.dispose();
  }

  public closeToolbar(mode: "animated" | "immediate" = "animated"): void {
    const session = this.#toolbarSession;
    this.#toolbarSession = undefined;
    this.#toolbarMenuId = undefined;
    session?.close(mode);
    this.#toolbarOptions?.onOpenChange(null);
  }

  public configureToolbar(options: ToolbarMenuConfiguration): void {
    this.#toolbarOptions = options;
  }

  public refreshStyle(): void {
    this.#toolbarSession?.refreshStyle();
  }

  public toggleToolbar(
    id: Exclude<EditorToolbarMenuId, "background">,
    anchor: HTMLButtonElement | undefined,
  ): void {
    if (this.#toolbarMenuId === id) {
      this.closeToolbar();
      return;
    }
    const options = this.#toolbarOptions;
    if (anchor === undefined || options === undefined) return;
    this.openToolbar({ ...options, anchor, id, onClosed: () => options.onOpenChange(null) });
    options.onOpenChange(id);
  }

  public openToolbar(options: {
    readonly anchor: HTMLElement;
    readonly getState: () => EditorToolbarMenuState;
    readonly handlers: EditorToolbarMenuHandlers;
    readonly id: Exclude<EditorToolbarMenuId, "background">;
    readonly onClosed: () => void;
    readonly renderIcon: (element: HTMLElement, icon: string) => void;
  }): void {
    this.#session?.close();
    this.#session = undefined;
    this.closeToolbar("immediate");
    const ownerWindow = this.#options.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    let session: EditorToolbarMenuSession;
    session = new EditorToolbarMenuSession({
      localization: this.#options.localization,
      anchor: options.anchor,
      canvasInputSurface: this.#options.inputSurface,
      factory: this.#options.factory,
      getState: options.getState,
      handlers: options.handlers,
      initialMenu: options.id,
      ...(options.id !== "style" || this.#textEditing?.focusTarget === undefined
        ? {}
        : { externalFocusTarget: this.#textEditing.focusTarget }),
      ...(options.id !== "style" || this.#textEditing?.onOcclusionChanged === undefined
        ? {}
        : { onOcclusionChanged: this.#textEditing.onOcclusionChanged }),
      fontPreviews: this.#fontPreviews,
      ...(this.#options.onOpenFonts === undefined
        ? {}
        : {
            fontManagementAction: {
              label: () => menuTranslator(this.#options)("fonts.manage"),
              onActivate: () => {
                this.closeToolbar("immediate");
                this.#options.onOpenFonts?.(options.anchor as HTMLButtonElement);
              },
            },
          }),
      keymap: this.#options.keymap,
      createPhoneSheetHost: this.#options.createPhoneSheetHost,
      onClosed: () => {
        if (this.#toolbarSession !== session) return;
        this.#toolbarSession = undefined;
        this.#toolbarMenuId = undefined;
        options.onClosed();
      },
      ownerDocument: this.#options.ownerDocument,
      ownerWindow,
      workScheduler: this.#options.workScheduler,
      renderIcon: options.renderIcon,
    });
    this.#toolbarSession = session;
    this.#toolbarMenuId = options.id;
  }

  public dispatchFromEvent(event: MouseEvent | undefined, dispatch: () => void): void {
    const previous = this.#event;
    this.#event = event;
    try {
      dispatch();
    } finally {
      this.#event = previous;
    }
  }

  public openFromSource(source: "keyboard" | "pointer" | "touch", position: InputPoint): void {
    const resolvedPosition =
      source === "keyboard" ? (this.#options.visibleSelectionCenter?.() ?? position) : position;
    this.open(
      resolvedPosition,
      source === "pointer" ? this.#event : undefined,
      undefined,
      source !== "touch",
    );
  }

  public open(
    position: InputPoint,
    event?: MouseEvent,
    returnFocus?: FocusTargetPort,
    restoreFocus = true,
  ): void {
    this.dispose();
    const generation = this.#openGeneration;
    this.#openNow(position, event, returnFocus, restoreFocus, generation);
  }

  #openNow(
    position: InputPoint,
    event: MouseEvent | undefined,
    returnFocus: FocusTargetPort | undefined,
    restoreFocus: boolean,
    generation: number,
  ): void {
    if (generation !== this.#openGeneration) return;
    const actions = this.#options.actions;
    const textEditing = this.#textEditing;
    const textId = textEditing?.selectedId();
    const pasteInvocation = {
      invocationPoint: { x: position.x, y: position.y },
      kind: "context-menu" as const,
    };
    let session: ContextMenuSession;
    session = openActiveEditorMenu({
      canCopyText: actions.canCopyText,
      localization: this.#options.localization,
      arrangeAvailability: actions.arrangeAvailability(),
      canEraseAll: this.#options.storeSize() > 0,
      canPaste: actions.canRequestPaste,
      ...(event === undefined ? {} : { event }),
      factory: this.#options.factory,
      hasSelection: this.#options.selectionSize() > 0,
      inputSurface: this.#options.inputSurface,
      onArrange: (action) => actions.execute(action),
      onCopy: () => actions.execute("copy"),
      onCopyText: () => actions.execute("copy-text"),
      onCopyElement: () => actions.execute("copy-element"),
      onCopyEmbed: () => actions.execute("copy-embed"),
      onCut: () => actions.execute("cut"),
      onDelete: () => actions.execute("delete"),
      onDeleteEmbed: () => actions.execute("delete-embed"),
      onClosed: () => {
        if (this.#session === session) this.#session = undefined;
      },
      onEraseAll: () => actions.execute("erase-all"),
      onPaste: () => actions.execute("paste", pasteInvocation),
      onEditText:
        textId === undefined || textEditing === undefined
          ? undefined
          : () => {
              if (textEditing.selectedId() === textId) textEditing.onEdit(textId);
            },
      ownerDocument: this.#options.ownerDocument,
      position: this.#options.toScreenPoint(position),
      restoreFocus,
      ...(returnFocus === undefined ? {} : { returnFocus }),
    });
    this.#session = session;
  }
}
