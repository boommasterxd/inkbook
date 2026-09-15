import { measureInteractionSequence } from "../interaction-refresh-profile";
import { createIndexedEraser } from "../editor/indexed-scene-fixture";
import { indexedEditorScene } from "./editor-scene-fixture";
import { PASS_THROUGH_PLANNER } from "../editor/selection-input-fixture";
import { expect } from "vitest";

import type { EraserSweep } from "../../../src/editor/gestures/public";
import { maximumStroke } from "../editor/maximum-stroke-fixture";
import type { ComparisonScenario } from "./contracts";

export const EDITOR_INPUT_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "editor.input.maximum-stroke-preview",
    modules: ["editor/selection/handle-session"],
    covers: [
      {
        file: "test/performance/editor/editor-hot-paths.test.ts",
        test: "bounds maximum-stroke preview and eraser work independently",
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "max", population: "samples" }],
    execution: "sync",

    warmupOperations: 20,
    create(implementation) {
      const { SelectionHandleSession } = implementation.get<
        typeof import("../../../src/editor/selection/handle-session")
      >("editor/selection/handle-session");
      const strokes = Array.from({ length: 256 }, (_, index) => maximumStroke(index));
      let session: InstanceType<typeof SelectionHandleSession>;
      return {
        reset() {
          session?.cancel();
          session = new SelectionHandleSession({
            action: { kind: "move" },
            elements: strokes,
            startPointer: { x: -1000, y: 0 },
            planner: PASS_THROUGH_PLANNER,
          });
        },
        run: () => session.update({ x: 5000, y: 0 }),
        verify(result) {
          expect((result as { exactPreviewTruncated: boolean }).exactPreviewTruncated).toBe(true);
        },
        dispose() {
          session.cancel();
        },
      };
    },
  },
  {
    id: "editor.input.indexed-eraser-feedback",
    modules: [
      "editor/gestures/public",
      "domain/store/public",
      "obsidian/embeds/active-editor/scene-store",
    ],
    covers: [
      {
        file: "test/performance/editor/interaction-refresh-gestures.test.ts",
        test: "keeps indexed eraser feedback within budget",
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 600 }],
    execution: "sequence",
    sequenceLength: 600,

    warmupOperations: 0,
    create(implementation) {
      const { EraserSweep: Eraser } =
        implementation.get<typeof import("../../../src/editor/gestures/public")>(
          "editor/gestures/public",
        );
      const { store, sceneStore } = indexedEditorScene(implementation);
      let eraser: EraserSweep;
      let rejectedUpdates = 0;
      let samples: number[] = [];
      return {
        reset() {
          eraser?.revert();
          eraser = createIndexedEraser(Eraser, sceneStore);
          rejectedUpdates = 0;
          samples = [];
          store.resetInstrumentation();
        },
        *run() {
          return yield* measureInteractionSequence(
            (frame) => {
              const points = Array.from({ length: 8 }, (_, sample) => {
                const input = frame * 8 + sample;
                const column = input % 100;
                const row = Math.floor(input / 100);
                return { x: 20 + (row % 2 === 0 ? column : 99 - column) * 10, y: 20 + row * 10 };
              });
              if (eraser.updateBatch(points) !== "accepted") rejectedUpdates += 1;
            },
            600,
            samples,
          );
        },
        measurementSamples: () => samples,
        verify(result) {
          expect(result).toHaveLength(600);
          expect(rejectedUpdates).toBe(0);
          expect(eraser.candidateCount).toBeGreaterThan(0);
          expect(store.instrumentation.fullStoreScans).toBe(0);
        },
        dispose() {
          eraser?.revert();
          sceneStore.release();
        },
      };
    },
  },
];
