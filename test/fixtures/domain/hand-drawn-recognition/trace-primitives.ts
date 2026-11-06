import type { TracePoint } from "./types";

export interface TraceStyle {
  wave?: number;
  uneven?: boolean;
  rounded?: number;
  phase?: number;
}

const HAND_WAVES = [0, 0.48, -0.31, 0.83, 0.24, -0.57, 0.19, 0];

function waveAt(t: number, phase: number): number {
  const position = t * (HAND_WAVES.length - 1);
  const index = Math.min(HAND_WAVES.length - 2, Math.floor(position));
  const blend = position - index;
  const sign = phase % 2 === 0 ? 1 : -1;
  return sign * (HAND_WAVES[index]! * (1 - blend) + HAND_WAVES[index + 1]! * blend);
}

export function tracePolyline(
  vertices: readonly TracePoint[],
  style: TraceStyle = {},
): TracePoint[] {
  const result: TracePoint[] = [];
  for (let edge = 0; edge < vertices.length - 1; edge++) {
    const start = vertices[edge]!;
    const end = vertices[edge + 1]!;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const count = Math.max(4, Math.ceil(length / 3.2));
    for (let step = 0; step < count; step++) {
      const raw = step / count;
      const t = style.uneven ? raw ** (edge % 2 === 0 ? 1.47 : 0.72) : raw;
      const normal = waveAt(t, edge + (style.phase ?? 0)) * (style.wave ?? 1.6);
      result.push([
        start[0] + dx * t - (dy / length) * normal,
        start[1] + dy * t + (dx / length) * normal,
      ]);
    }
  }
  result.push(vertices[vertices.length - 1]!);
  return result;
}

export function roundClosedCorners(
  vertices: readonly TracePoint[],
  fraction: number,
): TracePoint[] {
  return vertices.flatMap((corner, index) => {
    const previous = vertices[(index + vertices.length - 1) % vertices.length]!;
    const next = vertices[(index + 1) % vertices.length]!;
    const before = mix(corner, previous, fraction);
    const after = mix(corner, next, fraction);
    return Array.from({ length: 7 }, (_, step): TracePoint => {
      const t = step / 6;
      return [
        before[0] * (1 - t) ** 2 + corner[0] * 2 * t * (1 - t) + after[0] * t ** 2,
        before[1] * (1 - t) ** 2 + corner[1] * 2 * t * (1 - t) + after[1] * t ** 2,
      ];
    });
  });
}

export function mix(a: TracePoint, b: TracePoint, t: number): TracePoint {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function samplesFromTrace(points: readonly TracePoint[], angle = 0): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return points.flatMap(([x, y], index) => [
    310 + x * c - y * s,
    230 + x * s + y * c,
    0.36 + 0.19 * Math.sin(index * 0.17) + 0.08 * Math.cos(index * 0.071),
  ]);
}

export function startClosedTrace(points: readonly TracePoint[], position: number): TracePoint[] {
  const ring = points.slice(0, -1);
  const index = Math.floor(ring.length * position) % ring.length;
  const shifted = [...ring.slice(index), ...ring.slice(0, index)];
  return [...shifted, shifted[0]!];
}
