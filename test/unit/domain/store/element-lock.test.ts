import { expect, it } from "vitest";

import type { InkElementV1, LineElementV1 } from "../../../../src/domain/schema/public";
import {
  ElementStore,
  LockedElementMutationError,
  withElementLock,
} from "../../../../src/domain/store/public";
import { connectedLine, highlighter, IDS, PAGE, rectangle } from "./fixtures";

const scheduler = {
  shouldYield: () => false,
  yieldControl: async () => undefined,
};
const protectedEdit = { ...scheduler, protectLocked: true };

it("updates only interaction state and replays the exact previous mixed locks", async () => {
  const locked = { ...rectangle(), locked: true };
  const store = new ElementStore([locked, highlighter()]);
  const original = [store.get(locked.id)!, store.get(IDS.highlight)!];
  const prepared = await store.prepareElementReplacement(
    original.map(({ element }) => withElementLock(element, true)),
    scheduler,
  );
  expect(store.lockedCount).toBe(1);
  expect(prepared.status).toBe("prepared");
  const committed = store.commitPreparedElementReplacement(prepared.token!);
  expect(store.lockedCount).toBe(2);
  expect(committed.delta?.changes).toHaveLength(1);
  expect(committed.delta?.changes[0]?.domains).toEqual(["interaction"]);
  expect(store.get(locked.id)).toBe(original[0]);
  const changed = store.get(IDS.highlight)!;
  expect(changed.bounds).toBe(original[1]!.bounds);
  expect(changed.geometryVersion).toBe(original[1]!.geometryVersion);
  expect(changed.paintVersion).toBe(original[1]!.paintVersion);
  expect(changed.element.kind === "stroke" && changed.element.points).toBe(
    original[1]!.element.kind === "stroke" && original[1]!.element.points,
  );
  const history = committed.history!;
  const undo = await store.prepareElementReplacement(
    history.previous as readonly InkElementV1[],
    scheduler,
  );
  expect(store.commitPreparedElementReplacement(undo.token!).status).toBe("committed");
  expect(store.lockedCount).toBe(1);
  expect(store.get(IDS.highlight)?.element.locked).not.toBe(true);
  const redo = await store.prepareElementReplacement(
    history.replacements as readonly InkElementV1[],
    scheduler,
  );
  expect(store.commitPreparedElementReplacement(redo.token!).status).toBe("committed");
  expect(store.lockedCount).toBe(2);
  expect(
    await store.prepareElementReplacement(
      [withElementLock(store.get(IDS.highlight)!.element, true)],
      scheduler,
    ),
  ).toEqual({ status: "noop", token: null });
});

it("rejects direct protected edits but leaves ordinary history replay available", async () => {
  const box = { ...rectangle(), locked: true };
  const store = new ElementStore([box]);
  const moved = { ...rectangle(box.id, 200, 150), locked: true };
  await expect(store.prepareElementReplacement([moved], protectedEdit)).rejects.toThrow(
    LockedElementMutationError,
  );
  expect(store.get(box.id)?.element).toMatchObject({ x: box.x });
  expect(store.mutationVersion).toBe(0);
  const historical = await store.prepareElementReplacement([moved], scheduler);
  expect(store.commitPreparedElementReplacement(historical.token!).status).toBe("committed");
  expect(store.get(box.id)?.element).toMatchObject({ x: 200, y: 150, locked: true });
});

it("rejects a changed locked dependent atomically while permitting unchanged anchors", async () => {
  const box = rectangle();
  const line = { ...connectedLine(box), locked: true };
  const store = new ElementStore([box, line]);
  const previousBox = store.get(box.id);
  const previousLine = store.get(line.id);
  await expect(
    store.prepareElementReplacement([rectangle(box.id, 200, 150)], protectedEdit),
  ).rejects.toThrow(LockedElementMutationError);
  expect(store.get(box.id)).toBe(previousBox);
  expect(store.get(line.id)).toBe(previousLine);
  expect(store.mutationVersion).toBe(0);

  const resized = rectangle();
  resized.width += 10;
  resized.pivot.x += 5;
  const allowed = await store.prepareElementReplacement([resized], protectedEdit);
  expect(store.commitPreparedElementReplacement(allowed.token!).status).toBe("committed");
  expect(store.get(line.id)).toBe(previousLine);
});

