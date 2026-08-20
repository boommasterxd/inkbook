import {
  INPUT_GESTURE_PROFILE_V1,
  isValidPointerSample,
  type PointerSample,
  type ScreenPoint,
  toScreenPoint,
} from "./gesture-profile";

export type TwoPointerZoomState =
  "idle" | "tracking-one" | "tracking-two" | "claimed" | "blocked" | "disposed";

export type TwoPointerZoomResult = Readonly<{
  handled: boolean;
  preventDefault: boolean;
  stopPropagation: boolean;
  capturePointerIds: readonly number[];
  releasePointerIds: readonly number[];
  zoom?: Readonly<{
    focalScreen: ScreenPoint;
    scaleFromStart: number;
    scaleDelta: number;
  }>;
}>;

const UNHANDLED: TwoPointerZoomResult = {
  handled: false,
  preventDefault: false,
  stopPropagation: false,
  capturePointerIds: [],
  releasePointerIds: [],
};

const MAX_TRACKED_POINTERS = 2;
const MAX_BLOCKED_POINTERS = 3;
const MIDPOINT_DIVISOR = 2;

type PairMetrics = Readonly<{
  distance: number;
  focal: ScreenPoint;
}>;

export class TwoPointerZoomRecognizer {
  readonly #pointers = new Map<number, ScreenPoint>();
  readonly #blockedPointerIds = new Set<number>();
  #state: TwoPointerZoomState = "idle";
  #initialDistance: number | undefined;
  #previousDistance: number | undefined;

  get state(): TwoPointerZoomState {
    return this.#state;
  }

  pointerDown(sample: PointerSample): TwoPointerZoomResult {
    if (this.#state === "disposed" || !isValidPointerSample(sample)) {
      return UNHANDLED;
    }
    if (this.#state === "blocked") {
      if (this.#blockedPointerIds.size < MAX_BLOCKED_POINTERS) {
        this.#blockedPointerIds.add(sample.pointerId);
      }
      return UNHANDLED;
    }
    if (this.#pointers.has(sample.pointerId)) {
      this.#pointers.set(sample.pointerId, toScreenPoint(sample));
      return UNHANDLED;
    }
    if (this.#pointers.size === MAX_TRACKED_POINTERS) {
      return this.#blockForAdditionalPointer(sample.pointerId);
    }

    this.#pointers.set(sample.pointerId, toScreenPoint(sample));
    if (this.#pointers.size === 1) {
      this.#state = "tracking-one";
      return UNHANDLED;
    }

    const metrics = this.#pairMetrics();
    if (metrics === undefined || metrics.distance === 0) {
      return this.#blockForInvalidPair();
    }
    this.#initialDistance = metrics.distance;
    this.#previousDistance = metrics.distance;
    this.#state = "tracking-two";
    return UNHANDLED;
  }

