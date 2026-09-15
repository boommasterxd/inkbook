import { expect } from "vitest";

import type { StrokeElementV1 } from "../../../src/domain/schema/public";
import type { EraserSweep } from "../../../src/editor/gestures/public";
import { maximumStroke } from "../editor/maximum-stroke-fixture";
import { rectangle } from "../../unit/domain/geometry/fixtures";
import type { ComparisonScenario } from "./contracts";

const moduleName = "editor/gestures/public";
const hotFile = "test/performance/editor/eraser-hot-paths.test.ts";
const editorFile = "test/performance/editor/editor-hot-paths.test.ts";

export const EDITOR_ERASER_SCENARIOS: readonly ComparisonScenario[] = [
  ...[256, 488].map((count): ComparisonScenario => ({
    id: `editor.eraser.resume.${count}`,
    modules: [moduleName],
    covers: [
      {
        file: count === 256 ? editorFile : hotFile,
        test:
          count === 256
            ? "bounds maximum-stroke preview and eraser work"
            : "resumes exact checks for a dense two-million-point batch",
        ordinals: count === 256 ? [2] : [1, 2],
      },
    ],
    statistics:
      count === 256
        ? [{ kind: "max", population: "samples" }]
        : [
            { kind: "p99", population: "samples", minimumSamples: 100 },
            { kind: "max", population: "samples" },
          ],
    execution: "sync",

    warmupOperations: 1,
    create(implementation) {
      const { EraserSweep: Eraser } =
        implementation.get<typeof import("../../../src/editor/gestures/public")>(moduleName);
      const strokes = Array.from({ length: count }, (_, index) => maximumStroke(index));
      let eraser: EraserSweep;
      let samples: number[] = [];
      return {
        reset() {
          samples = [];
        },
        run() {
          // The 256-stroke reference includes construction in its first update sample.
          const firstStarted = performance.now();
          eraser = denseEraser(Eraser, strokes);
          if (count === 256) {
            eraser.update({ x: 5000, y: 0 });
            samples.push(performance.now() - firstStarted);
          }
          while (eraser.candidateCount < count) {
            const started = performance.now();
            eraser.update({ x: 5000, y: 0 });
            samples.push(performance.now() - started);
          }
          return eraser.candidateCount;
        },
        measurementSamples: () => samples,
        verify(result) {
          expect(result).toBe(count);
          expect(samples.length).toBeGreaterThan(0);
        },
        dispose() {
          eraser?.revert();
        },
      };
    },
  })),
  ...[5000, 20_000].map((count): ComparisonScenario => ({
    id: `editor.eraser.incremental-feedback.${count}`,
    modules: [moduleName],
    covers: [
      {
        file: hotFile,
        test: `keeps incremental feedback linear for ${count} candidates`,
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "max", population: "operations" }],
    execution: "sync",

    warmupOperations: 1,
    create(implementation) {
      const { EraserSweep: Eraser } =
        implementation.get<typeof import("../../../src/editor/gestures/public")>(moduleName);
      const element = rectangle({
        id: "shape",
        createdAt: 1,
        x: 40,
        y: 40,
        width: 20,
        height: 20,
        pivot: { x: 50, y: 50 },
      });
      const ids = Array.from({ length: count }, (_, index) => `shape-${index}`);
      let eraser: EraserSweep;
      let added = 0;
      let full = 0;
      return {
        reset() {
          eraser?.revert();
          added = 0;
          full = 0;
          let query = 0;
          eraser = new Eraser(
            { x: 0, y: 50 },
            4,
            {
              getElement: () => element,
              query: (_bounds, sink) => {
                const id = ids[++query - 2];
                if (id !== undefined) sink.add(id);
              },
            },
            {
              addCandidateFade: (items) => {
                added += items.length;
              },
              clearCandidateFade() {},
              setCandidateFade() {
                full += 1;
              },
            },
          );
        },
        run() {
          for (let index = 0; index < count; index += 1)
            eraser.update({ x: index % 2 === 0 ? 100 : 0, y: 50 });
          return eraser.candidateCount;
        },
        verify(result) {
          expect(result).toBe(count);
          expect(added).toBe(count);
          expect(full).toBe(0);
        },
        dispose() {
          eraser?.revert();
        },
      };
    },
  })),
  {
    id: "editor.eraser.finalization",
    modules: [moduleName],
    covers: [
      {
        file: "test/performance/editor/eraser-finalization-refresh-profile.test.ts",
        test: "keeps exact finalization slices within the selected main-thread budget",
        ordinals: [1, 2],
      },
    ],
    statistics: [
      { kind: "p95", population: "samples" },
      { kind: "max", population: "samples" },
    ],
    execution: "async",

    warmupOperations: 1,
    create(implementation, hz) {
      const { EraserSweep: Eraser } =
        implementation.get<typeof import("../../../src/editor/gestures/public")>(moduleName);
      const strokes = Array.from({ length: 128 }, (_, index) => maximumStroke(index));
      const budget = (1000 / hz) * 0.55;
      let eraser: EraserSweep;
      let samples: number[] = [];
      return {
        reset() {
          eraser?.revert();
          samples = [];
          let preparation = true;
          eraser = denseEraser(Eraser, strokes, () => (preparation ? 0 : budget));
          eraser.update({ x: 5000, y: 0 });
          preparation = false;
        },
        async run() {
          let sliceStarted = performance.now();
          let polls = 0;
          let removed = 0;
          await eraser.commit(
            (ids) => {
              removed = ids.size;
              return true;
            },
            {
              isCancelled: () => false,
              shouldYield: () => ++polls >= Math.ceil(budget / 0.05),
              async yieldControl() {
                samples.push(performance.now() - sliceStarted);
                polls = 0;
                await Promise.resolve();
                sliceStarted = performance.now();
              },
            },
          );
          samples.push(performance.now() - sliceStarted);
          return removed;
        },
        measurementSamples: () => samples,
        verify(result) {
          expect(result).toBe(128);
          expect(samples.length).toBeGreaterThan(1);
        },
        dispose() {
          eraser?.revert();
        },
      };
    },
  },
];

function denseEraser(
  eraserClass: typeof EraserSweep,
  strokes: readonly StrokeElementV1[],
  budget?: () => number,
): EraserSweep {
  const byId = new Map(strokes.map((stroke) => [stroke.id, stroke]));
  let query = 0;
  return new eraserClass(
    { x: -1000, y: 0 },
    4,
    {
      getElement: (id) => byId.get(id),
      query: (_bounds, sink) => {
        if (query++ === 1) for (const { id } of strokes) sink.add(id);
      },
    },
    { addCandidateFade() {}, clearCandidateFade() {}, setCandidateFade() {} },
    budget,
  );
}
