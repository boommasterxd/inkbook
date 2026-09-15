import { indexedEditorScene } from "./editor-scene-fixture";
import { expect } from "vitest";

import type { InkElementV1 } from "../../../src/domain/schema/public";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { maximumStroke } from "../editor/maximum-stroke-fixture";
import type { ComparisonScenario } from "./contracts";

const file = "test/performance/editor/selection-hot-paths.test.ts";
const moduleName = "editor/selection/public";
const defaults = {
  execution: "sync",
  warmupOperations: 20,
  statistics: [{ kind: "p99", population: "samples", minimumSamples: 100 }],
} as const;

export const EDITOR_SELECTION_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "editor.selection.pressure-early-exit",
    modules: [moduleName, "editor/selection/selection-area"],
    covers: [
      { file, test: "stops pressure sweep selection at the first visible segment", ordinals: [1] },
    ],
    ...defaults,
    create(implementation) {
      const { createRectangleSelectionArea } =
        implementation.get<typeof import("../../../src/editor/selection/public")>(moduleName);
      const { elementMatchesSelectionArea } = implementation.get<
        typeof import("../../../src/editor/selection/selection-area")
      >("editor/selection/selection-area");
      const target = maximumStroke(0);
      const area = createRectangleSelectionArea({ x: -1, y: 99 }, { x: 1, y: 101 });
      return {
        run: () => elementMatchesSelectionArea(area, target, "touched"),
        verify(result) {
          expect(result).toBe(true);
        },
        dispose() {},
      };
    },
  },
  {
    id: "editor.selection.coalesced-lasso",
    modules: [moduleName],
    covers: [{ file, test: "reduces a maximum coalesced lasso batch", ordinals: [1] }],
    ...defaults,
    create(implementation) {
      const { LassoSelectionSession } =
        implementation.get<typeof import("../../../src/editor/selection/public")>(moduleName);
      const samples = Array.from({ length: 4096 }, (_, index) => ({
        x: index * 2,
        y: 40 + Math.sin(index / 12) * 24,
      }));
      let session = new LassoSelectionSession({ x: 0, y: 40 }, 1);
      return {
        reset() {
          session = new LassoSelectionSession({ x: 0, y: 40 }, 1);
        },
        run() {
          session.appendBatch(samples);
          return session.points.length;
        },
        verify(result) {
          expect(result).toBeLessThanOrEqual(512);
          expect(result).toBeGreaterThan(1);
        },
        dispose() {},
      };
    },
  },
  ...[0, 1, 2].map((index): ComparisonScenario => ({
    id: `editor.selection.indexed-area.${index + 1}`,
    modules: [
      moduleName,
      "domain/store/public",
      "obsidian/embeds/active-editor/scene-store",
      "editor/selection/selection-area",
    ],
    covers: [
      { file, test: "classifies rectangle and bounded lasso candidates", ordinals: [index + 1] },
    ],
    ...defaults,
    create(implementation) {
      const { createRectangleSelectionArea, selectBySelectionAreaQuery } =
        implementation.get<typeof import("../../../src/editor/selection/public")>(moduleName);
      const { createLassoSelectionArea } = implementation.get<
        typeof import("../../../src/editor/selection/selection-area")
      >("editor/selection/selection-area");
      const { store, sceneStore: scene } = indexedEditorScene(implementation);
      const area =
        index === 2
          ? createRectangleSelectionArea({ x: 15, y: 15 }, { x: 1015, y: 115 })
          : createLassoSelectionArea([
              { x: 15, y: 15 },
              { x: 1015, y: 15 },
              { x: 1015, y: 115 },
              { x: 15, y: 115 },
            ]);
      store.resetInstrumentation();
      return {
        run: () =>
          selectBySelectionAreaQuery(
            new Set(),
            area,
            index === 1 ? "fully-enclosed" : "touched",
            false,
            (bounds, sink) =>
              scene.query(bounds, {
                add(id) {
                  const record = store.get(id);
                  if (record) sink.add(id, record.bounds, record.element as InkElementV1);
                },
              }),
          ),
        verify(result) {
          expect((result as ReadonlySet<string>).size).toBe(1000);
          expect(store.instrumentation.fullStoreScans).toBe(0);
        },
        dispose() {
          scene.release();
        },
      };
    },
  })),
  ...[false, true].map((hit): ComparisonScenario => ({
    id: `editor.selection.overlay.${hit ? "hit" : "geometry"}`,
    modules: [moduleName, "domain/geometry/public"],
    covers: [{ file, test: "keeps the 10,000-stroke group overlay", ordinals: [hit ? 2 : 1] }],
    ...defaults,
    create(implementation) {
      const { calculateElementBounds } =
        implementation.get<typeof import("../../../src/domain/geometry/public")>(
          "domain/geometry/public",
        );
      const { selectionOverlayGeometry, selectionOverlayContainsPoint } =
        implementation.get<typeof import("../../../src/editor/selection/public")>(moduleName);
      const selected = Array.from({ length: 10_000 }, (_, index) => {
        const element = indexedStroke(index);
        return { bounds: calculateElementBounds(element), element };
      });
      return {
        run: () =>
          hit
            ? selectionOverlayContainsPoint(selected, { x: 1000, y: 100 })
            : selectionOverlayGeometry(selected, 1),
        verify(result) {
          if (hit) expect(result).toBe(true);
          else {
            expect((result as { outline: { kind: string } }).outline.kind).toBe("polygon");
            expect((result as { handles: unknown[] }).handles).toHaveLength(9);
          }
        },
        dispose() {},
      };
    },
  })),
];
