import type { SvgPathPart } from "./svg-path-part";
import type { PointV1 } from "../schema/types";
import type { PressureBoundaryArc, PressureBoundaryLine } from "./pressure-joins";

export interface PressureWindow {
  readonly kind: "window";
  readonly additions: readonly (readonly PointV1[])[];
  readonly loops: readonly (readonly (PressureBoundaryLine | PressureBoundaryArc)[])[];
}

export interface PressureWindowMeasurement {
  readonly window: PressureWindow;
  readonly numericBytes: number;
}

/** A store-owned view scoped to one stroke geometry version. */
export interface PreparedPressureGeometryPort {
  readPath?(): readonly SvgPathPart[] | undefined;
  publishPath?(parts: readonly SvgPathPart[]): void;
  readWindow(windowIndex: number): PressureWindow | undefined;
  /** May return the measured numeric payload of this exact window. */
  publishWindow(windowIndex: number, window: PressureWindow): PressureWindowMeasurement | void;
}
