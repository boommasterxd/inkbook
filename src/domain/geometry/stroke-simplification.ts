import type { PointV1 } from "../schema/types";

interface Center extends PointV1 {
  readonly pressure: number;
}

/** Fixed windows bound work and let live input finalize the same canonical samples. */
export const STROKE_SIMPLIFICATION_WINDOW = 64;

/** Preserve endpoints and bound combined center displacement and radius error. */
export function simplifyStrokeCenters(
  centers: readonly Center[],
  width: number,
  pressureEnabled: boolean,
): Center[] {
  if (centers.length <= 2) return centers.slice();
  const result: Center[] = [centers[0]!];
  // Bound center plus radius displacement to one thirty-second of the nominal width.
  const tolerance = Math.min(1, width / 32);
  for (let start = 0; start < centers.length - 1; start += STROKE_SIMPLIFICATION_WINDOW) {
    const end = Math.min(centers.length - 1, start + STROKE_SIMPLIFICATION_WINDOW);
    appendWindow(result, centers, {
      start,
      end,
      tolerance,
      pressureScale: pressureEnabled ? width * 0.325 : 0,
    });
  }
  return result;
}

interface Window {
  start: number;
  end: number;
  tolerance: number;
  pressureScale: number;
}

function appendWindow(result: Center[], centers: readonly Center[], window: Window): void {
  const filtered = filterPressures(centers, window);
  const keep = new Set([window.start, window.end]);
  const pending = [[window.start, window.end]];
  while (pending.length > 0) {
    const [start, end] = pending.pop()!;
    let maximum = window.tolerance;
    let selected = -1;
    for (let index = start! + 1; index < end!; index += 1) {
      const error = deviation(
        centers[index]!,
        filtered[start! - window.start]!,
        filtered[end! - window.start]!,
        window.pressureScale,
      );
      if (error > maximum) {
        maximum = error;
        selected = index;
      }
    }
    if (selected >= 0) {
      keep.add(selected);
      pending.push([start!, selected], [selected, end!]);
    }
  }
  for (const index of [...keep].sort((left, right) => left - right)) {
    if (index !== window.start) result.push(filtered[index - window.start]!);
  }
}

function deviation(point: Center, start: Center, end: Center, pressureScale: number): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const squared = dx * dx + dy * dy;
  const t =
    squared === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / squared));
  const position = Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
  const radius =
    Math.abs(point.pressure - start.pressure - t * (end.pressure - start.pressure)) * pressureScale;
  return position + radius;
}

function filterPressures(centers: readonly Center[], window: Window): Center[] {
  const result: Center[] = [];
  for (let index = window.start; index <= window.end; index += 1) {
    const center = centers[index]!;
    if (window.pressureScale === 0 || index === window.start || index === window.end) {
      result.push(center);
      continue;
    }
    const previous = centers[index - 1]!.pressure;
    const next = centers[index + 1]!.pressure;
    const significant =
      (center.pressure - previous) * (center.pressure - next) > 0 &&
      Math.min(Math.abs(center.pressure - previous), Math.abs(center.pressure - next)) *
        window.pressureScale >
        window.tolerance;
    if (significant) {
      result.push(center);
      continue;
    }
    let sum = 0;
    let count = 0;
    for (
      let sample = Math.max(window.start, index - 3);
      sample <= Math.min(window.end, index + 3);
      sample += 1
    ) {
      sum += centers[sample]!.pressure;
      count += 1;
    }
    const limit = window.tolerance / window.pressureScale;
    result.push({
      ...center,
      pressure: Math.max(center.pressure - limit, Math.min(center.pressure + limit, sum / count)),
    });
  }
  return result;
}
