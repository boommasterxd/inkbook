import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import { strokeCenterWindow } from "../../domain/geometry/stroke-center-window";
import type { StrokeCenter } from "../../domain/geometry/stroke-path";
import { STROKE_SIMPLIFICATION_WINDOW } from "../../domain/geometry/stroke-simplification";
import type { StrokeElementV1 } from "../../domain/schema/public";

/** Demand one canonical window at a time, preserving the cheap early-hit path. */
export function selectionStrokeCenterWindow(
  stroke: StrokeElementV1,
  index: number,
  prepared?: PreparedPressureGeometryPort,
): readonly StrokeCenter[] {
  const retained = prepared?.readCenters?.(index);
  if (retained !== undefined) return retained;
  const centers = strokeCenterWindow(stroke, index);
  prepared?.publishCenters?.(index, centers);
  return centers;
}

export function selectionStrokeCenters(
  stroke: StrokeElementV1,
  prepared?: PreparedPressureGeometryPort,
): readonly StrokeCenter[] {
  const centers: StrokeCenter[] = [];
  const count = stroke.points.length / 3;
  for (let start = 0; start < count; start += STROKE_SIMPLIFICATION_WINDOW) {
    const window = selectionStrokeCenterWindow(
      stroke,
      start / STROKE_SIMPLIFICATION_WINDOW,
      prepared,
    );
    centers.push(...(start === 0 ? window : window.slice(1)));
    if (start + STROKE_SIMPLIFICATION_WINDOW >= count - 1) break;
  }
  return centers;
}
