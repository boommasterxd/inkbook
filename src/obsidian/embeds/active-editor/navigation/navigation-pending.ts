import {
  accumulateZoomInput,
  consumeWheelFrame,
  consumeZoomFrame,
  createWheelZoomState,
  createZoomFrameState,
  zoomFrameHasPending,
  type ZoomAnchor,
} from "../../../../editor/zoom/index";
import type { NavigationLayoutRead } from "./navigation-layout";
import { NavigationPinch } from "./navigation-pinch";

/** Owns the bounded input pending between centrally admitted navigation frames. */
export class NavigationPendingInput {
  public frame = createZoomFrameState();
  public continuous = createZoomFrameState();
  public wheel = createWheelZoomState();
  public readonly pinch = new NavigationPinch();
  public latestAnchor: ZoomAnchor | undefined;
  public anchorSource: ((layout: NavigationLayoutRead) => ZoomAnchor) | undefined;

  public get pending(): boolean {
    return (
      this.pinch.pending ||
      zoomFrameHasPending(this.continuous) ||
      Math.abs(this.wheel.pendingSteps) >= 1 ||
      zoomFrameHasPending(this.frame)
    );
  }

  public consumeFrame() {
    const wheel = consumeWheelFrame(this.wheel);
    this.wheel = wheel.state;
    if (wheel.frame.factor !== 1) {
      this.frame = accumulateZoomInput(this.frame, {
        factor: wheel.frame.factor,
        ...(this.latestAnchor === undefined ? {} : { anchor: this.latestAnchor }),
      });
    }
    const reduction = consumeZoomFrame(this.frame);
    this.frame = reduction.state;
    const frame = accumulateZoomInput(reduction.frame, this.continuous);
    this.continuous = createZoomFrameState();
    return frame;
  }

  public clear(): void {
    this.pinch.reset();
    this.continuous = createZoomFrameState();
    this.wheel = createWheelZoomState();
    this.frame = createZoomFrameState();
    this.latestAnchor = undefined;
    this.anchorSource = undefined;
  }
}
