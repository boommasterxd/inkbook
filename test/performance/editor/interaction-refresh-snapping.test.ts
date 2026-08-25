import { describe, expect, it } from "vitest";

import { ElementStore, resolveConnectedTranslationPreview } from "../../../src/domain/store/public";
import {
  findSnapCandidate,
  SnapCandidateScratch,
} from "../../../src/editor/snapping/snap-candidate";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { rectangle } from "../../unit/domain/store/fixtures";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";
import {
  CONNECTED_DEPENDENT_COUNT,
  createConnectedTranslationFixture,
} from "./connected-translation-fixture";

const SNAP_TARGET_COUNT = 10_000;

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz snapping and connection profile`, () => {
  it("keeps indexed semantic-anchor lookup within budget", async ({ annotate }) => {
    const targets = Array.from({ length: SNAP_TARGET_COUNT }, (_, index) => snapTarget(index));
    const store = new ElementStore(targets);
    const sceneStore = new ElementSceneStore(store);
    const scratch = new SnapCandidateScratch();
    warmSnapScratch(sceneStore, scratch, targets);
    store.resetInstrumentation();
    const allocationsBefore = scratch.allocationCount;
    let matched = 0;

    const durations = measureInteractionFrames((frame) => {
      const target = targets[(frame * 17) % targets.length]!;
      if (findCandidate(sceneStore, scratch, target, frame) !== null) matched += 1;
    });

    const p99 = interactionP99(durations);
    expect(matched).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(scratch.allocationCount).toBe(allocationsBefore);
    expect(store.instrumentation.fullStoreScans).toBe(0);
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(interactionProfileAnnotation("snap candidate lookup", p99), "performance");
    sceneStore.release();
  });

  it("keeps reverse-map connection previews within budget", async ({ annotate }) => {
    const { selectedIds, store, target } = createConnectedTranslationFixture();
    resolveConnectedTranslationPreview(store, [target.id], selectedIds, { x: 1, y: 1 });
    store.resetInstrumentation();
    let previewCount = 0;

    const durations = measureInteractionFrames((frame) => {
      const preview = resolveConnectedTranslationPreview(store, [target.id], selectedIds, {
        x: 2 + Math.sin(frame / 20),
        y: 2 + Math.cos(frame / 20),
      });
      previewCount += preview.length;
    });

    const p99 = interactionP99(durations);
    expect(previewCount).toBe(CONNECTED_DEPENDENT_COUNT * INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: CONNECTED_DEPENDENT_COUNT * INTERACTION_REFRESH_PROFILE.sampleCount,
    });
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(interactionProfileAnnotation("connected endpoint preview", p99), "performance");
  });
});

function warmSnapScratch(
  sceneStore: ElementSceneStore,
  scratch: SnapCandidateScratch,
  targets: readonly ReturnType<typeof rectangle>[],
): void {
  for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
    const target = targets[(frame * 17) % targets.length]!;
    if (findCandidate(sceneStore, scratch, target, frame) === null) {
      throw new Error("Snap-candidate warm-up did not find its target.");
    }
  }
}

function snapTarget(index: number) {
  return rectangle(
    `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    20 + (index % 100) * 40,
    20 + Math.floor(index / 100) * 40,
  );
}

function findCandidate(
  sceneStore: ElementSceneStore,
  scratch: SnapCandidateScratch,
  target: ReturnType<typeof rectangle>,
  frame: number,
) {
  return findSnapCandidate(
    {
      current: null,
      pointer: { x: target.x + (frame % 3) * 0.1, y: target.y + (frame % 5) * 0.1 },
      pointerType: "pen",
      zoom: 1,
    },
    sceneStore,
    { get: (id) => sceneStore.getSnapTarget(id) },
    scratch,
  );
}
