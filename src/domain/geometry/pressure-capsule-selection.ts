import type { PointV1 } from "../schema/types";
import type { PressureCapsule } from "./pressure-joins";

export type PressureCapsuleEndpoints = Pick<PressureCapsule, "start" | "end">;
interface DistanceQuadratic {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly radius: number;
  readonly radiusDelta: number;
}

export function pressureCapsuleContainsPoint(
  capsule: PressureCapsuleEndpoints,
  point: PointV1,
  tolerance = 0,
): boolean {
  return pressureCapsuleSegmentMargin(capsule, point, point, tolerance) <= 0;
}

/**
 * Exact squared-distance minus squared-radius minimum over the swept nib disks.
 * Projection onto a finite segment partitions the centerline into at most three
 * quadratic intervals. Tangency is zero; a strictly interior intersection is negative.
 */
export function pressureCapsuleSegmentMargin(
  capsule: PressureCapsuleEndpoints,
  start: PointV1,
  end: PointV1,
  tolerance = 0,
): number {
  const data: DistanceQuadratic = {
    x: start.x - capsule.start.center.x,
    y: start.y - capsule.start.center.y,
    dx: capsule.end.center.x - capsule.start.center.x,
    dy: capsule.end.center.y - capsule.start.center.y,
    radius: capsule.start.radius + tolerance,
    radiusDelta: capsule.end.radius - capsule.start.radius,
  };
  const x = end.x - start.x;
  const y = end.y - start.y;
  const lengthSquared = x * x + y * y;
  if (lengthSquared === 0) return minimum(data, 0, 1);
  const projection = -(data.x * x + data.y * y) / lengthSquared;
  const velocity = (data.dx * x + data.dy * y) / lengthSquared;
  const times = [0, 1];
  if (velocity !== 0) {
    for (const boundary of [0, 1]) {
      const time = (boundary - projection) / velocity;
      if (time > 0 && time < 1) times.push(time);
    }
  }
  times.sort((left, right) => left - right);
  let result = Infinity;
  for (let index = 1; index < times.length; index += 1) {
    const from = times[index - 1]!;
    const to = times[index]!;
    const middle = projection + velocity * ((from + to) / 2);
    const offset = middle <= 0 ? 0 : middle >= 1 ? 1 : projection;
    const slope = middle > 0 && middle < 1 ? velocity : 0;
    result = Math.min(
      result,
      minimum(
        {
          ...data,
          x: data.x + x * offset,
          y: data.y + y * offset,
          dx: data.dx - x * slope,
          dy: data.dy - y * slope,
        },
        from,
        to,
      ),
    );
  }
  return result;
}

function minimum(data: DistanceQuadratic, from: number, to: number): number {
  const quadratic = data.dx ** 2 + data.dy ** 2 - data.radiusDelta ** 2;
  let result = Math.min(value(data, from), value(data, to));
  if (quadratic > 0) {
    const stationary =
      (data.x * data.dx + data.y * data.dy + data.radius * data.radiusDelta) / quadratic;
    if (stationary > from && stationary < to) result = Math.min(result, value(data, stationary));
  }
  return result;
}

function value(data: DistanceQuadratic, time: number): number {
  return (
    (data.x - time * data.dx) ** 2 +
    (data.y - time * data.dy) ** 2 -
    (data.radius + time * data.radiusDelta) ** 2
  );
}
