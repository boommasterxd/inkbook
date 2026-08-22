import type {
  EditorTool,
  InputEffect,
  InputPoint,
  InputReduction,
  PointerSample,
  PreviewKind,
} from "../input/input-types";

export interface GesturePreview {
  update(pointer: PointerSample): void;
  commit(): boolean;
  revert(): void;
}

export interface GesturePreviewStart {
  readonly additive: boolean;
  readonly kind: PreviewKind;
  readonly pointer: PointerSample;
  readonly tool: EditorTool;
}

export interface GestureControllerPorts {
  beginPreview(start: GesturePreviewStart): GesturePreview;
  capturePointer(pointerId: number): void;
  releasePointer(pointerId: number): void;
  scheduleLongPress(pointerId: number, delayMs: number): void;
  cancelLongPress(pointerId: number): void;
  activateTemporaryEraser(previousTool: EditorTool): void;
  restoreTemporaryTool(tool: EditorTool): void;
  selectElement(elementId: string, mode: "add" | "preserve-or-replace" | "replace"): void;
  clearSelection(): void;
  scrollNote(screenDeltaX: number, screenDeltaY: number): void;
  panPage(screenDeltaX: number): void;
  revertNavigation(kind: "note-scroll" | "page-pan"): void;
  beginPinch(anchor: InputPoint, pointers: readonly [number, number]): void;
  updatePinch(anchor: InputPoint, factor: number): void;
  finishPinch(): void;
  revertPinch(): void;
  openContextMenu(source: "keyboard" | "pointer" | "touch", position: InputPoint): void;
}

export class GestureController {
  readonly #ports: GestureControllerPorts;
  #preview: { readonly kind: PreviewKind; readonly value: GesturePreview } | null = null;

  public constructor(ports: GestureControllerPorts) {
    this.#ports = ports;
  }

  public apply(reduction: InputReduction): void {
    for (const effect of reduction.effects) this.#applyEffect(effect);
  }

  public cancelActivePreview(): void {
    this.#preview?.value.revert();
    this.#preview = null;
  }

  #applyEffect(effect: InputEffect): void {
    if (
      effect.type === "begin-preview" ||
      effect.type === "update-preview" ||
      effect.type === "commit-preview" ||
      effect.type === "revert-preview"
    ) {
      this.#applyPreviewEffect(effect);
      return;
    }
    this.#applyNonPreviewEffect(effect);
  }

  #applyNonPreviewEffect(
    effect: Exclude<
      InputEffect,
      { type: "begin-preview" | "update-preview" | "commit-preview" | "revert-preview" }
    >,
  ): void {
    switch (effect.type) {
      case "capture-pointer":
        this.#ports.capturePointer(effect.pointerId);
        return;
      case "release-pointer":
        this.#ports.releasePointer(effect.pointerId);
        return;
      case "schedule-long-press":
        this.#ports.scheduleLongPress(effect.pointerId, effect.delayMs);
        return;
      case "cancel-long-press":
        this.#ports.cancelLongPress(effect.pointerId);
        return;
      case "activate-temporary-eraser":
        this.#ports.activateTemporaryEraser(effect.previousTool);
        return;
      case "restore-temporary-tool":
        this.#ports.restoreTemporaryTool(effect.tool);
        return;
      case "select-element":
        this.#ports.selectElement(effect.elementId, effect.mode);
        return;
      case "clear-selection":
        this.#ports.clearSelection();
        return;
      case "scroll-note":
        this.#ports.scrollNote(effect.screenDeltaX, effect.screenDeltaY);
        return;
      case "pan-page":
        this.#ports.panPage(effect.screenDeltaX);
        return;
      case "revert-navigation":
        this.#ports.revertNavigation(effect.kind);
        return;
      case "begin-pinch":
        this.#ports.beginPinch(effect.anchor, effect.pointers);
        return;
      case "update-pinch":
        this.#ports.updatePinch(effect.anchor, effect.factor);
        return;
      case "finish-pinch":
        this.#ports.finishPinch();
        return;
      case "revert-pinch":
        this.#ports.revertPinch();
        return;
      case "open-context-menu":
        this.#ports.openContextMenu(effect.source, effect.position);
        return;
    }
  }

  #applyPreviewEffect(
    effect: Extract<
      InputEffect,
      { type: "begin-preview" | "update-preview" | "commit-preview" | "revert-preview" }
    >,
  ): void {
    if (effect.type === "begin-preview") {
      this.cancelActivePreview();
      this.#preview = { kind: effect.kind, value: this.#ports.beginPreview(effect) };
      return;
    }
    const preview = this.#requirePreview(effect.kind);
    if (effect.type === "update-preview") {
      preview.update(effect.pointer);
      return;
    }
    this.#preview = null;
    if (effect.type === "commit-preview") preview.commit();
    else preview.revert();
  }

  #requirePreview(kind: PreviewKind): GesturePreview {
    if (this.#preview === null || this.#preview.kind !== kind) {
      throw new Error(`No active ${kind} preview.`);
    }
    return this.#preview.value;
  }
}
