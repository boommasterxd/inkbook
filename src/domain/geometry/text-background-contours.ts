import type { PointV1 } from "../schema/types";
import type { PaintRectangle } from "./rectangle-cutouts";
import { roundedBackgroundBoundary, type TextBackgroundBoundary } from "./rounded-background-path";
import { arcTo, lineTo, moveTo } from "./svg-format";

interface BoundaryEvent {
  readonly position: number;
  readonly delta: number;
}

interface BoundaryLine {
  readonly horizontal: boolean;
  readonly fixed: number;
  readonly events: BoundaryEvent[];
}

/** Disjoint paint strips become continuous contours without internal rasterized edges. */
export function* textBackgroundContoursSteps(
  box: PaintRectangle,
  rectangles: readonly PaintRectangle[],
  radius: number,
  visit?: () => void,
): Generator<void, string> {
  const lines = new Map<string, BoundaryLine>();
  const edges: TextBackgroundBoundary[] = [];
  for (const rectangle of rectangles) {
    for (const edge of roundedBackgroundBoundary(box, rectangle, radius)) {
      visit?.();
      if (pointKey(edge.start) === pointKey(edge.end)) continue;
      if (edge.radius !== undefined) edges.push(edge);
      else appendLine(lines, edge);
    }
    yield;
  }
  for (const line of lines.values()) yield* cancelLine(line, edges, visit);
  return yield* stitchContours(edges, visit);
}

function appendLine(lines: Map<string, BoundaryLine>, edge: TextBackgroundBoundary): void {
  const horizontal = edge.start.y === edge.end.y;
  const fixed = horizontal ? edge.start.y : edge.start.x;
  const start = horizontal ? edge.start.x : edge.start.y;
  const end = horizontal ? edge.end.x : edge.end.y;
  const key = `${horizontal ? "h" : "v"}:${fixed}`;
  let line = lines.get(key);
  if (!line) {
    line = { horizontal, fixed, events: [] };
    lines.set(key, line);
  }
  const direction = Math.sign(end - start);
  line.events.push(
    { position: Math.min(start, end), delta: direction },
    { position: Math.max(start, end), delta: -direction },
  );
}

function* cancelLine(
  line: BoundaryLine,
  edges: TextBackgroundBoundary[],
  visit: (() => void) | undefined,
): Generator<void> {
  const events = yield* sortEvents(line.events, visit);
  let count = 0;
  let previous = events[0]!.position;
  let index = 0;
  while (index < events.length) {
    const position = events[index]!.position;
    if (position > previous && count !== 0) {
      const start = linePoint(line, count > 0 ? previous : position);
      const end = linePoint(line, count > 0 ? position : previous);
      for (let copy = 0; copy < Math.abs(count); copy += 1) {
        edges.push({ start, end });
        visit?.();
        yield;
      }
    }
    do {
      count += events[index++]!.delta;
      visit?.();
      yield;
    } while (index < events.length && events[index]!.position === position);
    previous = position;
  }
}

function linePoint(line: BoundaryLine, position: number): PointV1 {
  return line.horizontal ? { x: position, y: line.fixed } : { x: line.fixed, y: position };
}

/** Cooperative merge passes avoid one uninterruptible sort for a full-capacity edge. */
function* sortEvents(
  events: BoundaryEvent[],
  visit: (() => void) | undefined,
): Generator<void, BoundaryEvent[]> {
  let input = events;
  for (let width = 1; width < events.length; width *= 2) {
    const output: BoundaryEvent[] = [];
    for (let start = 0; start < events.length; start += width * 2) {
      let left = start;
      let right = Math.min(start + width, events.length);
      const middle = right;
      const end = Math.min(start + width * 2, events.length);
      while (left < middle || right < end) {
        const takeLeft =
          right >= end || (left < middle && input[left]!.position <= input[right]!.position);
        output.push(input[takeLeft ? left++ : right++]!);
        visit?.();
        yield;
      }
    }
    input = output;
  }
  return input;
}

function* stitchContours(
  edges: readonly TextBackgroundBoundary[],
  visit: (() => void) | undefined,
): Generator<void, string> {
  const outgoing = new Map<string, TextBackgroundBoundary[]>();
  for (const edge of edges) {
    const key = pointKey(edge.start);
    const next = outgoing.get(key);
    if (next) next.push(edge);
    else outgoing.set(key, [edge]);
    visit?.();
    yield;
  }
  let path = "";
  for (const [first, next] of outgoing) {
    while (next.length) {
      let edge = next.pop()!;
      path += moveTo(edge.start);
      for (;;) {
        path += edge.radius === undefined ? lineTo(edge.end) : arcTo(edge.radius, 1, edge.end);
        visit?.();
        yield;
        const end = pointKey(edge.end);
        if (end === first) break;
        const following = outgoing.get(end)?.pop();
        if (!following) throw new Error("Text background contour is not closed.");
        edge = following;
      }
      path += "Z";
    }
  }
  return path;
}

function pointKey(point: PointV1): string {
  return `${point.x},${point.y}`;
}
