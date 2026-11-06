import type { PointV1 } from "../../../../src/domain/schema/types";
import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/public";
import { recognizeStrokeSteps } from "../../../../src/domain/recognition/stroke-recognition";
import { expect, vi } from "vitest";
import type { RecognitionExample } from "../../../fixtures/domain/hand-drawn-recognition/types";
import * as geometry from "../../../../src/domain/geometry/primitives";
import * as headFitting from "../../../../src/domain/recognition/arrow-head-fit";
import * as closedFitting from "../../../../src/domain/recognition/closed-shape-fit";

export function closedWorkProbe() {
  return {
    fit: vi.spyOn(closedFitting, "fitClosedShape"),
    prepare: vi.spyOn(closedFitting, "prepareClosedPath"),
    rotate: vi.spyOn(geometry, "rotatePointsClockwise"),
    pivot: vi.spyOn(geometry, "rotatePointClockwise"),
  };
}

export function maximumRectangle(count: number = MAX_STROKE_POINTS): number[] {
  return Array.from({ length: count }, (_, index) => {
    const progress = (index / (count - 1)) * 4;
    if (progress < 1) return [progress * 180, 0, 0.5];
    if (progress < 2) return [180, (progress - 1) * 100, 0.5];
    if (progress < 3) return [(3 - progress) * 180, 100, 0.5];
    return [0, (4 - progress) * 100, 0.5];
  }).flat();
}

export function maximumSampledPath(vertices: readonly PointV1[]): number[] {
  return Array.from({ length: MAX_STROKE_POINTS }, (_, index) => {
    const position = (index / (MAX_STROKE_POINTS - 1)) * (vertices.length - 1);
    const edge = Math.min(vertices.length - 2, Math.floor(position));
    const t = position - edge;
    return [
      vertices[edge]!.x * (1 - t) + vertices[edge + 1]!.x * t,
      vertices[edge]!.y * (1 - t) + vertices[edge + 1]!.y * t,
      0.5,
    ];
  }).flat();
}

export function maximumArrow(): number[] {
  const start = Array.from({ length: 25 }, (_, index) => {
    const angle = (index * Math.PI) / 12;
    return { x: 12 - 12 * Math.cos(angle), y: 12 * Math.sin(angle) };
  });
  const end = start.map((point) => ({ x: 2000 - point.x, y: point.y }));
  return maximumSampledPath([...start, ...end]);
}

/** Observe actual template segments; native symmetric templates retain their original work charge. */
export function headWorkProbe(onYield?: (points: readonly PointV1[], boundary: number) => void) {
  const distance = vi.spyOn(geometry, "pointSegmentDistance");
  const bounds = vi.spyOn(geometry, "includeBoundsPoint");
  const original = headFitting.fitArrowHeadSteps;
  const spans: Record<
    | "points"
    | "calls"
    | "matchedSteps"
    | "maxStep"
    | "openUneven"
    | "closedUneven"
    | "boundsReads"
    | "sourceBoundsReads",
    number
  >[] = [];
  vi.spyOn(headFitting, "fitArrowHeadSteps").mockImplementation(
    function* (points, zoom, preparation) {
      const span = {
        points: points.length,
        calls: 0,
        matchedSteps: 0,
        maxStep: 0,
        openUneven: 0,
        closedUneven: 0,
        boundsReads: 0,
        sourceBoundsReads: 0,
      };
      spans.push(span);
      const source = new Set(points);
      const steps = original(points, zoom, preparation);
      let boundary = 0;
      try {
        while (true) {
          const before = distance.mock.calls.length;
          const beforeBounds = bounds.mock.calls.length;
          const step = steps.next();
          const scans = bounds.mock.calls.slice(beforeBounds);
          span.boundsReads += scans.length;
          span.sourceBoundsReads += scans.filter(([, point]) => source.has(point)).length;
          const calls = distance.mock.calls.length - before;
          const template = observedTemplate(distance.mock.calls, before);
          if (template === "open") span.openUneven += calls;
          if (template === "closed") span.closedUneven += calls;
          span.calls += calls;
          span.maxStep = Math.max(span.maxStep, calls);
          if (calls > 0) span.matchedSteps++;
          if (step.done) return step.value;
          onYield?.(points, ++boundary);
          yield;
        }
      } finally {
        steps.return(null);
      }
    },
  );
  return { distance, spans, bounds };
}

function observedTemplate(
  calls: readonly (readonly [PointV1, PointV1, PointV1])[],
  offset: number,
): "open" | "closed" | "symmetric" | null {
  const first = calls[offset];
  if (first === undefined) return null;
  // directedError compares its first contour point with every actual template segment.
  const vertices = [first[1]];
  for (let index = offset; calls[index]?.[0] === first[0]; index++) vertices.push(calls[index]![2]);
  if (vertices.length < 3) return null;
  const epsilon =
    Math.max(1, ...vertices.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)])) * 1e-10;
  // Native arrow/triangle/diamond/circle templates are mirrored about y=0, across all attachments.
  const symmetric = vertices.every((point) =>
    vertices.some(
      (mirror) =>
        Math.abs(point.x - mirror.x) <= epsilon && Math.abs(point.y + mirror.y) <= epsilon,
    ),
  );
  if (symmetric) return "symmetric";
  const last = vertices[vertices.length - 1]!;
  return Math.hypot(vertices[0]!.x - last.x, vertices[0]!.y - last.y) <= epsilon
    ? "closed"
    : "open";
}

