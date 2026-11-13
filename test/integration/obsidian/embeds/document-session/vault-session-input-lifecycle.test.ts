import { expect, it, vi } from "vitest";
import {
  expectRetainedInput,
  inputLifecycleCoordinator,
  unlockedInputSession,
} from "./vault-input-lifecycle-fixtures";
import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import {
  documentFromSnapshot,
  emptySnapshot,
  operation,
  persistenceHarness,
  rectangle,
} from "./vault-session-fixtures";

it.each(["detach", "lock"] as const)(
  "retains pending input through %s until preparation and persistence complete",
  async (action) => {
    const harness = persistenceHarness();
    const {
      coordinator,
      target,
      release: releaseScene,
      failed,
    } = inputLifecycleCoordinator(harness);
    await coordinator.requestActivation(target).outcome;
    const model = harness.session.documentModel!;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let unregister = () => undefined as void;
    unregister = model.registerExportPreparation!(async () => {
      await gate;
      model.commitElement(rectangle());
      unregister();
    });
    expect(harness.session.getSnapshot().dirty).toBe(true);
    if (action === "detach") coordinator.detachAttachment(target);
    else coordinator.requestLockCurrent();
    expect(releaseScene).not.toHaveBeenCalled();
    expect(harness.process).not.toHaveBeenCalled();
    resume();
    await vi.waitFor(() => expect(harness.process).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(releaseScene).toHaveBeenCalledOnce());
    expect(failed).not.toHaveBeenCalled();
    const parsed = await parseInkbookDocumentForTest(harness.content());
    expect(parsed.ok && parsed.value.snapshot.elements).toEqual([rectangle()]);
    coordinator.dispose();
  },
);

it("prepares pending input while its model remains writable before unloading the session", async () => {
  const { harness, model } = await unlockedInputSession();
  let unregister = () => undefined as void;
  unregister = model.registerExportPreparation!(async () => {
    model.commitElement(rectangle());
    unregister();
  });
  await harness.session.prepareForUnload();
  const parsed = await parseInkbookDocumentForTest(harness.content());
  expect(parsed.ok && parsed.value.snapshot.elements).toEqual([rectangle()]);
  expect(harness.factory.getDocumentModel("session-1")).toBeUndefined();
});

it("keeps failed detached input in its sole recovery session until a successful retry", async () => {
  const { harness, model } = await unlockedInputSession();
  let failure = true;
  let unregister = () => undefined as void;
  unregister = model.registerExportPreparation!(async () => {
    if (failure) throw new Error("Text layout failed.");
    model.commitElement(rectangle());
    unregister();
  });
  const release = vi.fn();
  const failed = vi.fn();
  harness.factory.deferPresentationRelease(operation().documentId, release, failed);
  await expect(harness.session.lockLatest(operation())).rejects.toThrow("Text layout failed.");
  expect(release).not.toHaveBeenCalled();
  expectRetainedInput(harness, model);
  expect(
    await harness.session.resolveRecovery("save-local-copy", { ...operation(), operationId: 2 }),
  ).toMatchObject({ status: "failed" });
  expect(harness.createdCopies.size).toBe(0);
  failure = false;
  expect(await harness.session.lockLatest(operation())).toMatchObject({ status: "confirmed" });
  expect(release).toHaveBeenCalledOnce();
  expect(harness.process).toHaveBeenCalledOnce();
  harness.session.dispose();
});

it("allows retry after preparation rejects unload without disposing the draft owner", async () => {
  const { harness, model } = await unlockedInputSession();
  const unregister = model.registerExportPreparation!(async () => {
    throw new Error("Text layout failed.");
  });
  await expect(harness.session.prepareForUnload()).rejects.toThrow("Text layout failed.");
  expectRetainedInput(harness, model);
  unregister();
  await harness.session.prepareForUnload();
  expect(harness.session.documentModel).toBeUndefined();
});

it("treats pending source as dirty when an external file change arrives", async () => {
  const { harness, model } = await unlockedInputSession();
  const unregister = model.registerExportPreparation!(async () => {
    throw new Error("Uncommitted text");
  });
  harness.replaceExternal(documentFromSnapshot({ ...emptySnapshot(), revision: 12 }));
  expect(await harness.factory.notifyExternalChange(operation().documentId, operation())).toBe(
    "conflict",
  );
  expectRetainedInput(harness, model);
  unregister();
  harness.session.dispose();
});

it("keeps the committed document available when unload persistence fails and permits retry", async () => {
  const { harness, model } = await unlockedInputSession();
  model.commitElement(rectangle());
  harness.process.mockRejectedValueOnce(new Error("Vault unavailable"));
  await expect(harness.session.prepareForUnload()).rejects.toThrow("Could not persist");
  expect(harness.session.documentModel).toBe(model);
  expect(harness.session.getSnapshot().dirty).toBe(true);
  model.commitPage({ ...model.page, activeBufferLines: 4 });
  await harness.session.prepareForUnload();
  const parsed = await parseInkbookDocumentForTest(harness.content());
  expect(parsed.ok && parsed.value.snapshot.revision).toBe(9);
  expect(parsed.ok && parsed.value.snapshot.elements).toEqual([rectangle()]);
  expect(harness.session.documentModel).toBeUndefined();
});
