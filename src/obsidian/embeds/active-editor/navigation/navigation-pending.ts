import {
  accumulateWheelSteps,
  accumulateZoomInput,
  continuousWheelZoomFactor,
  consumeWheelFrame,
  consumeZoomFrame,
  createWheelZoomState,
  createZoomFrameState,
  zoomFrameHasPending,
  type ZoomAnchor,
} from "../../../../editor/zoom/index";
import { isContinuousZoomWheel, wheelZoomNormalization } from "./navigation-helpers";
import { wheelAnchor, type NavigationLayoutRead } from "./navigation-layout";
import { NavigationPinch } from "./navigation-pinch";
import type { ActiveEditorWheelInput } from "./navigation-types";

/** Owns the bounded input pending between centrally admitted navigation frames. */
export class NavigationPendingInput {
  public frame = createZoomFrameState();
  #continuous = createZoomFrameState();
  #wheel = createWheelZoomState();
  public readonly pinch = new NavigationPinch();
  public latestAnchor: ZoomAnchor | undefined;
  public anchorSource: ((layout: NavigationLayoutRead) => ZoomAnchor) | undefined;

  public get pending(): boolean {
    return (
      this.pinch.pending ||
      zoomFrameHasPending(this.#continuous) ||
      Math.abs(this.#wheel.pendingSteps) >= 1 ||
      zoomFrameHasPending(this.frame)
    );
  }

  public queueWheelZoom(event: ActiveEditorWheelInput, physicallyHeldModifier: boolean): void {
    const point = { clientX: event.clientX, clientY: event.clientY };
    this.anchorSource = (layout) => wheelAnchor(layout, point);
    if (isContinuousZoomWheel(event)) {
      this.#continuous = accumulateZoomInput(this.#continuous, {
        factor: continuousWheelZoomFactor(
          event.deltaY,
          wheelZoomNormalization(physicallyHeldModifier),
        ),
      });
    } else {
      this.#wheel = accumulateWheelSteps(this.#wheel, -Math.sign(event.deltaY));
    }
  }

  public consumeFrame() {
    if (this.#wheel.pendingSteps !== 0) {
      const wheel = consumeWheelFrame(this.#wheel);
      this.#wheel = wheel.state;
      if (wheel.frame.factor !== 1) {
        this.frame = accumulateZoomInput(this.frame, {
          factor: wheel.frame.factor,
          ...(this.latestAnchor === undefined ? {} : { anchor: this.latestAnchor }),
        });
      }
    }
    let frame = this.frame;
    if (frame.factor === 1) this.frame = createZoomFrameState();
    else {
      const reduction = consumeZoomFrame(frame);
      this.frame = reduction.state;
      frame = reduction.frame;
    }
    if (this.#continuous.factor === 1) return frame;
    frame = accumulateZoomInput(frame, this.#continuous);
    this.#continuous = createZoomFrameState();
    return frame;
  }

  public clear(): void {
    this.pinch.reset();
    this.#continuous = createZoomFrameState();
    this.#wheel = createWheelZoomState();
    this.frame = createZoomFrameState();
    this.latestAnchor = undefined;
    this.anchorSource = undefined;
  }
}
