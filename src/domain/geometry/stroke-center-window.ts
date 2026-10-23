import { MAX_STROKE_POINTS } from "../schema/constants";
import type { StrokeElementV1 } from "../schema/types";
import type { PressureCenter } from "./pressure/pressure-joins";
import { strokeWorldPoint } from "./stroke-position";
import { strokeCenterAt } from "./stroke-path";
import { simplifyStrokeCenters, STROKE_SIMPLIFICATION_WINDOW } from "./stroke-simplification";

interface CenterWindowOptions {
  readonly validate?: boolean;
  readonly first?: PressureCenter | undefined;
}

/** One canonical simplification window; its shared endpoint may already be prepared. */
export function strokeCenterWindow(
  stroke: StrokeElementV1,
  index: number,
  options: CenterWindowOptions = {},
): readonly PressureCenter[] {
  const count = stroke.points.length / 3;
  if (
    options.validate === true &&
    (!Number.isInteger(count) || count < 1 || count > MAX_STROKE_POINTS)
  )
    throw new RangeError(`Stroke samples must contain 1 through ${MAX_STROKE_POINTS} triples.`);
  const start = index * STROKE_SIMPLIFICATION_WINDOW;
  const end = Math.min(count - 1, start + STROKE_SIMPLIFICATION_WINDOW);
  const window: PressureCenter[] = options.first === undefined ? [] : [options.first];
  for (let sample = start + window.length; sample <= end; sample += 1) {
    if (options.validate === true) {
      for (let offset = sample * 3; offset < sample * 3 + 3; offset += 1) {
        if (!Number.isFinite(stroke.points[offset]))
          throw new RangeError("Stroke samples must be finite.");
      }
    }
    const center = strokeCenterAt(stroke.points, sample, count);
    window.push({ ...strokeWorldPoint(stroke, center), pressure: center.pressure });
  }
  return simplifyStrokeCenters(window, stroke.style.width, stroke.style.pressureEnabled);
}
