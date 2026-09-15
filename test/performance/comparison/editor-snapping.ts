import { measureInteractionSequence } from "../interaction-refresh-profile";
import { connectedPreviewDependents, movingSnapLine } from "../editor/connected-input-fixture";
import { expect } from "vitest";

import { indexedStroke } from "../../fixtures/editor/stroke";
import { rectangle } from "../../unit/domain/store/fixtures";
import type { ComparisonScenario } from "./contracts";

const file = "test/performance/editor/interaction-refresh-snapping.test.ts";
const modules = [
  "domain/store/public",
  "obsidian/embeds/active-editor/scene-store",
  "editor/snapping/snap-candidate",
  "editor/selection/public",
];

const SNAPPING_SEQUENCE_MEASUREMENT = {
  statistics: [{ kind: "p99", population: "samples", minimumSamples: 600 }],
  execution: "sequence",
  sequenceLength: 600,
  warmupOperations: 0,
} as const;

export const EDITOR_SNAPPING_SCENARIOS: readonly ComparisonScenario[] = [
  ...[false, true].map((move): ComparisonScenario => ({
    id: `editor.snap.${move ? "whole-line" : "semantic-anchor"}`,
    modules,
    covers: [
      {
        file,
        test: move ? "keeps whole-line endpoint snapping" : "keeps indexed semantic-anchor lookup",
        ordinals: [1],
      },
    ],
    ...SNAPPING_SEQUENCE_MEASUREMENT,
    create(implementation) {
      const { ElementStore } = implementation.get<
        typeof import("../../../src/domain/store/public")
      >(modules[0]!);
      const { ElementSceneStore } = implementation.get<
        typeof import("../../../src/obsidian/embeds/active-editor/scene-store")
      >(modules[1]!);
      const { SnapCandidateScratch, findSnapCandidate } = implementation.get<
        typeof import("../../../src/editor/snapping/snap-candidate")
      >(modules[2]!);
      const { resolveSelectionMoveSnap } = implementation.get<
        typeof import("../../../src/editor/selection/public")
      >(modules[3]!);
      const targets = Array.from({ length: 10_000 }, (_, index) =>
        rectangle(
          `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          20 + (index % 100) * 40,
          20 + Math.floor(index / 100) * 40,
        ),
      );
      const store = new ElementStore(targets);
      const sceneStore = new ElementSceneStore(store);
      const scratch = new SnapCandidateScratch();
      const moving = movingSnapLine();
      const selectedIds = new Set([moving.id]);
      let samples: number[] = [];
      const lookup = (frame: number) => {
        const target = targets[(frame * 17) % targets.length]!;
        const pointer = { x: target.x + (frame % 3) * 0.1, y: target.y + (frame % 5) * 0.1 };
        return move
          ? resolveSelectionMoveSnap({
              current: null,
              elements: [moving],
              pointerType: "pen",
              rawDelta: pointer,
              scratch,
              selectedIds,
              spatial: sceneStore,
              targets: { get: (id) => sceneStore.getSnapTarget(id) },
              zoom: 1,
            })
          : findSnapCandidate(
              { current: null, pointer, pointerType: "pen", zoom: 1 },
              sceneStore,
              { get: (id) => sceneStore.getSnapTarget(id) },
              scratch,
            );
      };
      // Preserve the reference's complete cache warm-up traversal before scoring.
      for (let frame = 0; frame < 600; frame += 1) expect(lookup(frame)).not.toBeNull();
      return {
        reset() {
          samples = [];
          store.resetInstrumentation();
        },
        *run() {
          let matched = 0;
          yield* measureInteractionSequence(
            (frame) => {
              if (lookup(frame) !== null) matched += 1;
            },
            600,
            samples,
          );
          return matched;
        },
        measurementSamples: () => samples,
        verify(result) {
          expect(result).toBe(600);
          expect(samples).toHaveLength(600);
          expect(store.instrumentation.fullStoreScans).toBe(0);
        },
        dispose() {
          sceneStore.release();
        },
      };
    },
  })),
  {
    id: "editor.snap.connected-preview",
    modules,
    covers: [{ file, test: "keeps reverse-map connection previews", ordinals: [1] }],
    ...SNAPPING_SEQUENCE_MEASUREMENT,
    create(implementation) {
      const { ElementStore } = implementation.get<
        typeof import("../../../src/domain/store/public")
      >(modules[0]!);
      const { ConnectedSelectionPreviewSession } = implementation.get<
        typeof import("../../../src/editor/selection/public")
      >(modules[3]!);
      const target = rectangle();
      const dependents = connectedPreviewDependents(target);
      const strokes = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
      const store = new ElementStore([target, ...dependents, ...strokes]);
      const selectedIds = new Set([target.id, ...strokes.map(({ id }) => id)]);
      let session: InstanceType<typeof ConnectedSelectionPreviewSession>;
      let samples: number[] = [];
      return {
        reset() {
          session = new ConnectedSelectionPreviewSession(store, [target], selectedIds);
          session.update({ delta: { x: 1, y: 1 }, kind: "translate" });
          samples = [];
          store.resetInstrumentation();
        },
        *run() {
          let previewCount = 0;
          yield* measureInteractionSequence(
            (frame) => {
              const preview = session.update({
                delta: { x: 2 + Math.sin(frame / 20), y: 2 + Math.cos(frame / 20) },
                kind: "translate",
              });
              previewCount += preview.elements.length;
            },
            600,
            samples,
          );
          return previewCount;
        },
        measurementSamples: () => samples,
        verify(result) {
          expect(result).toBe(512 * 600);
          expect(samples).toHaveLength(600);
          expect(store.instrumentation.fullStoreScans).toBe(0);
          expect(store.instrumentation.reverseDependencyVisits).toBe(0);
        },
        dispose() {},
      };
    },
  },
];