export function recognizePointPath(points: readonly PointV1[], zoom = 1) {
  return recognizeSamples(
    points.flatMap((point) => [point.x, point.y, 0.5]),
    zoom,
  );
}

export function recognizeSamples(samples: readonly number[], zoom = 1) {
  const iterator = recognizeStrokeSteps(samples, { zoom });
  let result = iterator.next();
  while (!result.done) result = iterator.next();
  return result.value;
}

export function expectRecognitionExample(example: RecognitionExample, zoom = 1): void {
  const result = recognizeSamples(example.samples, zoom);
  expect(result, example.id).not.toBeNull();
  expect(example.expected.kinds, example.id).toContain(result?.kind);
  if (example.expected.line !== undefined) {
    expect(result && "bend" in result ? result.bend === null : undefined, example.id).toBe(
      example.expected.line === "straight",
    );
  }
  if (example.expected.startNode !== undefined)
    expect(result, example.id).toMatchObject({ startNode: example.expected.startNode });
  if (example.expected.endNode !== undefined)
    expect(result, example.id).toMatchObject({ endNode: example.expected.endNode });
}
import { normalizeRecognitionStrokeSteps } from "../../../../src/domain/recognition/stroke-normalization";
import { observeSchemaArray } from "../../../fixtures/domain/schema-array-work";

export function observedNormalization(samples: number[]) {
  const { observed, work } = observeSchemaArray(samples);
  return { steps: normalizeRecognitionStrokeSteps(observed, 1), work };
}

export const CLOSED_VERTICES = {
  rectangle: [
    [0, 0],
    [180, 0],
    [180, 100],
    [0, 100],
  ],
  triangle: [
    [90, 0],
    [180, 130],
    [0, 130],
  ],
  diamond: [
    [90, 0],
    [180, 65],
    [90, 130],
    [0, 65],
  ],
  parallelogram: [
    [36, 0],
    [180, 0],
    [144, 100],
    [0, 100],
  ],
  octagon: [
    [29.3, 0],
    [150.7, 0],
    [180, 29.3],
    [180, 70.7],
    [150.7, 100],
    [29.3, 100],
    [0, 70.7],
    [0, 29.3],
  ],
} satisfies Record<string, number[][]>;

export function sampledPath(vertices: readonly (readonly number[])[], closed = true): number[] {
  const result: number[] = [];
  const count = closed ? vertices.length : vertices.length - 1;
  for (let edge = 0; edge < count; edge += 1) {
    const start = vertices[edge]!;
    const end = vertices[(edge + 1) % vertices.length]!;
    for (let step = 0; step < 20; step += 1) {
      const t = step / 20;
      result.push(
        start[0]! + (end[0]! - start[0]!) * t,
        start[1]! + (end[1]! - start[1]!) * t,
        0.5,
      );
    }
  }
  const end = vertices[closed ? 0 : vertices.length - 1]!;
  result.push(end[0]!, end[1]!, 0.5);
  return result;
}

export function ellipseSamples(rx = 100, ry = 60, phase = 0): number[] {
  return Array.from({ length: 181 }, (_, index) => {
    const angle = (index / 180) * 2 * Math.PI + phase;
    return [Math.cos(angle) * rx, Math.sin(angle) * ry, 0.5];
  }).flat();
}

export function transformSamples(
  samples: readonly number[],
  angle: number,
  reverse = false,
): number[] {
  const radians = (angle * Math.PI) / 180;
  const triples = Array.from({ length: samples.length / 3 }, (_, index) => {
    const x = samples[index * 3]!;
    const y = samples[index * 3 + 1]!;
    return [
      320 + x * Math.cos(radians) - y * Math.sin(radians),
      250 + x * Math.sin(radians) + y * Math.cos(radians),
      0.5,
    ];
  });
  return (reverse ? triples.reverse() : triples).flat();
}

export function quadraticSamples(
  control: PointV1,
  end: PointV1 = { x: 220, y: 0 },
  count = 121,
): number[] {
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    return [
      2 * t * (1 - t) * control.x + t ** 2 * end.x,
      2 * t * (1 - t) * control.y + t ** 2 * end.y,
      0.5,
    ];
  }).flat();
}

export function starSamples(): number[] {
  const vertices = Array.from({ length: 10 }, (_, index) => {
    const angle = (index * Math.PI) / 5 - Math.PI / 2;
    const radius = index % 2 === 0 ? 100 : 38.196601125;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
  return sampledPath(vertices);
}

/** Later visible excursions must survive even after early jitter consumes retained corners. */
export function aliasedZigzagSamples(phase: number): number[] {
  const points = [{ x: 0, y: 0 }];
  let length = 0;
  const append = (x: number, y: number) => {
    const previous = points[points.length - 1]!;
    length += Math.hypot(x - previous.x, y - previous.y);
    points.push({ x, y });
  };
  for (let index = 1; index <= 26; index += 1) append(index, index % 2 === 0 ? -2 : 2);
  append(26, 0);
  const period = 2 * Math.hypot(0.5, 100);
  append(points[points.length - 1]!.x + (5 + phase) * period - length, 0);
  for (let index = 0; index < 150; index += 1) {
    const x = points[points.length - 1]!.x;
    append(x + 0.5, 100);
    append(x + 1, 0);
  }
  append(points[points.length - 1]!.x + (5 - phase) * period, 0);
  return points.flatMap((point) => [point.x, point.y, 0.5]);
}
