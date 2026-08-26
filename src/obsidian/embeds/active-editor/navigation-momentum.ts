import { HorizontalPanMomentum } from "../../../editor/zoom/index";

import type { ActiveEditorWheelInput } from "./navigation-types";
import {
  isTrackpadPanInput,
  TrackpadPanMomentum,
  type TrackpadPanInput,
} from "./trackpad-pan-momentum";

export class ActiveEditorPanMomentum {
  readonly #onRelease: () => void;
  readonly #touch = new HorizontalPanMomentum();
  readonly #trackpad: TrackpadPanMomentum;

  public constructor(ownerWindow: Window, onRelease: () => void) {
    this.#onRelease = onRelease;
    this.#trackpad = new TrackpadPanMomentum(ownerWindow);
  }

  public get active(): boolean {
    return this.#touch.active || this.#trackpad.active;
  }

  public advance(timestamp: number): number {
    return this.#touch.advance(timestamp) + this.#trackpad.advance(timestamp);
  }

  public cancel(): void {
    this.#touch.cancel();
    this.#trackpad.cancel();
  }

  public cancelTouch(): void {
    this.#touch.cancel();
  }

  public cancelTrackpad(): void {
    this.#trackpad.cancel();
  }

  public prepareWheel(zoomWheel: boolean): void {
    if (zoomWheel) this.cancel();
    else this.cancelTouch();
  }

  public recordTouch(screenDeltaX: number, timestamp: number): void {
    this.#touch.record(screenDeltaX, timestamp);
  }

  public releaseTouch(timestamp: number, enabled: boolean): void {
    if (enabled && this.#touch.release(timestamp)) {
      this.#onRelease();
      return;
    }
    this.cancel();
  }

  public trackpadWheelDelta(
    screenDeltaX: number,
    event: ActiveEditorWheelInput,
  ): number | undefined {
    const input: TrackpadPanInput = {
      deltaMode: event.deltaMode,
      shiftKey: event.shiftKey === true,
    };
    return isTrackpadPanInput(input) ? this.#trackpad.record(screenDeltaX) : undefined;
  }

  public transferOwnerWindow(ownerWindow: Window): void {
    this.#touch.cancel();
    this.#trackpad.transferClock(ownerWindow);
  }
}
