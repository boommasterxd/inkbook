// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import type {
  ComparisonImplementation,
  ComparisonScenario,
} from "../../../performance/comparison/contracts";
import { EDITOR_GESTURE_SCENARIOS } from "../../../performance/comparison/editor-gestures";
import { EDITOR_SNAPPING_SCENARIOS } from "../../../performance/comparison/editor-snapping";
import { EDITOR_INPUT_SCENARIOS } from "../../../performance/comparison/editor-input";
import { OBSIDIAN_NAVIGATION_SCENARIOS } from "../../../performance/comparison/obsidian-navigation";

const sources = new Map<string, () => Promise<unknown>>([
  [
    "editor/snapping/snap-candidate",
    () => import("../../../../src/editor/snapping/snap-candidate"),
  ],
  ["editor/selection/public", () => import("../../../../src/editor/selection/public")],

  [
    "editor/selection/handle-session",
    () => import("../../../../src/editor/selection/handle-session"),
  ],
  ["editor/gestures/public", () => import("../../../../src/editor/gestures/public")],
  ["domain/store/public", () => import("../../../../src/domain/store/public")],
  [
    "obsidian/embeds/active-editor/scene-store",
    () => import("../../../../src/obsidian/embeds/active-editor/scene-store"),
  ],
  [
    "obsidian/embeds/active-editor/navigation",
    () => import("../../../../src/obsidian/embeds/active-editor/navigation"),
  ],
  ["editor/input/index", () => import("../../../../src/editor/input/index")],
  ["editor/zoom/zoom", () => import("../../../../src/editor/zoom/zoom")],
]);

async function implementationFor(scenario: ComparisonScenario): Promise<ComparisonImplementation> {
  const modules = new Map<string, unknown>();
  for (const name of scenario.modules) {
    const load = sources.get(name);
    if (!load) throw new Error(`Missing scenario module: ${name}`);
    modules.set(name, await load());
  }
  return { get: <T>(name: string) => modules.get(name) as T };
}

async function verifySequence(scenario: ComparisonScenario, refreshRate: number) {
  const kernel = await scenario.create(await implementationFor(scenario), refreshRate);
  try {
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await kernel.reset?.();
      let result = kernel.run();
      if (scenario.execution === "sequence") {
        const iterator = result as Generator<void, unknown, void>;
        let step = iterator.next();
        let count = 0;
        while (!step.done) {
          count += 1;
          expect(kernel.measurementSamples?.(undefined)).toHaveLength(count);
          step = iterator.next();
        }
        expect(count).toBe(scenario.sequenceLength);
        result = step.value;
      }
      await kernel.verify(result);
      const samples = kernel.measurementSamples?.(result);
      if (samples) {
        expect(samples).toHaveLength(600);
        expect(samples.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
      }
    }
  } finally {
    await kernel.dispose();
  }
}

describe("complete interaction comparison trajectories", () => {
  for (const scenario of OBSIDIAN_NAVIGATION_SCENARIOS) {
    it.each([60, 90, 120, 144, 240])(
      `${scenario.id} repeats its complete %i Hz sequence`,
      async (hz) => {
        await verifySequence(scenario, hz);
      },
    );
  }
  for (const scenario of [
    ...EDITOR_INPUT_SCENARIOS,
    ...EDITOR_GESTURE_SCENARIOS.filter(({ execution }) => execution === "sequence"),
    ...EDITOR_SNAPPING_SCENARIOS,
  ]) {
    it(`${scenario.id} resets between complete operations`, async () => {
      await verifySequence(scenario, 120);
    });
  }
});
