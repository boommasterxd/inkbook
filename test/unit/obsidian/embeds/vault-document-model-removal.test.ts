import { expect, it, vi } from "vitest";

import { ElementStore, type StoreSliceScheduler } from "../../../../src/domain/store/public";
import { prepareVaultElementRemoval } from "../../../../src/obsidian/embeds/vault-document-model";
import { rectangle } from "../../domain/store/fixtures";

function removalOptions(store: ElementStore, isCancelled = () => false) {
  const scheduler = vi.fn((cancelled: () => boolean): StoreSliceScheduler => ({
    isCancelled: cancelled,
    shouldYield: () => false,
    yieldControl: () => Promise.resolve(),
  }));
  return {
    active: true,
    cancellation: { isCancelled },
    ids: new Set([rectangle().id]),
    scheduler,
    store,
  };
}

it("prepares a retained removal and preserves Undo through the Vault model boundary", async () => {
  const element = rectangle();
  const store = new ElementStore([element]);
  const prepare = vi.spyOn(store, "prepareElementRemoval");
  const options = removalOptions(store);
  const result = await prepareVaultElementRemoval(options);

  expect(prepare).toHaveBeenCalledOnce();
  expect(result.status).toBe("prepared");
  expect(store.size).toBe(1);
  if (result.token === null) throw new Error("Expected a prepared removal.");
  const removed = store.commitPreparedElementMutation(result.token);
  expect(store.size).toBe(0);
  expect(removed.transition?.retainedOnly).toBe(true);
  if (removed.transition === null) throw new Error("Expected a retained history transition.");
  const scheduler = options.scheduler(() => false);
  const undo = await store.prepareHistoryReplay(
    removed.transition.reverse,
    scheduler,
    removed.transition,
  );
  if (undo.token === null) throw new Error("Expected prepared Undo.");
  expect(store.commitPreparedElementMutation(undo.token).status).toBe("committed");
  expect(store.get(element.id)?.element).toEqual(element);
});

it("rejects inactive Vault removal without starting preparation", async () => {
  const store = new ElementStore([rectangle()]);
  const prepare = vi.spyOn(store, "prepareElementRemoval");
  const options = { ...removalOptions(store), active: false };

  await expect(prepareVaultElementRemoval(options)).resolves.toEqual({
    status: "cancelled",
    token: null,
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(options.scheduler).not.toHaveBeenCalled();
  expect(store.size).toBe(1);
});

it("passes cancellation into retained preparation without publishing a removal", async () => {
  const store = new ElementStore([rectangle()]);
  const options = removalOptions(store, () => true);

  await expect(prepareVaultElementRemoval(options)).resolves.toEqual({
    status: "cancelled",
    token: null,
  });
  expect(store.size).toBe(1);
});
