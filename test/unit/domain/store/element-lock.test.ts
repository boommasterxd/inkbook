import { expect, it } from "vitest";

import { ElementStore, LockedElementMutationError } from "../../../../src/domain/store/public";
import { connectedLine, IDS, rectangle } from "./fixtures";

const scheduler = {
  shouldYield: () => false,
  yieldControl: async () => undefined,
};
const protectedEdit = { ...scheduler, protectLocked: true };

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
