import { HorizontalPanMomentum } from "../../../../editor/zoom/index";
import { TrackpadPanMomentum, trackpadPanSampleTime } from "./trackpad-pan-momentum";
import type { ActiveEditorWheelInput } from "./navigation-types";

export class ActiveEditorPanMomentum {
  readonly #onRelease: () => void;
  readonly #now: () => number;
  readonly #touch = new HorizontalPanMomentum();
  readonly #trackpad = new TrackpadPanMomentum();

  public constructor(onRelease: () => void, now: () => number) {
    this.#onRelease = onRelease;
    this.#now = now;
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

  public recordWheel(screenDeltaX: number, event: ActiveEditorWheelInput): void {
    this.#touch.cancel();
    if (event.deltaMode !== 0 || event.shiftKey === true) {
      this.#trackpad.cancel();
      return;
    }
    const timestamp = trackpadPanSampleTime(event.timeStamp, this.#now());
    this.#trackpad.record(screenDeltaX, timestamp, event.cancelable !== false);
  }

  public recordTouch(screenDeltaX: number, timestamp: number): void {
    this.#trackpad.cancel();
    this.#touch.record(screenDeltaX, timestamp);
  }

  public releaseTouch(timestamp: number, enabled: boolean): void {
    if (enabled && this.#touch.release(timestamp)) {
      this.#onRelease();
      return;
    }
    this.cancel();
  }
}
