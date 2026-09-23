import { movingSnapLine } from "./connected-input-fixture";
import { describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../src/domain/settings/defaults";
import { resolvePointAngleSnap } from "../../../src/editor/selection/angular-snap";
import { ElementStore } from "../../../src/domain/store/public";
import {
  ConnectedSelectionPreviewSession,
  resolveSelectionMoveSnap,
} from "../../../src/editor/selection/public";
import {
  findSnapCandidate,
  SnapCandidateScratch,
} from "../../../src/editor/snapping/snap-candidate";
import { CreationPreview } from "../../../src/obsidian/embeds/active-editor/creation-preview";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { creationPreviewRenderer } from "../../fixtures/obsidian/active-editor";
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
    populateScratch(
      targets,
      (target, frame) => findCandidate(sceneStore, scratch, target, frame),
      "Snap-candidate",
    );
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

  it("keeps reverse-map connection previews with bounded work", () => {
    const { selectedIds, store, target } = createConnectedTranslationFixture();
    const session = new ConnectedSelectionPreviewSession(store, [target], selectedIds);
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
    });

    expect(previewCount).toBe(CONNECTED_DEPENDENT_COUNT * INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: 0,
    });
  });

  it("keeps whole-line endpoint snapping with bounded work", () => {
    const { sceneStore, scratch, store, targets } = createSnapFixture();
    const moving = movingSnapLine();
    const selectedIds = new Set([moving.id]);
    let matched = 0;
    populateScratch(
      targets,
      (target, frame) => findMoveSnap(sceneStore, scratch, moving, selectedIds, target, frame),
      "Selection-move snap",
    );
    store.resetInstrumentation();
    const allocationsBefore = scratch.allocationCount;

    runInteractionFrames((frame) => {
      const target = targets[(frame * 17) % targets.length]!;
      if (findMoveSnap(sceneStore, scratch, moving, selectedIds, target, frame) !== null)
        matched += 1;
    });

    expectSnapProfile({ allocationsBefore, matched, scratch, store });

    sceneStore.release();
  });
});

describe("multi-selection snap work", () => {
  it("skips indexed endpoint lookup at every refresh rate for group movement", () => {
    const { sceneStore, scratch, store, targets } = createSnapFixture();
    const query = vi.spyOn(sceneStore, "query");
    const read = vi.spyOn(sceneStore, "getSnapTarget");
    const moving = movingSnapLine();
    const selectedIds = new Set([moving.id, targets[1]!.id]);
    const allocations = scratch.allocationCount;
    store.resetInstrumentation();
    runInteractionFrames((frame) => {
      expect(findMoveSnap(sceneStore, scratch, moving, selectedIds, targets[0]!, frame)).toBeNull();
    });
    expect(query).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(scratch.allocationCount).toBe(allocations);
    expect(store.instrumentation.fullStoreScans).toBe(0);
    sceneStore.release();
  });
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

function populateScratch(
  targets: readonly ReturnType<typeof rectangle>[],
  lookup: (target: ReturnType<typeof rectangle>, frame: number) => unknown,
  label: string,
): void {
  for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
    const target = targets[(frame * 17) % targets.length]!;
    if (lookup(target, frame) === null) {
      throw new Error(`${label} scratch initialization did not find its target.`);
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
  readonly scratch: SnapCandidateScratch;
  readonly store: ElementStore;
}): void {
  expect(input.matched).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
  expect(input.scratch.allocationCount).toBe(input.allocationsBefore);
  expect(input.store.instrumentation.fullStoreScans).toBe(0);
}
