import {
  INPUT_GESTURE_PROFILE_V1,
  isValidPointerSample,
  type PointerSample,
  type ScreenPoint,
} from "./gesture-profile";
import type { InputHit } from "./secondary-button-router";

export type TouchLongPressState =
  "idle" | "pending" | "recognized" | "disposed";

export type TouchLongPressInput = PointerSample &
  Readonly<{
    button: number;
    hit: InputHit;
    pointerKind: "mouse" | "pen" | "touch";
  }>;

export type TouchLongPressResult = Readonly<{
  action: "none" | "schedule" | "open-menu" | "suppress-native-menu";
  cancelTimer: boolean;
  preventDefault: boolean;
  stopPropagation: boolean;
  delayMs?: number;
  frozenHit?: Extract<InputHit, { readonly elementId: string }>;
  position?: ScreenPoint;
}>;

const NONE: TouchLongPressResult = {
  action: "none",
  cancelTimer: false,
  preventDefault: false,
  stopPropagation: false,
};

const PRIMARY_BUTTON = 0;
const MAX_ACTIVE_POINTERS = 2;

type Pending = Readonly<{
  pointerId: number;
  origin: ScreenPoint;
  hit: Extract<InputHit, { readonly elementId: string }>;
}>;

export class TouchLongPressRecognizer {
  readonly #activePointerIds = new Set<number>();
  #state: TouchLongPressState = "idle";
  #pending: Pending | undefined;

  get state(): TouchLongPressState {
    return this.#state;
  }

  pointerDown(input: TouchLongPressInput): TouchLongPressResult {
    if (
      this.#state === "disposed" ||
      input.pointerKind !== "touch" ||
      input.button !== PRIMARY_BUTTON
    ) {
      return NONE;
    }
    if (!isValidPointerSample(input)) return NONE;
    if (this.#state === "pending") {
      if (this.#activePointerIds.has(input.pointerId)) return NONE;
      if (this.#activePointerIds.size >= MAX_ACTIVE_POINTERS) {
        return this.#cancel();
      }
      this.#activePointerIds.add(input.pointerId);
      return NONE;
    }
    if (this.#state !== "idle") return NONE;
    if (
      input.hit.kind !== "plugin-element" &&
      input.hit.kind !== "plugin-handle"
    ) {
      return NONE;
    }
    this.#pending = {
      hit: { elementId: input.hit.elementId, kind: input.hit.kind },
      origin: { x: input.clientX, y: input.clientY },
      pointerId: input.pointerId,
    };
    this.#activePointerIds.add(input.pointerId);
    this.#state = "pending";
    return {
      ...NONE,
      action: "schedule",
      delayMs: INPUT_GESTURE_PROFILE_V1.longPressDelayMs,
    };
  }

  pointerMove(sample: PointerSample): TouchLongPressResult {
    const pending = this.#pending;
    if (this.#state !== "pending" || pending?.pointerId !== sample.pointerId) {
      return NONE;
    }
    if (!isValidPointerSample(sample)) return this.#cancel();
    const dx = sample.clientX - pending.origin.x;
    const dy = sample.clientY - pending.origin.y;
    const slop = INPUT_GESTURE_PROFILE_V1.longPressMovementSlopScreenPx;
    return dx * dx + dy * dy >= slop * slop ? this.#cancel() : NONE;
  }

  pointerUp(pointerId: number): TouchLongPressResult {
    return this.#finish(pointerId);
  }

  pointerCancel(pointerId: number): TouchLongPressResult {
    return this.#finish(pointerId);
  }

  hostClaimedGesture(): TouchLongPressResult {
    return this.#state === "pending" ? this.#cancel() : NONE;
  }

  timerElapsed(): TouchLongPressResult {
    const pending = this.#pending;
    if (this.#state !== "pending" || pending === undefined) return NONE;
    this.#state = "recognized";
    return this.#menuResult("open-menu", false);
  }

  contextMenu(): TouchLongPressResult {
    if (this.#state === "pending") {
      return this.#menuResult("suppress-native-menu", false);
    }
    return this.#state === "recognized"
      ? this.#menuResult("suppress-native-menu", false)
      : NONE;
  }

  dispose(): TouchLongPressResult {
    if (this.#state === "disposed") return NONE;
    const result = this.#state === "pending" ? this.#cancel() : NONE;
    this.#state = "disposed";
    this.#pending = undefined;
    this.#activePointerIds.clear();
    return result;
  }

  #finish(pointerId: number): TouchLongPressResult {
    this.#activePointerIds.delete(pointerId);
    if (this.#pending?.pointerId !== pointerId) return NONE;
    if (this.#state === "pending") return this.#cancel();
    this.#pending = undefined;
    this.#activePointerIds.clear();
    this.#state = "idle";
    return NONE;
  }

  #cancel(): TouchLongPressResult {
    this.#pending = undefined;
    this.#activePointerIds.clear();
    this.#state = "idle";
    return { ...NONE, cancelTimer: true };
  }

  #menuResult(
    action: "open-menu" | "suppress-native-menu",
    cancelTimer: boolean,
  ): TouchLongPressResult {
    const pending = this.#pending;
    return pending === undefined
      ? NONE
      : {
          action,
          cancelTimer,
          preventDefault: true,
          stopPropagation: true,
          frozenHit: pending.hit,
          position: pending.origin,
        };
  }
}
