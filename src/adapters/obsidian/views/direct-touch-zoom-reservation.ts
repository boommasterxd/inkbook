import { TwoPointerZoomRecognizer } from "../../../input/phase-zero";

import type { Disposable } from "./contracts";

export interface DirectTouchZoomReservationOptions {
  readonly gestureClaimed: () => void;
  readonly releaseMoveStream: () => void;
  readonly reserveMoveStream: () => boolean;
  readonly scale: (scaleDelta: number) => void;
}

export class DirectTouchZoomReservation implements Disposable {
  readonly #recognizer = new TwoPointerZoomRecognizer();
  #disposed = false;
  #hostOwned = false;
  #reserved = false;

  public constructor(
    private readonly options: DirectTouchZoomReservationOptions,
  ) {}

  public touchStart(event: TouchEvent): void {
    if (this.#disposed || this.#hostOwned) return;
    this.#visitChangedTouches(event, (identifier, clientX, clientY) => {
      this.#publish(
        this.#recognizer.pointerDown({
          pointerId: identifier,
          clientX,
          clientY,
        }),
        event,
      );
    });
    if (this.#recognizer.state !== "tracking-two") return;
    if (event.defaultPrevented || !event.cancelable) {
      this.#yieldToHost();
      return;
    }
    event.preventDefault();
    if (!this.options.reserveMoveStream()) {
      this.#yieldToHost();
      return;
    }
    this.#reserved = true;
  }

  public touchMove(event: TouchEvent): void {
    if (this.#disposed || !this.#reserved) return;
    event.preventDefault();
    if (!event.defaultPrevented) {
      this.#yieldToHost();
      return;
    }
    this.#visitChangedTouches(event, (identifier, clientX, clientY) => {
      this.#publish(
        this.#recognizer.pointerMove({
          pointerId: identifier,
          clientX,
          clientY,
        }),
        event,
      );
    });
  }

  public touchEnd(event: TouchEvent): void {
    if (this.#disposed) return;
    if (this.#hostOwned) {
      if (event.touches.length === 0) this.#hostOwned = false;
      return;
    }
    this.#visitChangedTouches(event, (identifier) => {
      this.#publish(this.#recognizer.pointerUp(identifier), event);
    });
    if (
      this.#recognizer.state !== "tracking-two" &&
      this.#recognizer.state !== "claimed"
    ) {
      this.#releaseReservation();
    }
  }

  public touchCancel(event: TouchEvent): void {
    if (this.#disposed) return;
    if (this.#hostOwned) {
      if (event.touches.length === 0) this.#hostOwned = false;
      return;
    }
    this.#visitChangedTouches(event, (identifier) => {
      this.#publish(this.#recognizer.pointerCancel(identifier), event);
    });
    this.#releaseReservation();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#publish(this.#recognizer.dispose(), undefined);
    this.#releaseReservation();
    this.#hostOwned = false;
  }

  #releaseReservation(): void {
    if (!this.#reserved) return;
    this.#reserved = false;
    this.options.releaseMoveStream();
  }

  #publish(
    result: ReturnType<TwoPointerZoomRecognizer["pointerMove"]>,
    event: TouchEvent | undefined,
  ): void {
    if (result.preventDefault) event?.preventDefault();
    if (result.stopPropagation) event?.stopPropagation();
    if (result.handled) this.options.gestureClaimed();
    if (result.zoom !== undefined) this.options.scale(result.zoom.scaleDelta);
  }

  #visitChangedTouches(
    event: TouchEvent,
    visit: (identifier: number, clientX: number, clientY: number) => void,
  ): void {
    for (let index = 0; index < event.changedTouches.length; index += 1) {
      const touch = event.changedTouches.item(index);
      if (touch !== null) {
        visit(touch.identifier, touch.clientX, touch.clientY);
      }
    }
  }

  #yieldToHost(): void {
    this.#publish(this.#recognizer.hostClaimedGesture(), undefined);
    this.#releaseReservation();
    this.#hostOwned = true;
  }
}
