import { describe, expect, it } from "vitest";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ScheduledMoveSnap } from "../../../../../src/editor/selection/transform/scheduled-move-snap";
import { moveSelectionWithSnap } from "../../../../../src/editor/selection/transform/move-snap";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import {
  immediateWorkScheduler,
  pausedWorkScheduler,
} from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { connectedLine, rectangle } from "../../../domain/store/fixtures";

describe("scheduled line movement snapping", () => {
  it.each([false, true])(
    "settles exact free-endpoint geometry and releases cancelled=%s work",
    async (cancelled) => {
      const target = rectangle();
      const source = {
        ...connectedLine(target),
        start: { x: 50, y: 50 },
        end: { x: 350, y: 50 },
        pivot: { x: 200, y: 50 },
        startConnection: null,
      };
      const store = new ElementStore([target, source]);
      const scene = new ElementSceneStore(store);
      await scene.prepareConnections(source.id, immediateWorkScheduler());
      const { scheduler, resume } = pausedWorkScheduler();
      const lookup = new ScheduledMoveSnap({
        canConnect: (sourceId, targetId) => scene.canConnect(sourceId, targetId),
        element: source,
        pointerType: "mouse",
        scheduler,
        spatial: scene,
        targets: { get: (id, bounds) => scene.getSnapTarget(id, bounds) },
      });
      lookup.update({ x: 47, y: 48 }, null, 1, () => undefined);
      expect(lookup.pending).toBe(true);
      expect(lookup.value).toBeNull();
      const pending = lookup.settle();
      if (cancelled) lookup.cancel();
      resume();
      const snap = await pending;
      if (cancelled) expect(snap).toBe("cancelled");
      else {
        expect(snap).toMatchObject({
          delta: { x: 50, y: 50 },
          endpoint: "start",
          candidate: { targetId: target.id },
        });
        if (snap === "cancelled") throw new Error("Expected a completed snap.");
        expect(moveSelectionWithSnap([source], snap!.delta, snap)[0]).toMatchObject({
          start: { x: 100, y: 100 },
          end: { x: 400, y: 100 },
          startConnection: { targetId: target.id },
        });
      }
      expect(lookup.pending).toBe(false);
      lookup.cancel();
      scene.release();
    },
  );
});
