import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import {
  ConnectedSelectionPreviewSession,
  resolveSelectionMoveSnap,
} from "../../../src/editor/selection/public";
import {
  findSnapCandidate,
  SnapCandidateScratch,
} from "../../../src/editor/snapping/snap-candidate";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { connectedLine, rectangle } from "../../unit/domain/store/fixtures";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";
import {
  CONNECTED_DEPENDENT_COUNT,
  createConnectedTranslationFixture,
} from "./connected-translation-fixture";

const SNAP_TARGET_COUNT = 10_000;

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz snapping and connection profile`, () => {
  it("keeps indexed semantic-anchor lookup within budget", async ({ annotate }) => {
    const { sceneStore, scratch, store, targets } = createSnapFixture();
    warmLookup(
      targets,
      (target, frame) => findCandidate(sceneStore, scratch, target, frame),
      "Snap-candidate",
    );
    store.resetInstrumentation();
    const allocationsBefore = scratch.allocationCount;
    let matched = 0;

    const durations = measureInteractionFrames((frame) => {
      const target = targets[(frame * 17) % targets.length]!;
      if (findCandidate(sceneStore, scratch, target, frame) !== null) matched += 1;
    });

    const p99 = interactionP99(durations);
    expectSnapProfile({ allocationsBefore, matched, p99, scratch, store });
    await annotate(interactionProfileAnnotation("snap candidate lookup", p99), "performance");
    sceneStore.release();
  });

  it("keeps reverse-map connection previews within budget", async ({ annotate }) => {
    const { selectedIds, store, target } = createConnectedTranslationFixture();
    const session = new ConnectedSelectionPreviewSession(store, [target], selectedIds);
    session.update({ delta: { x: 1, y: 1 }, kind: "translate" });
    store.resetInstrumentation();
    let previewCount = 0;

    const durations = measureInteractionFrames((frame) => {
      const preview = session.update({
        delta: {
          x: 2 + Math.sin(frame / 20),
          y: 2 + Math.cos(frame / 20),
        },
        kind: "translate",
      });
      previewCount += preview.elements.length;
    });

    const p99 = interactionP99(durations);
    expect(previewCount).toBe(CONNECTED_DEPENDENT_COUNT * INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: 0,
    });
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    await annotate(interactionProfileAnnotation("connected endpoint preview", p99), "performance");
  });

  it("keeps whole-line endpoint snapping within budget", async ({ annotate }) => {
    const { sceneStore, scratch, store, targets } = createSnapFixture();
    const moving = {
      ...connectedLine(),
      end: { x: 100, y: 0 },
      pivot: { x: 50, y: 0 },
      start: { x: 0, y: 0 },
      startConnection: null,
    };
    const selectedIds = new Set([moving.id]);
    let matched = 0;
    warmLookup(
      targets,
      (target, frame) => findMoveSnap(sceneStore, scratch, moving, selectedIds, target, frame),
      "Selection-move snap",
    );
    store.resetInstrumentation();
    const allocationsBefore = scratch.allocationCount;

    const durations = measureInteractionFrames((frame) => {
      const target = targets[(frame * 17) % targets.length]!;
      if (findMoveSnap(sceneStore, scratch, moving, selectedIds, target, frame) !== null)
        matched += 1;
    });

    const p99 = interactionP99(durations);
    expectSnapProfile({ allocationsBefore, matched, p99, scratch, store });
    await annotate(
      interactionProfileAnnotation("selection move endpoint snap", p99),
      "performance",
    );
    sceneStore.release();
  });
});

function createSnapFixture() {
  const targets = Array.from({ length: SNAP_TARGET_COUNT }, (_, index) => snapTarget(index));
  const store = new ElementStore(targets);
  return {
    sceneStore: new ElementSceneStore(store),
    scratch: new SnapCandidateScratch(),
    store,
    targets,
  };
}

function warmLookup(
  targets: readonly ReturnType<typeof rectangle>[],
  lookup: (target: ReturnType<typeof rectangle>, frame: number) => unknown,
  label: string,
): void {
  for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
    const target = targets[(frame * 17) % targets.length]!;
    if (lookup(target, frame) === null) {
      throw new Error(`${label} warm-up did not find its target.`);
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
  const pointer = {
    x: target.x + (frame % 3) * 0.1,
    y: target.y + (frame % 5) * 0.1,
  };
  return findSnapCandidate(
    {
      current: null,
      pointer,
      pointerType: "pen",
      zoom: 1,
    },
    sceneStore,
    { get: (id) => sceneStore.getSnapTarget(id) },
    scratch,
  );
}

function findMoveSnap(
  sceneStore: ElementSceneStore,
  scratch: SnapCandidateScratch,
  moving: ReturnType<typeof connectedLine>,
  selectedIds: ReadonlySet<string>,
  target: ReturnType<typeof rectangle>,
  frame: number,
) {
  const rawDelta = {
    x: target.x + (frame % 3) * 0.1,
    y: target.y + (frame % 5) * 0.1,
  };
  return resolveSelectionMoveSnap({
    current: null,
    elements: [moving],
    pointerType: "pen",
    rawDelta,
    scratch,
    selectedIds,
    spatial: sceneStore,
    targets: { get: (id) => sceneStore.getSnapTarget(id) },
    zoom: 1,
  });
}

function expectSnapProfile(input: {
  readonly allocationsBefore: number;
  readonly matched: number;
  readonly p99: number;
  readonly scratch: SnapCandidateScratch;
  readonly store: ElementStore;
}): void {
  expect(input.matched).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
  expect(input.scratch.allocationCount).toBe(input.allocationsBefore);
  expect(input.store.instrumentation.fullStoreScans).toBe(0);
  expectTiming(input.p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
}
