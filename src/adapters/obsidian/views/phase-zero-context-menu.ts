import { Menu } from "obsidian";

import {
  normalizePointerKind,
  TouchLongPressRecognizer,
  type InputHit,
  type TouchLongPressResult,
} from "../../../input/phase-zero";
import type { Disposable } from "./contracts";

export class PhaseZeroContextMenuController implements Disposable {
  readonly #document: Document;
  readonly #marker: SVGCircleElement;
  readonly #recognizer = new TouchLongPressRecognizer();
  readonly #window: Window;
  #disposed = false;
  #timer: number | undefined;

  public constructor(
    window: Window,
    document: Document,
    marker: SVGCircleElement,
  ) {
    this.#window = window;
    this.#document = document;
    this.#marker = marker;
  }

  public pointerDown(event: PointerEvent, hit: InputHit): void {
    this.#apply(
      this.#recognizer.pointerDown({
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        hit,
        pointerId: event.pointerId,
        pointerKind: normalizePointerKind(event.pointerType),
      }),
      event,
    );
  }

  public pointerMove(event: PointerEvent): void {
    this.#apply(this.#recognizer.pointerMove(event), event);
  }

  public pointerUp(event: PointerEvent): void {
    this.#apply(this.#recognizer.pointerUp(event.pointerId), event);
  }

  public pointerCancel(event: PointerEvent): void {
    this.#apply(this.#recognizer.pointerCancel(event.pointerId), event);
  }

  public hostClaimedGesture(): void {
    this.#apply(this.#recognizer.hostClaimedGesture(), undefined);
  }

  public contextMenu(event: MouseEvent): boolean {
    const result = this.#recognizer.contextMenu();
    this.#apply(result, event);
    return (
      result.action === "open-menu" || result.action === "suppress-native-menu"
    );
  }

  public showPointerMenu(event: MouseEvent): void {
    this.#createMenu().showAtMouseEvent(event);
  }

  public keyDown(event: KeyboardEvent): void {
    if (event.key !== "F10" || !event.shiftKey) return;
    const target = readPluginTarget(event.target);
    if (target === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = target.getBoundingClientRect();
    this.#showAtPosition({ x: bounds.left, y: bounds.bottom });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#apply(this.#recognizer.dispose(), undefined);
    this.#clearTimer();
  }

  #apply(result: TouchLongPressResult, event: Event | undefined): void {
    if (result.cancelTimer) this.#clearTimer();
    if (result.preventDefault) event?.preventDefault();
    if (result.stopPropagation) event?.stopPropagation();
    if (result.action === "schedule" && result.delayMs !== undefined) {
      this.#schedule(result.delayMs);
    }
    if (result.action === "open-menu" && result.position !== undefined) {
      this.#showAtPosition(result.position);
    }
  }

  #schedule(delayMs: number): void {
    this.#clearTimer();
    this.#timer = this.#window.setTimeout(() => {
      this.#timer = undefined;
      if (!this.#disposed) {
        this.#apply(this.#recognizer.timerElapsed(), undefined);
      }
    }, delayMs);
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#window.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #showAtPosition(position: Readonly<{ x: number; y: number }>): void {
    const menu = this.#createMenu();
    menu.onHide(() => {
      if (!this.#disposed && this.#marker.isConnected) {
        this.#marker.focus({ preventScroll: true });
      }
    });
    menu.showAtPosition(position, this.#document);
  }

  #createMenu(): Menu {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Phase 0 annotation probe")
        .setIcon("check-circle")
        .setDisabled(true),
    );
    return menu;
  }
}

function readPluginTarget(target: EventTarget | null): Element | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const candidate = target as {
    closest?: (selector: string) => Element | null;
  };
  return candidate.closest?.("[data-inkbook-element-id]") ?? undefined;
}
