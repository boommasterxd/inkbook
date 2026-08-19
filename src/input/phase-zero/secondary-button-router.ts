import {
  INPUT_GESTURE_PROFILE_V1,
  isValidPointerSample,
  type PointerSample,
  type ScreenPoint,
} from "./gesture-profile";

export type InputHit =
  | Readonly<{ kind: "native-markdown" | "empty-note" }>
  | Readonly<{ kind: "plugin-element" | "plugin-handle"; elementId: string }>;

export type SecondaryButtonState =
  "idle" | "menu-pending" | "menu-awaiting-context" | "panning" | "disposed";

export type SecondaryPointerDown = PointerSample &
  Readonly<{
    button: number;
    hit: InputHit;
    zoomPercent: number;
    panRangeX: number;
    panRangeY: number;
  }>;

export type SecondaryButtonResult = Readonly<{
  action:
    | "none"
    | "pan-started"
    | "pan-updated"
    | "pan-ended"
    | "native-menu"
    | "plugin-menu"
    | "menu-suppressed";
  preventDefault: boolean;
  stopPropagation: boolean;
  capturePointerId?: number;
  releasePointerId?: number;
  frozenHit?: InputHit;
  panDeltaScreen?: ScreenPoint;
}>;

const NONE: SecondaryButtonResult = {
  action: "none",
  preventDefault: false,
  stopPropagation: false,
};

const SECONDARY_BUTTON = 2;
const DEFAULT_ZOOM_PERCENT = 100;

type Pending = Readonly<{
  pointerId: number;
  origin: ScreenPoint;
  hit: InputHit;
  canPan: boolean;
}>;

export class SecondaryButtonRouter {
  #state: SecondaryButtonState = "idle";
  #pending: Pending | undefined;
  #lastPoint: ScreenPoint | undefined;

  get state(): SecondaryButtonState {
    return this.#state;
  }

  pointerDown(event: SecondaryPointerDown): SecondaryButtonResult {
    if (
      this.#state !== "idle" ||
      event.button !== SECONDARY_BUTTON ||
      !isValidPointerSample(event) ||
      !isValidSnapshot(event)
    ) {
      return NONE;
    }
    this.#pending = {
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      hit: snapshotHit(event.hit),
      canPan:
        event.zoomPercent !== DEFAULT_ZOOM_PERCENT &&
        (event.panRangeX > 0 || event.panRangeY > 0),
    };
    this.#lastPoint = this.#pending.origin;
    this.#state = "menu-pending";
    return NONE;
  }

  pointerMove(event: PointerSample): SecondaryButtonResult {
    const pending = this.#pending;
    if (
      !isValidPointerSample(event) ||
      pending?.pointerId !== event.pointerId
    ) {
      return NONE;
    }
    const current = { x: event.clientX, y: event.clientY };
    if (this.#state === "panning") {
      const previous = this.#lastPoint ?? pending.origin;
      this.#lastPoint = current;
      return claimedPanResult("pan-updated", {
        x: current.x - previous.x,
        y: current.y - previous.y,
      });
    }
    if (this.#state !== "menu-pending" || !pending.canPan) {
      return NONE;
    }
    const dx = current.x - pending.origin.x;
    const dy = current.y - pending.origin.y;
    const slop = INPUT_GESTURE_PROFILE_V1.secondaryButtonPanSlopScreenPx;
    if (dx * dx + dy * dy < slop * slop) {
      return NONE;
    }
    this.#state = "panning";
    this.#lastPoint = current;
    return {
      ...claimedPanResult("pan-started", { x: dx, y: dy }),
      capturePointerId: pending.pointerId,
    };
  }

  pointerUp(pointerId: number): SecondaryButtonResult {
    const pending = this.#pending;
    if (pending?.pointerId !== pointerId) {
      return NONE;
    }
    if (this.#state === "panning") {
      this.#clear("idle");
      return {
        action: "pan-ended",
        preventDefault: true,
        stopPropagation: true,
        releasePointerId: pointerId,
      };
    }
    if (this.#state === "menu-pending") {
      this.#state = "menu-awaiting-context";
    }
    return NONE;
  }

  pointerCancel(pointerId: number): SecondaryButtonResult {
    const pending = this.#pending;
    if (pending?.pointerId !== pointerId) {
      return NONE;
    }
    const wasPanning = this.#state === "panning";
    this.#clear("idle");
    return wasPanning
      ? {
          action: "pan-ended",
          preventDefault: true,
          stopPropagation: true,
          releasePointerId: pointerId,
        }
      : NONE;
  }

  contextMenu(): SecondaryButtonResult {
    const pending = this.#pending;
    if (pending === undefined) {
      return NONE;
    }
    if (this.#state === "panning") {
      return {
        action: "menu-suppressed",
        preventDefault: true,
        stopPropagation: true,
      };
    }
    if (
      this.#state !== "menu-pending" &&
      this.#state !== "menu-awaiting-context"
    ) {
      return NONE;
    }
    const pluginOwned =
      pending.hit.kind === "plugin-element" ||
      pending.hit.kind === "plugin-handle";
    const result: SecondaryButtonResult = {
      action: pluginOwned ? "plugin-menu" : "native-menu",
      preventDefault: pluginOwned,
      stopPropagation: pluginOwned,
      frozenHit: pending.hit,
    };
    this.#clear("idle");
    return result;
  }

  dispose(): SecondaryButtonResult {
    if (this.#state === "disposed") {
      return NONE;
    }
    const captured =
      this.#state === "panning" ? this.#pending?.pointerId : undefined;
    this.#clear("disposed");
    return captured === undefined
      ? NONE
      : {
          action: "pan-ended",
          preventDefault: true,
          stopPropagation: true,
          releasePointerId: captured,
        };
  }

  #clear(nextState: SecondaryButtonState): void {
    this.#pending = undefined;
    this.#lastPoint = undefined;
    this.#state = nextState;
  }
}

function claimedPanResult(
  action: "pan-started" | "pan-updated",
  delta: ScreenPoint,
): SecondaryButtonResult {
  return {
    action,
    preventDefault: true,
    stopPropagation: true,
    panDeltaScreen: delta,
  };
}

function isValidSnapshot(event: SecondaryPointerDown): boolean {
  return (
    Number.isFinite(event.zoomPercent) &&
    event.zoomPercent > 0 &&
    Number.isFinite(event.panRangeX) &&
    event.panRangeX >= 0 &&
    Number.isFinite(event.panRangeY) &&
    event.panRangeY >= 0 &&
    (!("elementId" in event.hit) || event.hit.elementId.length > 0)
  );
}

function snapshotHit(hit: InputHit): InputHit {
  if (hit.kind === "plugin-element" || hit.kind === "plugin-handle") {
    return { kind: hit.kind, elementId: hit.elementId };
  }
  return { kind: hit.kind };
}
