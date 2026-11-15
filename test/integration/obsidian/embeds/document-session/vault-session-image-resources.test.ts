import { DocumentWorkerRuntime } from "../../../../../src/persistence/worker/runtime/public";
import { withElementLock } from "../../../../../src/domain/store/public";
import { expect, it, vi } from "vitest";
import { validImageFixture } from "../../../../fixtures/persistence/images";
import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import { operation, persistenceHarness } from "./vault-session-fixtures";

it("admits before mutation and persists/reopens only referenced image resources", async () => {
  const { asset, element: source } = await validImageFixture();
  const element = { ...source, contrast: "light" as const };
  const execute = vi.spyOn(DocumentWorkerRuntime.prototype, "execute");
  const harness = persistenceHarness();
  let reopened: ReturnType<typeof persistenceHarness> | undefined;
  try {
    expect((await harness.session.unlock(operation())).status).toBe("active");
    const model = harness.session.documentModel!;
    const snapshot = vi.spyOn(model.store, "materializeSnapshot");
    await model.addImageResources!([asset]);
    expect(model.revision).toBe(7);
    expect(model.store.size).toBe(0);
    expect(snapshot).not.toHaveBeenCalled();
    model.commitElement(element);
    expect(model.revision).toBe(8);
    expect((await harness.session.lockLatest(operation())).status).toBe("confirmed");
    const initialExports = execute.mock.calls
      .map(([request]) => request)
      .filter((request) => request.type === "export-incremental");
    expect(initialExports[0]).toHaveProperty("imageResources", [asset]);
    model.replaceElements([
      { ...element, x: element.x + 10, pivot: { ...element.pivot, x: element.pivot.x + 10 } },
    ]);
    expect((await harness.session.lockLatest(operation())).status).toBe("confirmed");
    const movementExports = execute.mock.calls
      .map(([request]) => request)
      .filter((request) => request.type === "export-incremental");
    const movement = movementExports[movementExports.length - 1];
    expect(movement).not.toHaveProperty("imageResources");
    const initialRuntime = execute.mock.contexts[0] as DocumentWorkerRuntime;
    initialRuntime.terminate();
    expect(await model.encodeClipboard(new Set([element.id]))).not.toBeNull();
    const fullSync = execute.mock.calls
      .map(([request]) => request)
      .find((request) => request.type === "model-sync-full");
    expect(fullSync).toHaveProperty("snapshot.imageResources", [asset]);
    const saved = await parseInkbookDocumentForTest(harness.content());
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.snapshot).toMatchObject({
      version: 5,
      imageResources: [asset],
      elements: [
        { ...element, x: element.x + 10, pivot: { ...element.pivot, x: element.pivot.x + 10 } },
      ],
    });
    reopened = persistenceHarness(saved.value.snapshot);
    expect((await reopened.session.unlock(operation())).status).toBe("active");
    expect(reopened.session.documentModel!.imageResource!(asset.id)).toEqual(asset);
    const copy = await reopened.session.documentModel!.encodeClipboard(new Set([element.id]));
    expect(JSON.parse(copy!.customText)).toMatchObject({ version: 5, imageResources: [asset] });
    model.removeElements([element.id]);
    expect(model.imageResource!(asset.id)).toEqual(asset);
    expect((await harness.session.lockLatest(operation())).status).toBe("confirmed");
    const removed = await parseInkbookDocumentForTest(harness.content());
    if (!removed.ok) throw new Error(removed.error.message);
    expect(removed.value.snapshot.imageResources ?? []).toEqual([]);
    model.commitElement(element);
    expect((await harness.session.lockLatest(operation())).status).toBe("confirmed");
  } finally {
    execute.mockRestore();
    reopened?.session.dispose();
    harness.session.dispose();
  }
});

it("adopts pasted resources without a separate revision and rejects collisions before element insertion", async () => {
  const { asset, element } = await validImageFixture();
  const source = persistenceHarness();
  const target = persistenceHarness();
  try {
    await source.session.unlock(operation());
    await target.session.unlock(operation());
    const sourceModel = source.session.documentModel!;
    const targetModel = target.session.documentModel!;
    await sourceModel.addImageResources!([asset]);
    sourceModel.commitElement(element);
    const copy = await sourceModel.encodeClipboard(new Set([element.id]));
    const plan = await targetModel.planClipboardPaste(
      { customText: copy!.customText },
      { kind: "toolbar", visibleCanvasCenter: { x: 300, y: 300 } },
    );
    expect(plan?.imageResources).toEqual([asset]);
    expect(targetModel.revision).toBe(7);
    expect(targetModel.store.size).toBe(0);
    await expect(targetModel.addImageResources!([{ ...asset, width: 2 }])).rejects.toThrow(
      "Conflicting image resource identity",
    );
    expect(targetModel.store.size).toBe(0);
    targetModel.commitElements(plan!.elements);
    expect((await target.session.lockLatest(operation())).status).toBe("confirmed");
    const persisted = await parseInkbookDocumentForTest(target.content());
    if (!persisted.ok) throw new Error(persisted.error.message);
    expect(persisted.value.snapshot.imageResources).toEqual([asset]);
    expect(persisted.value.snapshot.elements.map(({ id }) => id)).toEqual(plan!.selectedIds);
  } finally {
    source.session.dispose();
    target.session.dispose();
  }
});

it("persists a lock-only change through the worker and reopens locked images without losing resources", async () => {
  const { asset, element } = await validImageFixture();
  const harness = persistenceHarness();
  let reopened: ReturnType<typeof persistenceHarness> | undefined;
  try {
    await harness.session.unlock(operation());
    const model = harness.session.documentModel!;
    await model.addImageResources!([asset]);
    model.commitElement(element);
    expect((await harness.session.lockLatest(operation())).status).toBe("confirmed");

    const before = model.store.get(element.id)!;
    const prepared = await model.prepareElementReplacement(
      [withElementLock(before.element, true)],
      { isCancelled: () => false, protectLocked: false },
    );
    if (prepared.token === null) throw new Error("Expected a prepared element lock.");
    expect(model.commitPreparedElementReplacement(prepared.token)).toBe("committed");
    expect(model.formatVersion).toBe(5);
    expect(model.store.get(element.id)?.geometryVersion).toBe(before.geometryVersion);
    expect((await harness.session.lockLatest(operation())).status).toBe("confirmed");

    const saved = await parseInkbookDocumentForTest(harness.content());
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.snapshot).toMatchObject({
      version: 5,
      elements: [{ ...element, locked: true }],
      imageResources: [asset],
    });
    reopened = persistenceHarness(saved.value.snapshot);
    expect((await reopened.session.unlock(operation())).status).toBe("active");
    const reopenedModel = reopened.session.documentModel!;
    expect(reopenedModel.formatVersion).toBe(5);
    expect(reopenedModel.imageResource!(asset.id)).toEqual(asset);
    const copy = await reopenedModel.encodeClipboard(new Set([element.id]));
    expect(JSON.parse(copy!.customText)).toMatchObject({
      version: 5,
      elements: [{ element: { locked: true } }],
      imageResources: [asset],
    });
  } finally {
    reopened?.session.dispose();
    harness.session.dispose();
  }
});
