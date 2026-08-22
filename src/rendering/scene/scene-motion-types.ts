import type { InkElementV1 } from "../../domain/schema/public";
import type { MotionVisual } from "./motion-visual";

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
  readonly direction: "enter" | "exit";
  startTime: number | undefined;
}

export type GeometryMotionEntry = GeometryMotion;
