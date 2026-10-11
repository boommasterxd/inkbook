import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import { strokeWorldPoint } from "../../domain/geometry/stroke-position";
import { strokeCenterAt, type StrokeCenter } from "../../domain/geometry/stroke-path";
import {
  simplifyStrokeCenters,
  STROKE_SIMPLIFICATION_WINDOW,
} from "../../domain/geometry/stroke-simplification";
import type { StrokeElementV1 } from "../../domain/schema/public";

/** Demand one canonical window at a time, preserving the cheap early-hit path. */
export function selectionStrokeCenterWindow(
  stroke: StrokeElementV1,
  index: number,
  prepared?: PreparedPressureGeometryPort,
): readonly StrokeCenter[] {
  const retained = prepared?.readCenters?.(index);
  if (retained !== undefined) return retained;
  const count = stroke.points.length / 3;
  const start = index * STROKE_SIMPLIFICATION_WINDOW;
  const end = Math.min(count - 1, start + STROKE_SIMPLIFICATION_WINDOW);
  const window: StrokeCenter[] = [];
  for (let sample = start; sample <= end; sample += 1) {
    const center = strokeCenterAt(stroke.points, sample, count);
    window.push({ ...strokeWorldPoint(stroke, center), pressure: center.pressure });
  }
  const centers = simplifyStrokeCenters(window, stroke.style.width, stroke.style.pressureEnabled);
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
