import type { InkElementV1 } from "../../../domain/schema/public";
import type { Bounds } from "../../../domain/geometry/primitives";
import type { ElementFadeDirection } from "./element-fade-style";
import type { MotionVisual } from "./motion-visual";

export interface PendingElementFade {
  admittedDurationMs?: number;
  finish?: number;
  readonly bounds?: Bounds;
  readonly durationMs: number;
  readonly direction: ElementFadeDirection;
  readonly generation?: number;
  readonly exitVersion?: number;
  index: number;
}

export interface PendingSuppression {
  readonly ids: ReadonlySet<string>;
  readonly token: number;
}

interface MotionBase {
  readonly id: number;
  readonly ids: readonly string[];
  startTime: number | undefined;
}

interface EntranceMotion extends MotionBase {
  readonly kind: "entrance";
}

interface ExitMotion extends MotionBase {
  readonly kind: "exit";
  readonly visual: MotionVisual;
}

interface GeometryMotion extends MotionBase {
  current: readonly InkElementV1[];
  readonly from: readonly InkElementV1[];
  readonly kind: "geometry";
  readonly to: readonly InkElementV1[];
}

interface CrossfadeMotion extends MotionBase {
  readonly kind: "crossfade";
  readonly visual: MotionVisual;
}

export type MotionEntry = EntranceMotion | ExitMotion | GeometryMotion | CrossfadeMotion;

export interface OverlayMotion {
  startTime: number | undefined;
}

export type GeometryMotionEntry = GeometryMotion;
