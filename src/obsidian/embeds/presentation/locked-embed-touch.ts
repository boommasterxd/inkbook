import { Component } from "obsidian";

import { EMPTY_TOUCH_THRESHOLD_PX, LONG_PRESS_DELAY_MS } from "../../../editor/input/input-types";
import { ActiveEditorLongPressScheduler } from "../active-editor/input/long-press";

interface TouchOrigin {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

export interface LockedEmbedTouchOptions {
  readonly preview: HTMLElement;
  readonly available: () => boolean;
  readonly open: (position: { readonly x: number; readonly y: number }) => void;
}

/** Owns only the preview's context gesture; native scrolling remains host-owned. */
export class LockedEmbedTouch extends Component {
  readonly #options: LockedEmbedTouchOptions;
  readonly #scheduler: ActiveEditorLongPressScheduler;
  #origin: TouchOrigin | undefined;
  #gesture: Component | undefined;
  #suppressClick = false;

  public constructor(options: LockedEmbedTouchOptions) {
    super();
    this.#options = options;
    const ownerDocument = options.preview.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The locked embed has no owning window.");
    this.#scheduler = new ActiveEditorLongPressScheduler(ownerWindow);
    this.register(() => this.#scheduler.dispose());
    this.register(() => this.cancel());
    this.registerDomEvent(options.preview, "pointerdown", (event) => this.#down(event));
    this.registerDomEvent(options.preview, "click", (event) => this.#click(event), true);
    this.load();
  }

  public cancel(): void {
    const origin = this.#origin;
    if (origin === undefined) return;
    this.#finish();
    this.#suppressClick = true;
  }

  public consumeClick(): void {
    this.cancel();
    this.#suppressClick = true;
  }

  #down(event: PointerEvent): void {
    if (this.#origin !== undefined && event.pointerId !== this.#origin.pointerId) {
      this.cancel();
      return;
    }
    if (event.pointerType !== "touch") {
      this.#suppressClick = false;
      return;
    }
    if (
      !this.#options.available() ||
      event.isPrimary === false ||
      event.target === null ||
      !("nodeType" in event.target) ||
      !this.#options.preview.contains(event.target as Node)
    )
      return;
    this.#suppressClick = false;
    const origin = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.#origin = origin;
    this.#listenForGesture();
    this.#scheduler.schedule(event.pointerId, LONG_PRESS_DELAY_MS, () => {
      if (this.#origin !== origin || !this.#options.available()) return;
      this.#suppressClick = true;
      this.#options.open(origin);
    });
  }

  #listenForGesture(): void {
    this.#gesture?.unload();
    const gesture = new Component();
    const ownerDocument = this.#options.preview.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    gesture.registerDomEvent(
      ownerDocument,
      "pointerdown",
      (event) => {
        if (event.pointerId !== this.#origin?.pointerId) this.cancel();
      },
      true,
    );
    gesture.registerDomEvent(ownerDocument, "pointermove", (event) => this.#move(event), {
      passive: true,
    });
    gesture.registerDomEvent(ownerDocument, "pointerup", (event) => this.#end(event));
    gesture.registerDomEvent(ownerDocument, "pointercancel", () => this.cancel());
    gesture.registerDomEvent(ownerDocument, "scroll", () => this.cancel(), true);
    if (ownerWindow !== null) gesture.registerDomEvent(ownerWindow, "blur", () => this.cancel());
    gesture.load();
    this.#gesture = gesture;
  }

  #finish(): void {
    if (this.#origin !== undefined) this.#scheduler.cancel(this.#origin.pointerId);
    this.#origin = undefined;
    this.#gesture?.unload();
    this.#gesture = undefined;
  }

  #move(event: PointerEvent): void {
    const origin = this.#origin;
    if (origin === undefined || origin.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > EMPTY_TOUCH_THRESHOLD_PX)
      this.cancel();
  }

  #end(event: PointerEvent): void {
    if (this.#origin?.pointerId !== event.pointerId) return;
    this.#finish();
  }

  #click(event: MouseEvent): void {
    if (!this.#suppressClick || event.detail === 0) return;
    this.#suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
