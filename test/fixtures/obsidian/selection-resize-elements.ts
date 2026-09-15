import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { indexedStroke } from "../editor/stroke";
import { coordinateSystem, table } from "../../unit/domain/geometry/fixtures";
import { connectedLine, rectangle } from "../../unit/domain/store/fixtures";
import { maximumStroke } from "../../performance/editor/maximum-stroke-fixture";

export function mixedExactElements(): readonly InkElementV1[] {
  const stroke = maximumStroke(0);
  return mixedElements({
    ...stroke,
    points: stroke.points.slice(0, 256 * 3),
  });
}

export function longPressureElements(): readonly InkElementV1[] {
  return mixedElements(maximumStroke(0));
}

export function variablePressureElements(): readonly InkElementV1[] {
  const stroke = maximumStroke(0);
  return mixedElements({
    ...stroke,
    points: stroke.points.map((value, index) =>
      index % 3 === 2 ? Math.round((Math.sin(index / 60) + 1) * 5_000) / 10_000 : value,
    ),
  });
}

export function pressureBandSelection(): readonly InkElementV1[] {
  return Array.from({ length: 40 }, (_, index) => {
    const x = 20 + (index % 8) * 12;
    const y = 20 + Math.floor(index / 8) * 12;
    return {
      ...indexedStroke(index),
      pivot: { x: x + 1.495, y },
      points: Array.from({ length: 300 }, (_, sample) => [
        Math.round((x + sample * 0.01) * 1_000) / 1_000,
        y,
        Math.round((Math.floor(sample / 20) / 14) * 10_000) / 10_000,
      ]).flat(),
    };
  });
}

export function mixedElements(stroke: StrokeElementV1): readonly InkElementV1[] {
  const target = rectangle("30000000-0000-4000-8000-000000000001", 100, 100);
  const arrow = {
    ...connectedLine(target),
    endNode: "arrow" as const,
    id: "30000000-0000-4000-8000-000000000002",
    kind: "arrow" as const,
  };
  return [
    { ...stroke, id: "30000000-0000-4000-8000-000000000003" },
    target,
    arrow,
    { ...coordinateSystem(), id: "30000000-0000-4000-8000-000000000004" },
    { ...table(), id: "30000000-0000-4000-8000-000000000005" },
  ];
}

export function fallbackElements(): readonly InkElementV1[] {
  return Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
}

export function nonPressureStroke(index: number): StrokeElementV1 {
  const stroke = maximumStroke(index);
  return { ...stroke, style: { ...stroke.style, pressureEnabled: false } };
}

export function mixedShapeFeedbackElements(): readonly InkElementV1[] {
  return [
    ...Array.from({ length: 255 }, (_, index) => ({
      ...rectangle(`40000000-0000-4000-8000-${String(index).padStart(12, "0")}`, 20, 20),
      rotation: 37,
    })),
    maximumStroke(0),
  ];
}

export const RESIZE_WORKLOADS = [
  ["mixed exact resize", mixedExactElements],
  ["long pressure progressive resize", longPressureElements],
  ["4096-sample non-pressure resize", () => mixedElements(nonPressureStroke(0))],
  [
    "20,480-sample non-pressure progressive resize",
    () => Array.from({ length: 5 }, (_, index) => nonPressureStroke(index)),
  ],
  ["variable pressure progressive resize", variablePressureElements],
  ["40 long pressure strokes resize", pressureBandSelection],
  ["255 canonical shapes with a long pressure stroke", mixedShapeFeedbackElements],
  ["10,000-element progressive resize", fallbackElements],
] as const;
