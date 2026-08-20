import {
  INPUT_GESTURE_PROFILE_V1,
  isValidPointerSample,
  type PointerSample,
  type ScreenPoint,
} from "./gesture-profile";
import type { InputHit } from "./secondary-button-router";

export type OutsideTapSelectionResult = Readonly<{
  dismissSelection: boolean;
}>;

const UNCHANGED: OutsideTapSelectionResult = { dismissSelection: false };
const DISMISS: OutsideTapSelectionResult = { dismissSelection: true };
const PRIMARY_BUTTON = 0;

type Pending = Readonly<{
  origin: ScreenPoint;
  pointerId: number;
}>;

export type OutsideTapSelectionInput = PointerSample &
  Readonly<{
    button: number;
    hit: InputHit;
    pointerKind: "mouse" | "pen" | "touch";
    selectionActive: boolean;
  }>;

export class OutsideTapSelectionRecognizer {
  #disposed = false;
  #pending: Pending | undefined;

  pointerDown(sample: OutsideTapSelectionInput): OutsideTapSelectionResult {
    if (
      this.#disposed ||
      sample.pointerKind !== "touch" ||
      sample.button !== PRIMARY_BUTTON
    ) {
      return UNCHANGED;
    }
    if (this.#pending !== undefined) {
      this.#pending = undefined;
      return UNCHANGED;
    }
    if (!isValidPointerSample(sample)) return UNCHANGED;
    if (
      !sample.selectionActive ||
      sample.hit.kind === "plugin-element" ||
      sample.hit.kind === "plugin-handle"
    ) {
      return UNCHANGED;
    }
    this.#pending = {
      origin: { x: sample.clientX, y: sample.clientY },
      pointerId: sample.pointerId,
    };
    return UNCHANGED;
  }

  pointerMove(sample: PointerSample): OutsideTapSelectionResult {
    const pending = this.#pending;
    if (pending?.pointerId !== sample.pointerId) {
      return UNCHANGED;
    }
    if (!isValidPointerSample(sample)) {
      this.#pending = undefined;
      return UNCHANGED;
    }
    const dx = sample.clientX - pending.origin.x;
    const dy = sample.clientY - pending.origin.y;
    const slop = INPUT_GESTURE_PROFILE_V1.longPressMovementSlopScreenPx;
    if (dx * dx + dy * dy >= slop * slop) this.#pending = undefined;
    return UNCHANGED;
  }

  pointerUp(pointerId: number): OutsideTapSelectionResult {
    if (this.#pending?.pointerId !== pointerId) return UNCHANGED;
    this.#pending = undefined;
    return DISMISS;
  }

  pointerCancel(pointerId: number): OutsideTapSelectionResult {
    if (this.#pending?.pointerId === pointerId) this.#pending = undefined;
    return UNCHANGED;
  }

  hostClaimedGesture(): OutsideTapSelectionResult {
    this.#pending = undefined;
    return UNCHANGED;
  }

  dispose(): OutsideTapSelectionResult {
    this.#disposed = true;
    this.#pending = undefined;
    return UNCHANGED;
  }
}
