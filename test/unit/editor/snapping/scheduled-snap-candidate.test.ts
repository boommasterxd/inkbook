import { describe, expect, it, vi } from "vitest";

import { semanticAnchors } from "../../../../src/domain/geometry/anchors";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../src/domain/store/public";
import { SpatialQueryCursor } from "../../../../src/domain/spatial/query-cursor";
import { createDragElement } from "../../../../src/editor/tools/public";
import {
  findSnapCandidate,
  SnapCandidateScratch,
} from "../../../../src/editor/snapping/snap-candidate";
import { ScheduledSnapCandidate } from "../../../../src/editor/snapping/scheduled-snap-candidate";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";
import { uuid } from "../../domain/schema/fixtures";

const defaults = createBuiltInSettings().toolDefaults;
const input = {
  current: null,
  pointer: { x: 150, y: 150 },
  pointerType: "mouse",
  zoom: 1,
} as const;

function anchorElement(tool: Parameters<typeof createDragElement>[0]["tool"] = "rectangle") {
  return createDragElement({
    defaults,
    end: { x: 200, y: 200 },
    identity: { createdAt: 1, id: uuid(1) },
    start: { x: 100, y: 100 },
    tool,
  });
}

function singleTarget() {
  const element = anchorElement();
  const store = new ElementStore([element]);
  return { element, store, scene: new ElementSceneStore(store) };
}

function targets(scene: ElementSceneStore) {
  return {
    get: (id: string, bounds?: Parameters<ElementSceneStore["getSnapTarget"]>[1]) =>
      scene.getSnapTarget(id, bounds),
  };
}

describe("scheduled snap candidate correctness", () => {
  it.each([
    "rectangle",
    "ellipse",
    "triangle",
    "octagon",
    "parallelogram",
    "diamond",
    "table",
    "coordinate-system",
    "line",
    "arrow",
  ] as const)(
    "matches exact %s anchors and tie ordering through interrupted lookup",
    async (tool) => {
      const element = anchorElement(tool);
      const rotated = { ...element, rotation: 37 };
      const store = new ElementStore([rotated, { ...rotated, id: uuid(2) }]);
      const scene = new ElementSceneStore(store);
      const anchors = store.getSemanticAnchors(element.id)!;
      const advance = vi.spyOn(SpatialQueryCursor.prototype, "advance");
      let sliceStart = 0;
      const scheduler = {
        ...immediateWorkScheduler(),
        shouldYield: () => advance.mock.calls.length - sliceStart >= 2,
        checkpoint: () => {
          sliceStart = advance.mock.calls.length;
          return Promise.resolve();
        },
      };
      const lookup = new ScheduledSnapCandidate(scene, targets(scene), scheduler);
      try {
        for (const anchor of anchors) {
          const request = { ...input, pointer: anchor.point };
          const expected = findSnapCandidate(
            request,
            scene,
            targets(scene),
            new SnapCandidateScratch(),
          );
          lookup.update(request, () => undefined);
          expect(await lookup.settle()).toEqual(expected);
          expect(lookup.value?.targetId).toBe(uuid(2));
          expect(lookup.memoryUsage()).toBe(0);
        }
      } finally {
        lookup.cancel();
        advance.mockRestore();
        scene.release();
      }
    },
  );
});

describe("scheduled snap lifetime", () => {
  it("retains a valid current anchor without starting an indexed query", () => {
    const { element, scene } = singleTarget();
    const lookup = new ScheduledSnapCandidate(scene, targets(scene), immediateWorkScheduler());
    lookup.update({ ...input, pointer: { x: 100, y: 100 } }, () => undefined);
    const current = lookup.value;
    const begin = vi.spyOn(scene, "beginQuery");
    lookup.update({ ...input, current, pointer: { x: 115.9, y: 100 } }, () => undefined);
    expect(lookup.value?.targetId).toBe(element.id);
    expect(begin).not.toHaveBeenCalled();
    expect(lookup.pending).toBe(false);
    lookup.update({ ...input, current, pointer: { x: 116.1, y: 100 } }, () => undefined);
    expect(lookup.value).toBeNull();
    expect(begin).toHaveBeenCalledOnce();
    scene.release();
  });

  it.each(["cancel", "replace", "retarget"] as const)(
    "discards a suspended query on %s and releases its cursor",
    async (action) => {
      const { element, store, scene } = singleTarget();
      let release: () => void = () => undefined;
      let paused = true;
      const scheduler = {
        ...immediateWorkScheduler(),
        shouldYield: () => paused,
        checkpoint: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      };
      const ready = vi.fn();
      const lookup = new ScheduledSnapCandidate(scene, targets(scene), scheduler);
      lookup.update({ ...input, pointer: { x: 100, y: 100 } }, ready);
      const pending = lookup.settle();
      expect(lookup.memoryUsage()).toBe(512);
      if (action === "cancel") lookup.cancel();
      else if (action === "replace") store.remove([element.id]);
      else {
        paused = false;
        lookup.update(input, ready);
      }
      paused = false;
      release();
      expect(await pending).toBe("cancelled");
      expect(lookup.memoryUsage()).toBe(0);
      expect(ready).not.toHaveBeenCalled();
      if (action === "retarget") expect(lookup.value).toBeNull();
      scene.release();
    },
  );
});

describe("semantic anchor bounds rejection", () => {
  it.each(["rectangle", "ellipse", "table"] as const)(
    "keeps every canonical rotated %s anchor including point-sized queries",
    (tool) => {
      const element = anchorElement(tool);
      const store = new ElementStore([{ ...element, rotation: 37 }]);
      const scene = new ElementSceneStore(store);
      for (const anchor of semanticAnchors({ ...element, rotation: 37 } as Parameters<
        typeof semanticAnchors
      >[0])) {
        const bounds = {
          minX: anchor.point.x,
          maxX: anchor.point.x,
          minY: anchor.point.y,
          maxY: anchor.point.y,
        };
        expect(scene.getSnapTarget(element.id, bounds)?.anchors).toContainEqual(anchor);
      }
      scene.release();
    },
  );
});

describe("snap publication revision", () => {
  it("requeries when another target moves between the final cursor advance and publication", async () => {
    const make = (id: number, x: number) =>
      createDragElement({
        defaults,
        identity: { id: uuid(id), createdAt: id },
        tool: "rectangle",
        start: { x, y: 100 },
        end: { x: x + 100, y: 200 },
      });
    const first = make(1, 100);
    const second = make(2, 300);
    const store = new ElementStore([first, second]);
    const scene = new ElementSceneStore(store);
    let yielded = false;
    let mutationQueued = false;
    const published: string[] = [];
    const lookup = new ScheduledSnapCandidate(
      scene,
      {
        get: (id, bounds) => {
          if (!mutationQueued) {
            mutationQueued = true;
            queueMicrotask(() => store.replace(second.id, make(2, 100)));
          }
          return scene.getSnapTarget(id, bounds);
        },
      },
      {
        ...immediateWorkScheduler(),
        shouldYield: () => !yielded,
        checkpoint: () => {
          yielded = true;
          return Promise.resolve();
        },
      },
    );
    lookup.update({ ...input, pointer: { x: 100, y: 100 } }, () => {
      published.push(lookup.value!.targetId);
    });
    const result = await lookup.settle();
    expect(result === "cancelled" ? null : result?.targetId).toBe(second.id);
    expect(published).toEqual([second.id]);
    lookup.cancel();
    scene.release();
  });
});
