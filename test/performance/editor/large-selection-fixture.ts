import { expect } from "vitest";

import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import type { ElementStore } from "../../../src/domain/store/public";
import type { SelectionHandleSession } from "../../../src/editor/selection/handle-session";
import type { SelectionHandleSessionOptions } from "../../../src/editor/selection/handle-types";
import type { TransformSliceScheduler } from "../../../src/editor/selection/transforms";
import { maximumStroke } from "./maximum-stroke-fixture";

export function maximumViewportStroke(index: number): StrokeElementV1 {
  const source = maximumStroke(index);
  const points = new Float64Array(source.points.length);
  for (let offset = 0; offset < points.length; offset += 3) {
    points[offset] = 2 + ((offset / 3) % 2_044);
    points[offset + 1] = 100 + index * 0.001;
    points[offset + 2] = 0.5;
  }
  return {
    ...source,
    pivot: { x: 1_024, y: 100 + index * 0.001 },
    points: points as unknown as StrokeElementV1["points"],
  };
}

export function scaleSessionOptions(
  elements: readonly InkElementV1[],
  planner: ElementStore,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): SelectionHandleSessionOptions {
  return {
    action: {
      anchor: { x: bounds.minX, y: bounds.minY },
      kind: "scale",
      position: "bottom-right",
      rotation: 0,
    },
    elements,
    planner,
    startPointer: { x: bounds.maxX, y: bounds.maxY },
  };
}

export function verifyEndpointFanout(store: ElementStore, firstLineId: string): void {
  expect(store.get(firstLineId)?.element).toMatchObject({ start: { x: 23, y: 24 } });
  expect(store.instrumentation).toMatchObject({
    fullStoreScans: 0,
    reverseDependencyVisits: 19_929,
  });
}

export async function prepareEndpointFanout(
  store: ElementStore,
  session: SelectionHandleSession,
  scheduler: TransformSliceScheduler,
) {
  const materialized = await session.prepareCommitTimeSliced(scheduler);
  if (materialized.status !== "ready") throw new Error("Expected transformed targets.");
  return store.prepareElementReplacement(materialized.replacements, scheduler);
}
