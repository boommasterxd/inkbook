import { measureInteractionSequence } from "../interaction-refresh-profile";
import {
  PASS_THROUGH_PLANNER,
  createHandleLine,
  createRotatedScaleFixture,
} from "../editor/selection-input-fixture";
import { expect } from "vitest";

import type { InkElementV1, PointV1 } from "../../../src/domain/schema/public";
import type { SelectionHandleAction } from "../../../src/editor/selection/public";
import type { SelectionHandleSession } from "../../../src/editor/selection/handle-session";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { rectangle } from "../../unit/domain/store/fixtures";
import { coordinateSystem, table } from "../../unit/domain/geometry/fixtures";
import type { ComparisonScenario } from "./contracts";

const file = "test/performance/editor/interaction-refresh-gestures.test.ts";

interface HandleProfile {
  id: string;
  action: SelectionHandleAction;
  start: PointV1;
  elements: readonly InkElementV1[];
  pointer: (frame: number) => PointV1;
  truncated: boolean;
  transform: boolean;
  guide?: string;
}

export const EDITOR_GESTURE_SCENARIOS: readonly ComparisonScenario[] = [
  ...Array.from({ length: 7 }, (_, index): ComparisonScenario => ({
    id: `editor.handle-preview.${index + 1}`,
    modules: ["editor/selection/handle-session"],
    covers: [
      {
        file,
        test:
          index < 4
            ? "keeps move, group scale, rotate, and shape scale previews"
            : "keeps linear, coordinate-axis, and table-divider handle drags",
        ordinals: [index < 4 ? index + 1 : index - 3],
      },
    ],
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 600 }],
    execution: "sequence",
    sequenceLength: 600,

    warmupOperations: 0,
    create(implementation) {
      const { SelectionHandleSession: Session } = implementation.get<
        typeof import("../../../src/editor/selection/handle-session")
      >("editor/selection/handle-session");
      const profile = handleProfile(index);
      let session: SelectionHandleSession;
      let samples: number[] = [];
      let matchingGuides = 0;
      let exactFrames = 0;
      return {
        reset() {
          session?.cancel();
          session = new Session({
            action: profile.action,
            elements: profile.elements,
            planner: PASS_THROUGH_PLANNER,
            startPointer: profile.start,
          });
          samples = [];
          matchingGuides = 0;
          exactFrames = 0;
        },
        *run() {
          let preview: ReturnType<SelectionHandleSession["update"]> | undefined;
          yield* measureInteractionSequence(
            (frame) => {
              preview = session.update(profile.pointer(frame));
              if (preview.snapGuide?.kind === profile.guide) matchingGuides += 1;
              if (preview.exactElements.length === 1) exactFrames += 1;
            },
            600,
            samples,
          );
          return preview;
        },
        measurementSamples: () => samples,
        verify(result) {
          const preview = result as ReturnType<SelectionHandleSession["update"]>;
          expect(preview.exactPreviewTruncated).toBe(profile.truncated);
          expect(preview.transform !== null).toBe(profile.transform);
          if (!profile.truncated) expect(preview.exactElements).toHaveLength(1);
          expect(samples).toHaveLength(600);
          if (profile.guide) {
            expect(matchingGuides).toBe(600);
            expect(exactFrames).toBe(600);
          }
        },
        dispose() {
          session?.cancel();
        },
      };
    },
  })),
  ...[false, true].map((typed): ComparisonScenario => ({
    id: `editor.rotated-stroke-scale.${typed ? "typed" : "array"}`,
    modules: ["editor/selection/selection-scale"],
    covers: [
      {
        file: "test/performance/editor/selection-scale-rotation-performance.test.ts",
        test: `materializes a maximum rotated stroke within budget (typed=${typed})`,
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 100 }],
    execution: "sync",

    warmupOperations: 20,
    create(implementation) {
      const { SelectionScaleGesture } = implementation.get<
        typeof import("../../../src/editor/selection/selection-scale")
      >("editor/selection/selection-scale");
      const { element, pointer, gesture, factors } = createRotatedScaleFixture(
        typed,
        SelectionScaleGesture,
      );
      return {
        run: () => gesture.materializeOne(element, pointer, false, factors),
        verify(result) {
          const stroke = result as typeof element;
          expect(stroke.kind).toBe("stroke");
          expect(stroke.rotation).toBe(0);
          expect(stroke.points).toHaveLength(4096 * 3);
          expect(stroke.points).not.toBe(element.points);
        },
        dispose() {},
      };
    },
  })),
];

function handleProfile(index: number): HandleProfile {
  if (index >= 4) return targetedProfile(index - 4);
  const start = [
    { x: 0, y: 0 },
    { x: 1000, y: 1000 },
    { x: 1000, y: 500 },
    { x: 300, y: 200 },
  ][index]!;
  const actions: SelectionHandleAction[] = [
    { kind: "move" },
    { anchor: { x: 0, y: 0 }, kind: "scale", position: "bottom-right", rotation: 0 },
    {
      center: { x: 500, y: 500 },
      kind: "rotate",
      opposite: { x: 0, y: 500 },
      referenceRotation: 0,
    },
    { anchor: { x: 100, y: 100 }, kind: "scale", position: "bottom-right", rotation: 0 },
  ];
  return {
    id: String(index),
    action: actions[index]!,
    start,
    elements:
      index === 3
        ? [rectangle("20000000-0000-4000-8000-000000000001", 100, 100)]
        : Array.from({ length: 10_000 }, (_, i) => indexedStroke(i)),
    pointer: (frame) => ({
      x: start.x + 10 + Math.sin(frame / 20) * 5,
      y: start.y + 10 + Math.cos(frame / 20) * 5,
    }),
    truncated: index < 3,
    transform: true,
  };
}

function targetedProfile(index: number): HandleProfile {
  const coordinate = coordinateSystem();
  const tableElement = table();
  const line = createHandleLine();
  const actions: SelectionHandleAction[] = [
    { elementId: line.id, endpoint: "end", kind: "linear-endpoint" },
    { axisIndex: 0, elementId: coordinate.id, kind: "coordinate-axis" },
    { elementId: tableElement.id, kind: "table-column", separatorIndex: 0 },
  ];
  const starts = [line.end, coordinate.axes[0], { x: 60, y: 70 }];
  const pointers = [
    { x: 420, y: 100 },
    { x: 200, y: 100 },
    { x: 60, y: 70 },
  ];
  const pointer = pointers[index]!;
  return {
    id: String(index),
    action: actions[index]!,
    start: starts[index]!,
    elements: [[line], [coordinate], [tableElement]][index]!,
    pointer: (frame) => ({
      x: pointer.x + Math.sin(frame / 20),
      y: pointer.y + Math.cos(frame / 20),
    }),
    truncated: false,
    transform: false,
    guide: index < 2 ? "angular" : "separator",
  };
}
