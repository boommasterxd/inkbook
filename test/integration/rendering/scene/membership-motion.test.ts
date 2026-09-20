import { describe, expect, it, vi } from "vitest";

import * as motionVisual from "../../../../src/rendering/scene/motion-visual";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { snapshot } from "../../../unit/domain/schema/fixtures";
import { FakeSceneStore, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

describe.each(["restore", "remove"] as const)("motion during %s", (membership) => {
  it.each(["order", "paint", "geometry"] as const)(
    "preserves only explicit %s motion on survivors",
    (domain) => {
      const store = new FakeSceneStore();
      const target = fakeRectangleRecord("target", 0, 10);
      const survivor = fakeRectangleRecord("survivor", membership === "remove" ? 1 : 0, 40);
      store.records.set(survivor.id, survivor);
      if (membership === "remove") store.records.set(target.id, target);
      const { renderer, scheduler } = createSceneFixture(snapshot().page, store);
      scheduler.runAll();
      renderer.resetInstrumentation();
      const createVisual = vi.spyOn(motionVisual, "createMotionVisual");
      try {
        const before = survivor.element;
        if (before.kind !== "rectangle") throw new Error("Expected rectangle fixture.");
        const after = {
          ...before,
          width: before.width + (domain === "geometry" ? 20 : 0),
          style: {
            ...before.style,
            outlineOpacity: domain === "paint" ? 0.5 : before.style.outlineOpacity,
          },
        };
        store.records.set(survivor.id, {
          ...survivor,
          element: after,
          rank: membership === "remove" ? 0 : 1,
          geometryVersion: survivor.geometryVersion + (domain === "geometry" ? 1 : 0),
          paintVersion: survivor.paintVersion + (domain === "paint" ? 1 : 0),
        });
        if (membership === "remove") {
          renderer.setElementFade([target.id], 0);
          store.records.delete(target.id);
        } else store.records.set(target.id, target);
        renderer.applyDelta({
          affected: [
            {
              id: survivor.id,
              before,
              after,
              domains: domain === "order" ? ["order"] : [domain, "order"],
            },
            {
              id: target.id,
              before: membership === "remove" ? target.element : null,
              after: membership === "remove" ? null : target.element,
              domains: ["visibility"],
            },
          ],
        });
        expect(createVisual).toHaveBeenCalledTimes(domain === "paint" ? 1 : 0);
        expect(renderer.instrumentation()).toMatchObject({
          motionCrossfades: domain === "paint" ? 1 : 0,
          motionGeometryTransitions: domain === "geometry" ? 1 : 0,
        });
        scheduler.runAll();
        expect(renderer.mountedIds("content")).toEqual(
          membership === "remove" ? [survivor.id] : [target.id, survivor.id],
        );
        expect(renderer.instrumentation().motionCacheEntries).toBe(0);
      } finally {
        createVisual.mockRestore();
        renderer.destroy();
      }
    },
  );
});
