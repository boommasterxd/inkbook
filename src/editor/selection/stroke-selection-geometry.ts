import { pressurePaintAdditionSteps, type PressurePaintQuery } from "./pressure-paint-additions";
import { effectiveStrokeWidth } from "../../domain/geometry/bounds";
import { pressureRadius } from "../../domain/geometry/pressure-radius";
import { rotatePointClockwise } from "../../domain/geometry/primitives";
import { strokeCenterAt, type StrokeCenter } from "../../domain/geometry/stroke-path";
import {
  simplifyStrokeCenters,
  STROKE_SIMPLIFICATION_WINDOW,
} from "../../domain/geometry/stroke-simplification";
import type { StrokeElementV1 } from "../../domain/schema/public";
import type { VisibleSelectionPrimitive } from "./selection-area-primitives";

/** Read and simplify bounded windows; selection needs only the swept nibs. */
export function* strokePrimitiveSteps(
  stroke: StrokeElementV1,
  query: PressurePaintQuery = {},
): Generator<VisibleSelectionPrimitive | undefined> {
  if (stroke.style.opacity <= 0) return;
  const selected: StrokeCenter[] = [];
  const count = stroke.points.length / 3;
  let emitted = 0;
  for (let start = 0; start < count; start += STROKE_SIMPLIFICATION_WINDOW) {
    const end = Math.min(count - 1, start + STROKE_SIMPLIFICATION_WINDOW);
    const window: StrokeCenter[] = [];
    for (let index = start; index <= end; index += 1) {
      const center = strokeCenterAt(stroke.points, index, count);
      window.push(
        stroke.rotation === 0
          ? center
          : {
              ...rotatePointClockwise(center, stroke.pivot, stroke.rotation),
              pressure: center.pressure,
            },
      );
    }
    const simplified = simplifyStrokeCenters(
      window,
      stroke.style.width,
      stroke.style.pressureEnabled,
    );
    selected.push(...(start === 0 ? simplified : simplified.slice(1)));
    yield undefined;
    const final = end === count - 1;
    const limit = selected.length - 1;
    while (emitted < limit) {
      yield strokeCapsule(stroke, selected[emitted]!, selected[emitted + 1]!);
      emitted += 1;
    }
    if (final) break;
  }
  if (selected.length === 1) yield strokeCapsule(stroke, selected[0]!, selected[0]!);
  if (stroke.style.pressureEnabled) {
    for (const points of pressurePaintAdditionSteps(selected, stroke.style.width, query))
      yield points === undefined ? undefined : { kind: "polygon", points };
  }
}

function strokeCapsule(
  stroke: StrokeElementV1,
  start: StrokeCenter,
  end: StrokeCenter,
): VisibleSelectionPrimitive {
  if (!stroke.style.pressureEnabled)
    return { kind: "capsule", start, end, radius: effectiveStrokeWidth(stroke) / 2 };
  return {
    kind: "pressure-capsule",
    capsule: {
      start: {
        center: start,
        radius: pressureRadius(start.pressure, stroke.style.width),
      },
      end: { center: end, radius: pressureRadius(end.pressure, stroke.style.width) },
    },
  };
}
