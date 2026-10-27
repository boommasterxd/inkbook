import { immediateWorkScheduler } from "../../fixtures/obsidian/immediate-work-scheduler";
import { movingSnapLine } from "./connected-input-fixture";
import { describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../src/domain/settings/defaults";
import { resolvePointAngleSnap } from "../../../src/editor/selection/transform/angular-snap";
import { ElementStore } from "../../../src/domain/store/public";
import { SpatialQueryCursor } from "../../../src/domain/spatial/query-cursor";
import { ScheduledSnapCandidate } from "../../../src/editor/snapping/scheduled-snap-candidate";
import { ConnectedSelectionPreviewSession } from "../../../src/editor/selection/public";
import { ScheduledMoveSnap } from "../../../src/editor/selection/transform/scheduled-move-snap";
import {
  findSnapCandidate,
  SnapCandidateScratch,
} from "../../../src/editor/snapping/snap-candidate";
import { CreationPreview } from "../../../src/obsidian/embeds/active-editor/previews/creation-preview";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { creationPreviewRenderer } from "../../fixtures/obsidian/active-editor";
import {
  anchorFreePoint,
  SNAP_TARGET_FAMILIES,
  snappingTarget,
} from "../../fixtures/editor/snapping-targets";
import { connectedLine, rectangle } from "../../unit/domain/store/fixtures";
import { INTERACTION_REFRESH_PROFILE, runInteractionFrames } from "../interaction-refresh-profile";
import {
  CONNECTED_DEPENDENT_COUNT,
  createConnectedTranslationFixture,
} from "./connected-translation-fixture";

const SNAP_TARGET_COUNT = 10_000;

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz snapping and connection profile`, () => {
  it("skips angular projection work before the screen-length activation threshold", () => {
    const angle = vi.spyOn(Math, "atan2");
    try {
      const input = { origin: { x: 0, y: 0 }, snapPixels: 5, stepDegrees: 90, zoom: 2 };
      for (const x of [0, 1, 3.999]) {
        expect(resolvePointAngleSnap({ ...input, point: { x, y: 0 } }).snapped).toBe(false);
      }
      expect(angle).not.toHaveBeenCalled();
      expect(resolvePointAngleSnap({ ...input, point: { x: 4, y: 0 } }).snapped).toBe(true);
      expect(angle).toHaveBeenCalledTimes(1);
    } finally {
      angle.mockRestore();
    }
  });

  it("keeps indexed semantic-anchor lookup with bounded work", () => {
    const { sceneStore, scratch, store, targets } = createSnapFixture();
    expect(findCandidate(sceneStore, scratch, targets[1_010]!, 0)).not.toBeNull();
    store.resetInstrumentation();
    const allocationsBefore = scratch.allocationCount;
    let matched = 0;

    runInteractionFrames((frame) => {
      const target = targets[(frame * 17) % targets.length]!;
      if (findCandidate(sceneStore, scratch, target, frame) !== null) matched += 1;
    });

    expectSnapProfile({ allocationsBefore, matched, scratch, store });

    sceneStore.release();
  });

  it("keeps reverse-map connection previews with bounded work", async () => {
    const { selectedIds, store, target } = createConnectedTranslationFixture();
    const session = new ConnectedSelectionPreviewSession(store, [target], selectedIds);
    await session.prepare(immediateWorkScheduler(), new AbortController().signal);
    session.update({ delta: { x: 1, y: 1 }, kind: "translate" });
    store.resetInstrumentation();
    let previewCount = 0;

    runInteractionFrames((frame) => {
      const preview = session.update({
        delta: {
          x: 2 + Math.sin(frame / 20),
          y: 2 + Math.cos(frame / 20),
        },
        kind: "translate",
      });
      previewCount += preview.elements.length;
      for (const id of preview.progressive?.ids ?? []) {
        if (preview.progressive?.materialize(id) !== undefined) previewCount += 1;
      }
    });

    expect(previewCount).toBe(CONNECTED_DEPENDENT_COUNT * INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: 0,
    });
    session.dispose();
  });

  it("keeps whole-line endpoint snapping with bounded work", () => {
    const { sceneStore, store, targets } = createSnapFixture();
    const moving = movingSnapLine();
    const selectedIds = new Set([moving.id]);
    const lookup = moveLookup(sceneStore, moving, selectedIds);
    let matched = 0;
    expect(findMoveSnap(lookup, targets[1_010]!, 0)).not.toBeNull();
    store.resetInstrumentation();
    const read = vi.spyOn(sceneStore, "getSnapTarget");

    runInteractionFrames((frame) => {
      const target = targets[(frame * 17) % targets.length]!;
      if (findMoveSnap(lookup, target, frame) !== null) matched += 1;
    });

    expect(matched).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    // At most six overlapping columns, three rows and two free endpoints.
    expect(read.mock.calls.length).toBeLessThanOrEqual(
      36 * INTERACTION_REFRESH_PROFILE.sampleCount,
    );
    expect(store.instrumentation.fullStoreScans).toBe(0);
    lookup.cancel();
    sceneStore.release();
  });
});

describe("multi-selection snap work", () => {
  it("skips indexed endpoint lookup at every refresh rate for group movement", () => {
    const { sceneStore, store, targets } = createSnapFixture();
    const query = vi.spyOn(sceneStore, "query");
    const begin = vi.spyOn(sceneStore, "beginQuery");
    const read = vi.spyOn(sceneStore, "getSnapTarget");
    const moving = movingSnapLine();
    const selectedIds = new Set([moving.id, targets[1]!.id]);
    const lookup = moveLookup(sceneStore, moving, selectedIds);
    store.resetInstrumentation();
    runInteractionFrames((frame) => {
      expect(findMoveSnap(lookup, targets[0]!, frame)).toBeNull();
    });
    expect(query).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(store.instrumentation.fullStoreScans).toBe(0);
    lookup.cancel();
    sceneStore.release();
  });
});

describe("dense anchor query work", () => {
  it.each(SNAP_TARGET_FAMILIES)(
    "yields inside a cold dense %s query without building anchors for misses",
    async (family) => {
      const target = snappingTarget(family, 37);
      const pointer = anchorFreePoint(target);
      const elements = Array.from({ length: SNAP_TARGET_COUNT }, (_, index) => ({
        ...target,
        id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      }));
      const store = new ElementStore(elements);
      const scene = new ElementSceneStore(store);
      const advance = vi.spyOn(SpatialQueryCursor.prototype, "advance");
      const read = vi.spyOn(store, "get");
      const anchors = vi.spyOn(store, "getSemanticAnchors");
      const hypot = vi.spyOn(Math, "hypot");
      const synchronousQuery = vi.spyOn(scene, "query");
      let sliceStart = 0;
      const slices: number[] = [];
      const scheduler = {
        ...immediateWorkScheduler(),
        shouldYield: () => advance.mock.calls.length - sliceStart >= 64,
        checkpoint: () => {
          slices.push(advance.mock.calls.length - sliceStart);
          sliceStart = advance.mock.calls.length;
          return Promise.resolve();
        },
      };
      const lookup = new ScheduledSnapCandidate(
        scene,
        {
          get: (id, bounds) => scene.getSnapTarget(id, bounds),
        },
        scheduler,
      );
      try {
        for (const offset of [0, 1, 2]) {
          const before = advance.mock.calls.length;
          sliceStart = before;
          lookup.update(
            {
              current: null,
              pointer: { x: pointer.x + offset, y: pointer.y },
              pointerType: "mouse",
              zoom: 1,
            },
            () => undefined,
          );
          expect(lookup.pending).toBe(true);
          expect(advance.mock.calls.length - before).toBe(64);
          expect(lookup.value).toBeNull();
          expect(lookup.memoryUsage()).toBeLessThanOrEqual(512 + SNAP_TARGET_COUNT * 32);
          expect(await lookup.settle()).toBeNull();
          expect(advance.mock.calls.length - before).toBeLessThanOrEqual(SNAP_TARGET_COUNT + 10);
          expect(lookup.memoryUsage()).toBe(0);
        }
        expect(slices.every((work) => work === 64)).toBe(true);
        expect(read).toHaveBeenCalledTimes(SNAP_TARGET_COUNT * 3);
        expect(anchors).not.toHaveBeenCalled();
        expect(hypot).not.toHaveBeenCalled();
        expect(synchronousQuery).not.toHaveBeenCalled();
        expect(store.instrumentation).toMatchObject({
          anchorBuilds: 0,
          anchorCacheEntries: 0,
          anchorCacheEvictions: 0,
          fullStoreScans: 0,
        });
      } finally {
        lookup.cancel();
        advance.mockRestore();
        read.mockRestore();
        anchors.mockRestore();
        hypot.mockRestore();
        synchronousQuery.mockRestore();
        scene.release();
      }
    },
  );
});

describe("straight highlighter creation work", () => {
  it("bounds preview writes and skips shape-anchor reads across a dense scene", () => {
    const { sceneStore, store } = createSnapFixture();
    const query = vi.spyOn(sceneStore, "query");
    const read = vi.spyOn(sceneStore, "getSnapTarget");
    const setLivePath = vi.fn();
    const setSnapMarkerPath = vi.fn();
    const preview = new CreationPreview({
      defaults: createBuiltInSettings().toolDefaults,
      history: new ActiveEditorHistory({
        commitBandOrder: vi.fn(),
        commitElements: vi.fn(),
        commitPage: vi.fn(),
        removeElements: vi.fn(),
        replaceElements: vi.fn(),
      }),
      identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
      renderer: creationPreviewRenderer({ setLivePath, setSnapMarkerPath }),
      snap: {
        pageToScreen: (point) => point,
        spatial: sceneStore,
        targets: { get: (id) => sceneStore.getSnapTarget(id) },
        zoom: 1,
      },
      start: {
        additive: false,
        kind: "tool-gesture",
        pointer: { pointerId: 1, pointerType: "pen", x: 100, y: 100 },
        tool: "straight-highlighter",
      },
    });
    store.resetInstrumentation();

    runInteractionFrames((frame) => {
      const point =
        frame % 3 === 0
          ? { x: 200, y: 104 }
          : frame % 3 === 1
            ? { x: 200, y: 110 }
            : { x: 105, y: 100 };
      preview.update({ pointerId: 1, pointerType: "pen", ...point });
    });

    expect(setLivePath).toHaveBeenCalledTimes(INTERACTION_REFRESH_PROFILE.sampleCount + 1);
    expect(setSnapMarkerPath).toHaveBeenCalledTimes(INTERACTION_REFRESH_PROFILE.sampleCount + 1);
    expect(query).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(store.instrumentation.fullStoreScans).toBe(0);
    preview.revert();
    expect(setLivePath).toHaveBeenLastCalledWith(null);
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

function moveLookup(
  sceneStore: ElementSceneStore,
  moving: ReturnType<typeof connectedLine>,
  selectedIds: ReadonlySet<string>,
) {
  return new ScheduledMoveSnap({
    element: selectedIds.size === 1 ? moving : undefined,
    canConnect: () => true,
    pointerType: "pen",
    scheduler: immediateWorkScheduler(),
    spatial: sceneStore,
    targets: { get: (id, bounds) => sceneStore.getSnapTarget(id, bounds) },
  });
}

function findMoveSnap(
  lookup: ScheduledMoveSnap,
  target: ReturnType<typeof rectangle>,
  frame: number,
) {
  const rawDelta = {
    x: target.x + (frame % 3) * 0.1,
    y: target.y + (frame % 5) * 0.1,
  };
  lookup.update(rawDelta, null, 1, () => undefined);
  return lookup.value;
}

function expectSnapProfile(input: {
  readonly allocationsBefore: number;
  readonly matched: number;
  readonly scratch: SnapCandidateScratch;
  readonly store: ElementStore;
}): void {
  expect(input.matched).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
  expect(input.scratch.allocationCount).toBe(input.allocationsBefore);
  expect(input.store.instrumentation.fullStoreScans).toBe(0);
}
