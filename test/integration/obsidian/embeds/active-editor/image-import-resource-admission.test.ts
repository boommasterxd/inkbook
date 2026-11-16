// @vitest-environment happy-dom
import { expect, it, onTestFinished, vi } from "vitest";
import { ActiveImageSession } from "../../../../../src/obsidian/embeds/active-editor/image-session";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { validImageFixture } from "../../../../fixtures/persistence/images";
import { deferredImageSession } from "../../../../fixtures/obsidian/image-session";
import { operation, persistenceHarness } from "../document-session/vault-session-fixtures";

async function fixture() {
  const { asset } = await validImageFixture();
  const host = persistenceHarness();
  await host.session.unlock(operation());
  const model = host.session.documentModel!;
  const history = new ActiveEditorHistory(model);
  const committed = vi.fn();
  const failed = vi.fn();
  const session = new ActiveImageSession({
    model,
    history,
    ownerWindow: window,
    isEnabled: () => true,
    finishText: async () => true,
    selection: () => new Set(),
    select: () => undefined,
    visibleCenter: () => ({ x: 300, y: 300 }),
    onImportImages: async () => ({ resources: [asset], source: "image" }),
    onCommitted: committed,
    onFailed: failed,
  });
  onTestFinished(() => {
    session.dispose();
    history.dispose();
    host.session.dispose();
  });
  return { asset, host, model, history, session, committed, failed };
}

async function releasePreparation(
  gate: ReturnType<typeof deferredImageSession<void>>,
  settledType: () => string | undefined,
): Promise<void> {
  gate.resolve();
  await gate.promise;
  await vi.waitFor(() => expect(settledType()).toBe("fulfilled"));
  await Promise.resolve();
}

function expectUnpublishedImage(f: Awaited<ReturnType<typeof fixture>>, revision: number): void {
  expect(f.model.imageResource!(f.asset.id)).toBeUndefined();
  expect(f.model.imageResources).toEqual([]);
  expect(f.model.revision).toBe(revision);
  expect(f.model.store.size).toBe(0);
  expect(f.history.commandCount).toBe(0);
  expect(f.committed).not.toHaveBeenCalled();
}

it("discards a completed resource preparation when its importing operation was cancelled", async () => {
  const f = await fixture();
  const gate = deferredImageSession<void>();
  const ready = deferredImageSession<void>();
  const prepare = f.model.prepareImageResources!.bind(f.model);
  const staged = vi.spyOn(f.model, "prepareImageResources").mockImplementation(async (...args) => {
    const token = await prepare(...args);
    expect(token).not.toBeNull();
    ready.resolve();
    await gate.promise;
    return token;
  });
  f.session.import();
  await ready.promise;
  f.session.cancel();
  await releasePreparation(gate, () => staged.mock.settledResults[0]?.type);
  expectUnpublishedImage(f, 7);
  expect(f.failed).not.toHaveBeenCalled();
});

it("does not retain an image when append geometry is rejected", async () => {
  const f = await fixture();
  f.session.import({ x: 300, y: 1_000_000 });
  await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
  expectUnpublishedImage(f, 7);
});

it("keeps a staged image private when later document changes invalidate append preparation", async () => {
  const f = await fixture();
  const gate = deferredImageSession<void>();
  const ready = deferredImageSession<void>();
  const prepare = f.model.prepareElementAppend.bind(f.model);
  const staged = vi.spyOn(f.model, "prepareElementAppend").mockImplementation(async (...args) => {
    const result = await prepare(...args);
    expect(result.token).not.toBeNull();
    ready.resolve();
    await gate.promise;
    return result;
  });
  f.session.import();
  await ready.promise;
  f.model.commitPage({ ...f.model.page, activeBufferLines: 4 });
  expect(f.model.revision).toBe(8);
  await releasePreparation(gate, () => staged.mock.settledResults[0]?.type);
  expectUnpublishedImage(f, 8);
  expect(f.failed).not.toHaveBeenCalled();
});

it("publishes a successful import once and retains its resource across undo and redo", async () => {
  const f = await fixture();
  f.session.import();
  await vi.waitFor(() => expect(f.committed).toHaveBeenCalledOnce());
  expect(f.model.imageResource!(f.asset.id)).toBe(f.asset);
  expect(f.model.revision).toBe(8);
  expect(f.history.commandCount).toBe(1);
  expect(f.model.store.size).toBe(1);
  expect(await f.history.undoAsync()).toBe(true);
  expect(f.model.store.size).toBe(0);
  expect(f.model.imageResource!(f.asset.id)).toBe(f.asset);
  expect(await f.history.redoAsync()).toBe(true);
  expect(f.model.store.size).toBe(1);
  expect(f.model.imageResource!(f.asset.id)).toBe(f.asset);
  expect(f.failed).not.toHaveBeenCalled();
});