  pointerMove(sample: PointerSample): TwoPointerZoomResult {
    if (
      !isValidPointerSample(sample) ||
      !this.#pointers.has(sample.pointerId)
    ) {
      return UNHANDLED;
    }
    this.#pointers.set(sample.pointerId, toScreenPoint(sample));
    if (this.#state !== "tracking-two" && this.#state !== "claimed") {
      return UNHANDLED;
    }

    const metrics = this.#pairMetrics();
    const initial = this.#initialDistance;
    const previous = this.#previousDistance;
    if (
      metrics === undefined ||
      initial === undefined ||
      previous === undefined
    ) {
      return UNHANDLED;
    }
    const reachedSlop =
      Math.abs(metrics.distance - initial) >=
      INPUT_GESTURE_PROFILE_V1.pinchDistanceSlopScreenPx;
    if (this.#state === "tracking-two" && !reachedSlop) {
      this.#previousDistance = metrics.distance;
      return UNHANDLED;
    }

    const firstClaim = this.#state === "tracking-two";
    const scaleFromStart = metrics.distance / initial;
    this.#state = "claimed";
    this.#previousDistance = metrics.distance;
    return {
      handled: true,
      preventDefault: true,
      stopPropagation: true,
      capturePointerIds: firstClaim ? [...this.#pointers.keys()] : [],
      releasePointerIds: [],
      zoom: {
        focalScreen: metrics.focal,
        scaleFromStart,
        scaleDelta:
          firstClaim || previous === 0
            ? scaleFromStart
            : metrics.distance / previous,
      },
    };
  }

  pointerUp(pointerId: number): TwoPointerZoomResult {
    return this.#release(pointerId, false);
  }

  pointerCancel(pointerId: number): TwoPointerZoomResult {
    return this.#release(pointerId, true);
  }

  hostClaimedGesture(): TwoPointerZoomResult {
    return this.#reset(this.#state === "claimed");
  }

  dispose(): TwoPointerZoomResult {
    if (this.#state === "disposed") {
      return UNHANDLED;
    }
    const result = this.#reset(this.#state === "claimed");
    this.#state = "disposed";
    return result;
  }

  #release(pointerId: number, cancelled: boolean): TwoPointerZoomResult {
    if (this.#state === "blocked") {
      this.#blockedPointerIds.delete(pointerId);
      if (this.#blockedPointerIds.size === 0) this.#state = "idle";
      return UNHANDLED;
    }
    if (!Number.isSafeInteger(pointerId) || !this.#pointers.has(pointerId)) {
      return UNHANDLED;
    }
    const wasClaimed = this.#state === "claimed";
    const capturedIds = wasClaimed ? [...this.#pointers.keys()] : [];
    this.#pointers.delete(pointerId);
    if (wasClaimed || cancelled) {
      return this.#reset(wasClaimed, capturedIds);
    }
    this.#initialDistance = undefined;
    this.#previousDistance = undefined;
    this.#state = this.#pointers.size === 0 ? "idle" : "tracking-one";
    return UNHANDLED;
  }

  #blockForAdditionalPointer(
    additionalPointerId: number,
  ): TwoPointerZoomResult {
    const release = this.#state === "claimed" ? [...this.#pointers.keys()] : [];
    const handled = this.#state === "claimed";
    for (const pointerId of this.#pointers.keys()) {
      this.#blockedPointerIds.add(pointerId);
    }
    this.#blockedPointerIds.add(additionalPointerId);
    this.#pointers.clear();
    this.#initialDistance = undefined;
    this.#previousDistance = undefined;
    this.#state = "blocked";
    return {
      handled,
      preventDefault: handled,
      stopPropagation: handled,
      capturePointerIds: [],
      releasePointerIds: release,
    };
  }

  #blockForInvalidPair(): TwoPointerZoomResult {
    for (const pointerId of this.#pointers.keys()) {
      this.#blockedPointerIds.add(pointerId);
    }
    this.#pointers.clear();
    this.#initialDistance = undefined;
    this.#previousDistance = undefined;
    this.#state = "blocked";
    return UNHANDLED;
  }

  #reset(
    handled: boolean,
    releasePointerIds = handled ? [...this.#pointers.keys()] : [],
  ): TwoPointerZoomResult {
    this.#pointers.clear();
    this.#blockedPointerIds.clear();
    this.#initialDistance = undefined;
    this.#previousDistance = undefined;
    this.#state = "idle";
    return {
      handled,
      preventDefault: handled,
      stopPropagation: handled,
      capturePointerIds: [],
      releasePointerIds,
    };
  }

  #pairMetrics(): PairMetrics | undefined {
    const points = [...this.#pointers.values()];
    const first = points[0];
    const second = points[1];
    if (first === undefined || second === undefined) {
      return undefined;
    }
    return {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      focal: {
        x: (first.x + second.x) / MIDPOINT_DIVISOR,
        y: (first.y + second.y) / MIDPOINT_DIVISOR,
      },
    };
  }
}
