import {
  openContextMenu,
  type ContextMenuSession,
  type FocusTargetPort,
  type MenuFactoryPort,
} from "../../menus/index";
import type { ArrangeAction } from "../../../domain/commands/arrange";
import type { InputPoint } from "../../../editor/input/index";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { ActiveEditorActions } from "./controller-actions";

interface ActiveEditorMenuOptions {
  readonly event?: MouseEvent;
  readonly factory: MenuFactoryPort;
  readonly inputSurface: SvgSceneRenderer["inputSurface"];
  readonly ownerDocument: Document;
  readonly position: InputPoint;
  readonly returnFocus?: FocusTargetPort;
  readonly canEraseAll: boolean;
  readonly canPaste: boolean;
  readonly arrangeAvailability: Readonly<Record<ArrangeAction, boolean>>;
  readonly hasSelection: boolean;
  readonly onCopy: () => void;
  readonly onCut: () => void;
  readonly onDelete: () => void;
  readonly onEraseAll: () => void;
  readonly onCopyEmbed: () => void;
  readonly onDeleteEmbed: () => void;
  readonly onArrange: (action: ArrangeAction) => void;
  readonly onPaste: () => void;
}

function openActiveEditorMenu(options: ActiveEditorMenuOptions): ContextMenuSession {
  const invocation =
    options.event === undefined
      ? {
          type: "position" as const,
          canvasInputSurface: options.inputSurface,
          ownerDocument: options.ownerDocument,
          position: options.position,
          ...(options.returnFocus === undefined ? {} : { returnFocus: options.returnFocus }),
        }
      : {
          type: "event" as const,
          canvasInputSurface: options.inputSurface,
          event: options.event,
          ownerDocument: options.ownerDocument,
          ...(options.returnFocus === undefined ? {} : { returnFocus: options.returnFocus }),
        };
  return openContextMenu(
    options.factory,
    invocation,
    {
      canBringForward: options.arrangeAvailability["bring-forward"],
      canBringToFront: options.arrangeAvailability["bring-to-front"],
      canCopyEmbed: true,
      canDeleteEmbed: true,
      canEraseAll: options.canEraseAll,
      canPaste: options.canPaste,
      canSendBackward: options.arrangeAvailability["send-backward"],
      canSendToBack: options.arrangeAvailability["send-to-back"],
      hasSelection: options.hasSelection,
    },
    {
      bringForward: () => options.onArrange("bring-forward"),
      bringToFront: () => options.onArrange("bring-to-front"),
      copy: options.onCopy,
      copyEmbed: options.onCopyEmbed,
      cut: options.onCut,
      delete: options.onDelete,
      deleteEmbed: options.onDeleteEmbed,
      eraseAll: options.onEraseAll,
      paste: options.onPaste,
      sendBackward: () => options.onArrange("send-backward"),
      sendToBack: () => options.onArrange("send-to-back"),
    },
  );
}

export interface ActiveEditorMenuControllerOptions {
  readonly actions: ActiveEditorActions;
  readonly factory: MenuFactoryPort;
  readonly inputSurface: SvgSceneRenderer["inputSurface"];
  readonly ownerDocument: Document;
  readonly selectionSize: () => number;
  readonly storeSize: () => number;
  readonly toScreenPoint: (point: InputPoint) => InputPoint;
  readonly visibleSelectionCenter?: () => InputPoint | null;
}

export class ActiveEditorMenuController {
  readonly #options: ActiveEditorMenuControllerOptions;
  #event: MouseEvent | undefined;
  #openGeneration = 0;
  #session: ContextMenuSession | undefined;

  public constructor(options: ActiveEditorMenuControllerOptions) {
    this.#options = options;
  }

  public dispose(): void {
    this.#openGeneration += 1;
    this.#session?.close();
    this.#session = undefined;
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
    this.open(resolvedPosition, source === "pointer" ? this.#event : undefined);
  }

  public openFromToolbar(position: InputPoint, trigger: Element | null): void {
    this.open(position, undefined, overflowButton(trigger));
  }

  public open(position: InputPoint, event?: MouseEvent, returnFocus?: FocusTargetPort): void {
    this.dispose();
    const generation = this.#openGeneration;
    if (this.#options.actions.canPaste) {
      this.#openNow(position, event, returnFocus, generation);
      return;
    }
    void this.#options.actions.refreshPasteAvailability().then(() => {
      this.#openNow(position, event, returnFocus, generation);
    });
  }

  #openNow(
    position: InputPoint,
    event: MouseEvent | undefined,
    returnFocus: FocusTargetPort | undefined,
    generation: number,
  ): void {
    if (generation !== this.#openGeneration) return;
    const actions = this.#options.actions;
    this.#session = openActiveEditorMenu({
      arrangeAvailability: actions.arrangeAvailability(),
      canEraseAll: this.#options.storeSize() > 0,
      canPaste: actions.canPaste,
      ...(event === undefined ? {} : { event }),
      factory: this.#options.factory,
      hasSelection: this.#options.selectionSize() > 0,
      inputSurface: this.#options.inputSurface,
      onArrange: (action) => actions.execute(action),
      onCopy: () => actions.execute("copy"),
      onCopyEmbed: () => actions.execute("copy-embed"),
      onCut: () => actions.execute("cut"),
      onDelete: () => actions.execute("delete"),
      onDeleteEmbed: () => actions.execute("delete-embed"),
      onEraseAll: () => actions.execute("erase-all"),
      onPaste: () => actions.execute("paste", { kind: "context-menu", invocationPoint: position }),
      ownerDocument: this.#options.ownerDocument,
      position: this.#options.toScreenPoint(position),
      ...(returnFocus === undefined ? {} : { returnFocus }),
    });
  }
}

function overflowButton(element: Element | null): FocusTargetPort | undefined {
  if (element?.getAttribute("data-inkbook-action") !== "overflow") return undefined;
  return "focus" in element ? (element as FocusTargetPort) : undefined;
}
