import type {
  BoxShapeElementV1,
  InkElementV1,
  InkSnapshotV1,
  OutlineStyleV1,
  ShapeStyleV1,
  StrokeElementV1,
  StrokeStyleV1,
} from "../../../src/domain/schema/public";
import { createStandardDomainFixture } from "../domain/standard-domain-fixture";
import { uuid as retainedCapacityId } from "../../unit/persistence/serialization/fixtures";
import { createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";

export const STANDARD_STROKES = 10_000;
export const STANDARD_POINTS = 500_000;
export const STRESS_STROKES = 15_000;
export const STRESS_POINTS = 2_000_000;
const STANDARD_MIXED_SHAPES = 500;
const STANDARD_LINEAR_ELEMENTS = 500;
export const CLIPBOARD_ELEMENTS = 5_000;
const CLIPBOARD_STROKES = 4_000;
export const CLIPBOARD_POINTS = 500_000;

const strokeStyle = Object.freeze({
  color: { type: "theme-text" },
  opacity: 1,
  pressureEnabled: false,
  smoothing: 0.5,
  width: 4,
} satisfies StrokeStyleV1);

const outlineStyle = Object.freeze({
  outlineColor: { type: "theme-text" },
  outlineOpacity: 1,
  outlineStyle: "solid",
  outlineWidth: 4,
} satisfies OutlineStyleV1);

const shapeStyle = Object.freeze({
  ...outlineStyle,
  fillColor: null,
  fillOpacity: 0,
} satisfies ShapeStyleV1);

export function createStandardPersistenceFixture(revision = 1): InkSnapshotV1 {
  const fixture = createStandardDomainFixture();
  if (
    fixture.strokeCount !== STANDARD_STROKES ||
    fixture.strokePointCount !== STANDARD_POINTS ||
    fixture.shapeCount !== STANDARD_MIXED_SHAPES ||
    fixture.linearElementCount !== STANDARD_LINEAR_ELEMENTS
  ) {
    throw new Error("The shared standard fixture does not satisfy persistence boundaries.");
  }
  return snapshot(revision, [...fixture.elements]);
}

export function createStressLimitFixture(revision = 1): InkSnapshotV1 {
  const elements = new Array<InkElementV1>(STRESS_STROKES);
  const longerStrokeCount = STRESS_POINTS % STRESS_STROKES;
  const basePointCount = Math.floor(STRESS_POINTS / STRESS_STROKES);
  let pointCount = 0;
  for (let index = 0; index < STRESS_STROKES; index += 1) {
    const strokePoints = basePointCount + (index < longerStrokeCount ? 1 : 0);
    elements[index] = stressStroke(index, strokePoints);
    pointCount += strokePoints;
  }
  if (pointCount !== STRESS_POINTS) throw new Error("Stress fixture point count is inconsistent.");
  return snapshot(revision, elements);
}

export function createClipboardLimitFixture(): readonly InkElementV1[] {
  const strokes = Array.from({ length: CLIPBOARD_STROKES }, (_, index) =>
    compactClipboardStroke(index),
  );
  const shapes = Array.from({ length: CLIPBOARD_ELEMENTS - CLIPBOARD_STROKES }, (_, index) =>
    rectangle(CLIPBOARD_STROKES + index, 20 + (index % 50) * 30, 20 + Math.floor(index / 50) * 30),
  );
  return [...strokes, ...shapes];
}

export function createMinimalPersistenceFixture(revision = 0): InkSnapshotV1 {
  return snapshot(revision, []);
}

export function replaceFirstStroke(
  snapshotValue: InkSnapshotV1,
  revision: number,
): StrokeElementV1 {
  const first = snapshotValue.elements[0];
  if (first?.kind !== "stroke") throw new Error("Persistence fixture must start with a stroke.");
  const points = [...first.points];
  points[0] = (points[0] ?? 0) + 0.001;
  return { ...first, points, pivot: { ...first.pivot }, createdAt: first.createdAt + revision };
}

function snapshot(revision: number, elements: InkElementV1[]): InkSnapshotV1 {
  return createWorkerSnapshot(elements, revision);
}

function compactClipboardStroke(index: number): StrokeElementV1 {
  const points = new Array<number>(125 * 3);
  for (let point = 0; point < 125; point += 1) {
    const offset = point * 3;
    points[offset] = 10 + (point % 2);
    points[offset + 1] = 10 + (point % 2);
    points[offset + 2] = 1;
  }
  return {
    createdAt: index,
    id: uuid(index),
    kind: "stroke",
    pivot: { x: 10.5, y: 10.5 },
    points,
    rotation: 0,
    style: strokeStyle,
    tool: "pen",
  };
}

function stressStroke(index: number, pointCount: number): StrokeElementV1 {
  const baseX = 30;
  const baseY = 30;
  const points = new Array<number>(pointCount * 3);
  for (let point = 0; point < pointCount; point += 1) {
    const offset = point * 3;
    points[offset] = baseX + (point % 2);
    points[offset + 1] = baseY + (point % 2);
    points[offset + 2] = 0.5;
  }
  const highlight = index < STRESS_STROKES / 2;
  return {
    createdAt: index,
    id: uuid(200_000 + index),
    kind: "stroke",
    pivot: { x: baseX + 0.5, y: baseY + 0.5 },
    points,
    rotation: 0,
    style: highlight
      ? { ...strokeStyle, opacity: 0.4, pressureEnabled: false, width: 14 }
      : strokeStyle,
    tool: highlight ? "highlighter" : "pen",
  };
}

function rectangle(id: number, x: number, y: number): BoxShapeElementV1 {
  return {
    createdAt: id,
    height: 60,
    id: uuid(id),
    kind: "rectangle",
    pivot: { x: x + 30, y: y + 30 },
    rotation: 0,
    style: shapeStyle,
    width: 60,
    x,
    y,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

export function createPressureGroupFixture() {
  const fixture = createStandardPersistenceFixture();
  return {
    ...fixture,
    elements: fixture.elements
      .filter((element) => element.kind === "stroke")
      .map((element) => ({
        ...element,
        tool: "pen" as const,
        style: { ...element.style, pressureEnabled: true },
      })),
  };
}

export function createRetainedCapacityRectangle(index: number): BoxShapeElementV1 {
  return {
    createdAt: index,
    height: 100,
    id: retainedCapacityId(index),
    kind: "rectangle",
    pivot: { x: 150, y: 150 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
    width: 100,
    x: 100,
    y: 100,
  };
}