it("rejects protected target removal that would detach a locked connection", async () => {
  const box = rectangle();
  const store = new ElementStore([box, { ...connectedLine(box), locked: true }]);
  await expect(store.prepareElementRemoval([box.id], protectedEdit)).rejects.toThrow(
    LockedElementMutationError,
  );
  await expect(store.prepareElementRemoval([IDS.line], protectedEdit)).rejects.toThrow(
    LockedElementMutationError,
  );
  expect(store.size).toBe(2);
  expect(store.lockedCount).toBe(1);
  expect(store.mutationVersion).toBe(0);
});

it("uses the same transitive lock conflict in preview planning and prepared commits", async () => {
  const box = rectangle();
  const first = connectedLine(box);
  const second: LineElementV1 = {
    ...connectedLine(box),
    id: IDS.other,
    start: { ...first.start },
    startConnection: {
      targetId: first.id,
      anchor: { kind: "linear-endpoint", endpoint: "start" },
    },
    locked: true,
  };
  const store = new ElementStore([box, first, second]);
  const changed = [rectangle(box.id, 200, 150)];
  expect(() => store.planReplacements(changed, { protectLocked: true })).toThrow(
    LockedElementMutationError,
  );
  await expect(store.prepareElementReplacement(changed, protectedEdit)).rejects.toThrow(
    LockedElementMutationError,
  );
  await expect(store.planReplacementsTimeSliced(changed, protectedEdit)).rejects.toThrow(
    LockedElementMutationError,
  );
  expect(store.mutationVersion).toBe(0);
  expect(store.get(first.id)?.element).toMatchObject({ start: first.start });
  expect(store.get(second.id)?.element).toMatchObject({ start: second.start });
});

it("protects explicit arrangement while permitting rank shifts around a fixed locked record", async () => {
  const fixed = { ...rectangle(), locked: true };
  const store = new ElementStore([fixed, rectangle(IDS.other)]);
  await expect(
    store.prepareElementArrangement("bring-to-front", new Set([fixed.id]), protectedEdit),
  ).rejects.toThrow(LockedElementMutationError);
  const ready = await store.prepareElementArrangement(
    "send-to-back",
    new Set([IDS.other]),
    protectedEdit,
  );
  expect(store.commitPreparedElementMutation(ready.token!).status).toBe("committed");
  expect(store.getRank(fixed.id)?.rank).toBe(1);
  expect(store.lockedCount).toBe(1);
});

it("retains locks through creation, snapshot materialization and removal history", async () => {
  const box = { ...rectangle(), locked: true };
  const store = new ElementStore([box]);
  const snapshot = store.materializeSnapshot({ page: PAGE, revision: 0 });
  expect(snapshot.version).toBe(4);
  expect(snapshot.elements[0]?.locked).toBe(true);
  const removed = await store.prepareElementRemoval([box.id], scheduler);
  const applied = store.commitPreparedElementMutation(removed.token!).transition!;
  expect(store.lockedCount).toBe(0);
  const restored = await store.prepareHistoryReplay(applied.reverse, scheduler, applied);
  expect(store.commitPreparedElementMutation(restored.token!).status).toBe("committed");
  expect(store.lockedCount).toBe(1);
  expect(store.get(box.id)?.element.locked).toBe(true);
});

it("counts locked records after cooperative hydration and rejects stale lock commits", async () => {
  const box = { ...rectangle(), locked: true };
  const store = (await ElementStore.createTimeSliced([box, highlighter()], scheduler))!;
  expect(store.lockedCount).toBe(1);
  const prepared = await store.prepareElementReplacement(
    [withElementLock(store.get(IDS.highlight)!.element, true)],
    scheduler,
  );
  store.create(rectangle(IDS.other));
  expect(store.commitPreparedElementReplacement(prepared.token!).status).toBe("cancelled");
  expect(store.lockedCount).toBe(1);
  store.remove([box.id]);
  expect(store.lockedCount).toBe(0);
});

it("cancels a partially prepared lock batch without publishing any status change", async () => {
  const store = new ElementStore([rectangle(), highlighter()]);
  let cancelled = false;
  const prepared = await store.prepareElementReplacement(
    [IDS.target, IDS.highlight].map((id) => withElementLock(store.get(id)!.element, true)),
    {
      isCancelled: () => cancelled,
      shouldYield: () => true,
      yieldControl: async () => {
        cancelled = true;
      },
    },
  );
  expect(prepared).toEqual({ status: "cancelled", token: null });
  expect(store.lockedCount).toBe(0);
  expect(store.mutationVersion).toBe(0);
});
