import {
  createNavigationHarness,
  navigationFrame,
} from "../../fixtures/obsidian/navigation-profile";
import { measureInteractionSequence } from "../interaction-refresh-profile";
import { expect } from "vitest";
import type { ComparisonScenario } from "./contracts";

const navigationTitles = [
  "keeps continuous anchored trackpad zoom within budget",
  "keeps coalesced horizontal pan and native vertical scroll within budget",
  "keeps horizontal trackpad handoff and momentum within budget",
  "keeps horizontal touch momentum within budget",
] as const;

export const OBSIDIAN_NAVIGATION_SCENARIOS: readonly ComparisonScenario[] = navigationTitles.map(
  (test, mode) => ({
    id: `obsidian-navigation-${mode}`,
    modules: ["obsidian/embeds/active-editor/navigation", "editor/input/index", "editor/zoom/zoom"],
    covers: [
      {
        file: "test/performance/obsidian/active-editor-navigation-refresh-profile.test.ts",
        test,
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 600 }],
    execution: "sequence",
    sequenceLength: 600,

    warmupOperations: 0,
    create(implementation, refreshRate) {
      const api = {
        ...implementation.get<
          typeof import("../../../src/obsidian/embeds/active-editor/navigation")
        >("obsidian/embeds/active-editor/navigation"),
        ...implementation.get<typeof import("../../../src/editor/input/index")>(
          "editor/input/index",
        ),
        ...implementation.get<typeof import("../../../src/editor/zoom/zoom")>("editor/zoom/zoom"),
      };
      let harness = createNavigationHarness(api, refreshRate);
      let claimedEvents = 0;
      let samples: number[] = [];
      return {
        reset() {
          harness.navigation.dispose();
          harness = createNavigationHarness(api, refreshRate);
          if (mode !== 0) {
            expect(harness.navigation.restoreViewState({ cameraX: -100, zoom: 1 })).toBe(true);
            harness.resetWrites();
          }
          claimedEvents = 0;
          samples = [];
        },
        *run() {
          const update = navigationFrame(mode, harness);
          const durations = yield* measureInteractionSequence(
            (frame) => {
              if (update(frame)) claimedEvents += 1;
            },
            600,
            samples,
          );
          if (mode === 1) harness.navigation.finish();
          return durations;
        },
        measurementSamples: () => samples,
        verify(result) {
          expect(result).toHaveLength(600);
          expect(harness.cameraWrites).toBeGreaterThan(0);
          expect(harness.frames.maxPending).toBe(1);
          if (mode < 3) expect(harness.cameraWrites).toBe(600);
          if (mode === 0) {
            expect(claimedEvents).toBe(600);
            expect(harness.layoutWrites).toBe(600);
          }
          if (mode === 1) expect(harness.scrollWrites).toBeGreaterThan(0);
          if (mode === 2) {
            expect(claimedEvents).toBe(450);
            expect(harness.scrollWrites).toBe(0);
          }
        },
        dispose: () => harness.navigation.dispose(),
      };
    },
  }),
);
