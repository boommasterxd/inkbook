import { pressurePaintAdditionSteps, type PressurePaintQuery } from "./pressure-paint-additions";
import { effectiveStrokeWidth } from "../../domain/geometry/bounds";
import { pressureRadius } from "../../domain/geometry/pressure-radius";
import { strokeLocalGeometry, strokeWorldPoint } from "../../domain/geometry/stroke-position";
import { strokeCenterAt, type StrokeCenter } from "../../domain/geometry/stroke-path";
import {
  simplifyStrokeCenters,
  STROKE_SIMPLIFICATION_WINDOW,
} from "../../domain/geometry/stroke-simplification";
import type { PointV1, StrokeElementV1 } from "../../domain/schema/public";
import type { VisibleSelectionPrimitive } from "./selection-area-primitives";

/** Read and simplify bounded windows; selection needs only the swept nibs. */
export function* strokePrimitiveSteps(
  stroke: StrokeElementV1,
  query: PressurePaintQuery = {},
): Generator<VisibleSelectionPrimitive | number | undefined> {
  if (stroke.style.opacity <= 0) return;
  if (stroke.offset !== undefined) {
    const local = strokeLocalGeometry(stroke);
    for (const primitive of strokePrimitiveSteps(local, localPaintQuery(query, stroke.offset))) {
      yield primitive === undefined || typeof primitive === "number"
        ? primitive
        : translatedPrimitive(primitive, stroke.offset);
    }
    return;
  }
  const selected: StrokeCenter[] = [];
  const count = stroke.points.length / 3;
  let emitted = 0;
  for (let start = 0; start < count; start += STROKE_SIMPLIFICATION_WINDOW) {
    const end = Math.min(count - 1, start + STROKE_SIMPLIFICATION_WINDOW);
    const window: StrokeCenter[] = [];
    for (let index = start; index <= end; index += 1) {
      const center = strokeCenterAt(stroke.points, index, count);
      window.push({ ...strokeWorldPoint(stroke, center), pressure: center.pressure });
    }
    const simplified = simplifyStrokeCenters(
      window,
      stroke.style.width,
      stroke.style.pressureEnabled,
    );
    selected.push(...(start === 0 ? simplified : simplified.slice(1)));
    yield end - start + 1;
    const final = end === count - 1;
    const limit = selected.length - 1;
    while (emitted < limit) {
      yield strokeCapsule(stroke, selected[emitted]!, selected[emitted + 1]!);
      emitted += 1;
    }
    if (final) break;
  }
  if (selected.length === 1) yield strokeCapsule(stroke, selected[0]!, selected[0]!);
  yield* pressureAdditionPrimitives(stroke, selected, query);
}

function* pressureAdditionPrimitives(
  stroke: StrokeElementV1,
  centers: readonly StrokeCenter[],
  query: PressurePaintQuery,
): Generator<VisibleSelectionPrimitive | number | undefined> {
  if (!stroke.style.pressureEnabled) return;
  if (
    query.additionsMayTouch !== undefined &&
    !(yield* query.additionsMayTouch(centers, stroke.style.width))
  )
    return;
  for (const points of pressurePaintAdditionSteps(centers, stroke.style.width, query))
    yield points === undefined || typeof points === "number" ? points : { kind: "polygon", points };
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

function localPaintQuery(query: PressurePaintQuery, offset: PointV1): PressurePaintQuery {
  // Prepared windows are in world space; local pressure geometry must build its own windows.
  const additionsMayTouch = query.additionsMayTouch;
  return {
    ...(query.bounds === undefined
      ? {}
      : {
          bounds: {
            minX: query.bounds.minX - offset.x,
            minY: query.bounds.minY - offset.y,
            maxX: query.bounds.maxX - offset.x,
            maxY: query.bounds.maxY - offset.y,
          },
        }),
    ...(query.nearPoint === undefined
      ? {}
      : {
          nearPoint: {
            point: { x: query.nearPoint.point.x - offset.x, y: query.nearPoint.point.y - offset.y },
            radius: query.nearPoint.radius,
          },
        }),
    ...(additionsMayTouch === undefined
      ? {}
      : {
          additionsMayTouch: (centers: readonly StrokeCenter[], width: number) =>
            worldAdditionGuard(centers, width, offset, additionsMayTouch),
        }),
  };
}

function* worldAdditionGuard(
  centers: readonly StrokeCenter[],
  width: number,
  offset: PointV1,
  guard: NonNullable<PressurePaintQuery["additionsMayTouch"]>,
): Generator<number | undefined, boolean> {
  const world: StrokeCenter[] = [];
  for (const center of centers) {
    world.push({ ...center, x: center.x + offset.x, y: center.y + offset.y });
    if (world.length % 32 === 0) yield 32;
  }
  if (world.length % 32 !== 0) yield world.length % 32;
  return yield* guard(world, width);
}

function translatedPrimitive(
  primitive: VisibleSelectionPrimitive,
  offset: PointV1,
): VisibleSelectionPrimitive {
  const translate = (point: PointV1): PointV1 => ({ x: point.x + offset.x, y: point.y + offset.y });
  if (primitive.kind === "polygon")
    return { ...primitive, points: primitive.points.map(translate) };
  if (primitive.kind === "capsule")
    return {
      ...primitive,
      start: translate(primitive.start),
      end: translate(primitive.end),
    };
  const { start, end } = primitive.capsule;
  return {
    kind: "pressure-capsule",
    capsule: {
      start: { ...start, center: translate(start.center) },
      end: { ...end, center: translate(end.center) },
    },
  };
}
