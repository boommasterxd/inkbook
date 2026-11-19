import type { ImageCropV3 } from "../../domain/schema/public";
import type { Translator } from "../../domain/localization";
import { ImageCropDraft, type ImageCropEdge } from "./image-crop-draft";

type CropHandle = "move" | readonly ImageCropEdge[];

interface CropDrag {
  readonly pointer: number;
  readonly start: { readonly x: number; readonly y: number };
  readonly crop: ImageCropV3;
  readonly target: HTMLElement;
  readonly handle: CropHandle;
}

/** Source-pixel feedback is immediate while the surrounding editor owns presentation. */
export class ImageCropHandles {
  readonly #release: Array<() => void> = [];
  readonly #buttons: HTMLButtonElement[] = [];
  #drag: CropDrag | undefined;

  public constructor(
    private readonly options: {
      readonly outline: HTMLElement;
      readonly grips: HTMLElement;
      readonly draft: ImageCropDraft;
      readonly t: Translator;
      readonly sourcePoint: (event: Pick<PointerEvent, "clientX" | "clientY">) => {
        x: number;
        y: number;
      };
      readonly update: () => void;
    },
  ) {
    const move = this.#handle("move");
    this.#bindPointer(options.outline, move, "move");
    for (const edges of [
      ["left"],
      ["top"],
      ["right"],
      ["bottom"],
      ["left", "top"],
      ["right", "top"],
      ["right", "bottom"],
      ["left", "bottom"],
    ] as const)
      this.#handle(edges);
  }

  #listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    event: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(event, listener);
    this.#release.push(() => target.removeEventListener(event, listener));
  }

  #handle(handle: CropHandle): HTMLButtonElement {
    const { grips, t } = this.options;
    const button = grips.ownerDocument.createElement("button");
    button.className = "inkbook-image-crop-handle";
    grips.append(button);
    this.#buttons.push(button);
    button.type = "button";
    button.dataset.edges = handle === "move" ? handle : handle.join(" ");
    if (handle === "move") button.classList.add("inkbook-image-crop-move");
    button.setAttribute(
      "aria-label",
      handle === "move"
        ? t("images.moveCrop")
        : t("images.handle", { edges: handle.map((edge) => t(`images.${edge}`)).join(", ") }),
    );
    this.#bindPointer(button, button, handle);
    this.#listen(button, "keydown", (event) => this.#key(handle, event));
    return button;
  }

  #bindPointer(target: HTMLElement, button: HTMLButtonElement, handle: CropHandle): void {
    this.#listen(target, "pointerdown", (event) => this.#start(target, button, handle, event));
    this.#listen(target, "pointermove", (event) => this.#move(event));
    this.#listen(target, "pointerup", (event) => this.#terminal(event, false));
    this.#listen(target, "pointercancel", (event) => this.#terminal(event, true));
    this.#listen(target, "lostpointercapture", (event) => this.#terminal(event, true));
  }

  #start(
    target: HTMLElement,
    button: HTMLButtonElement,
    handle: CropHandle,
    event: PointerEvent,
  ): void {
    if (event.button !== 0 || this.#drag !== undefined) return;
    event.preventDefault();
    event.stopPropagation();
    button.focus({ preventScroll: true });
    this.#drag = {
      pointer: event.pointerId,
      start: this.options.sourcePoint(event),
      crop: { ...this.options.draft.crop },
      target,
      handle,
    };
    target.setPointerCapture(event.pointerId);
  }

  #apply(handle: CropHandle, dx: number, dy: number): void {
    const { draft } = this.options;
    if (handle === "move") draft.move(dx, dy);
    else
      for (const edge of handle) {
        const horizontal = edge === "left" || edge === "right";
        draft.set(edge, draft.edge(edge) + (horizontal ? dx : dy));
      }
    this.options.update();
  }

  #move(event: PointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = this.options.sourcePoint(event);
    this.options.draft.replace(drag.crop);
    this.#apply(
      drag.handle,
      Math.round(point.x - drag.start.x),
      Math.round(point.y - drag.start.y),
    );
  }

  #key(handle: CropHandle, event: KeyboardEvent): void {
    const movement: Record<string, readonly [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const delta = movement[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    this.#apply(handle, delta[0] * step, delta[1] * step);
  }

  #terminal(event: PointerEvent, cancelled: boolean): void {
    if (this.#drag?.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!cancelled) this.#move(event);
    this.#end(cancelled);
  }

  #end(cancelled: boolean): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#drag = undefined;
    if (cancelled) {
      this.options.draft.replace(drag.crop);
      this.options.update();
    }
    if (drag.target.hasPointerCapture(drag.pointer))
      drag.target.releasePointerCapture(drag.pointer);
  }

  public dispose(): void {
    this.#end(true);
    for (const release of this.#release) release();
    for (const button of this.#buttons) button.remove();
    this.#release.length = 0;
    this.#buttons.length = 0;
  }
}
