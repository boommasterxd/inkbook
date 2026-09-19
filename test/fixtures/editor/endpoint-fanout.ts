import { vi } from "vitest";

import type {
  BoxShapeElementV1,
  InkElementV1,
  LineElementV1,
} from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import * as recordFactory from "../../../src/domain/store/record-factory";
import { SelectionHandleSession } from "../../../src/editor/selection/public";
import { connectedLine } from "../../unit/domain/store/fixtures";

export function maximumEndpointFixture(): {
  readonly elements: readonly InkElementV1[];
  readonly targetIds: readonly string[];
} {
  const targetCount = 39;
  const endpointsPerTarget = 511;
  const targets = Array.from({ length: targetCount }, (_, index) => endpointTarget(index));
  const lines = targets.flatMap((target, targetIndex) =>
    Array.from({ length: endpointsPerTarget }, (_, endpointIndex) =>
      endpointLine(target, targetCount + targetIndex * endpointsPerTarget + endpointIndex),
    ),
  );
  return { elements: [...targets, ...lines], targetIds: targets.map(({ id }) => id) };
}

export function endpointSession(
  store: ElementStore,
  targetIds: readonly string[],
): SelectionHandleSession {
  const targets = targetIds.map((id) => store.get(id)!.element as InkElementV1);
  const session = new SelectionHandleSession({
    action: { kind: "move" },
    elements: targets,
    planner: store,
    startPointer: { x: 0, y: 0 },
  });
  return session;
}

function endpointTarget(index: number): BoxShapeElementV1 {
  const x = 20 + (index % 8) * 220;
  const y = 20 + Math.floor(index / 8) * 150;
  return {
    createdAt: index,
    height: 100,
    id: fixtureId(index),
    kind: "rectangle",
    pivot: { x: x + 100, y: y + 50 },
    rotation: 0,
    style: { ...outlineStyle(), fillColor: null, fillOpacity: 0 },
    width: 200,
    x,
    y,
  };
}

function endpointLine(target: BoxShapeElementV1, index: number): LineElementV1 {
  return {
    ...connectedLine(target),
    createdAt: index,
    id: fixtureId(index),
    style: outlineStyle(),
  };
}

function outlineStyle() {
  return {
    outlineColor: { type: "theme-text" as const },
    outlineOpacity: 1,
    outlineStyle: "solid" as const,
    outlineWidth: 2 as const,
  };
}

function fixtureId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

/** Counts real record construction and reverse-map visits while every checkpoint requests a yield. */
export function observeEndpointPreparation(store: ElementStore) {
  let creations = 0;
  let previousCreations = 0;
  let previousReverseVisits = store.instrumentation.reverseDependencyVisits;
  let maximumCreationsBetweenYields = 0;
  let maximumReverseVisitsBetweenYields = 0;
  let partialPublications = 0;
  let yields = 0;
  const original = recordFactory.createOwnedReplacementRecord;
  const spy = vi
    .spyOn(recordFactory, "createOwnedReplacementRecord")
    .mockImplementation((...args) => {
      creations += 1;
      return original(...args);
    });
  const observeBoundary = () => {
    const instrumentation = store.instrumentation;
    maximumCreationsBetweenYields = Math.max(
      maximumCreationsBetweenYields,
      creations - previousCreations,
    );
    maximumReverseVisitsBetweenYields = Math.max(
      maximumReverseVisitsBetweenYields,
      instrumentation.reverseDependencyVisits - previousReverseVisits,
    );
    if (instrumentation.recordReplacements !== 0 || instrumentation.publishedDeltas !== 0)
      partialPublications += 1;
    previousCreations = creations;
    previousReverseVisits = instrumentation.reverseDependencyVisits;
    // Retain counters rather than all arguments and returned replacement records.
    spy.mockClear();
  };
  return {
    scheduler: {
      shouldYield: () => true,
      yieldControl: async () => {
        yields += 1;
        observeBoundary();
      },
    },
    finish: () => {
      observeBoundary();
      return {
        creations,
        maximumCreationsBetweenYields,
        maximumReverseVisitsBetweenYields,
        partialPublications,
        yields,
      };
    },
    restore: () => spy.mockRestore(),
  };
}
