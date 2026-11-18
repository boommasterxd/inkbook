// @vitest-environment happy-dom
import { expect, it, onTestFinished, vi } from "vitest";
import { ActiveImageSession } from "../../../../../src/obsidian/embeds/active-editor/image-session";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { PointV1 } from "../../../../../src/domain/schema/public";
import type { ImageImportRequest } from "../../../../../src/obsidian/embeds/active-scene/editor-chrome-openings";
import { capacityImageResource, validImageFixture } from "../../../../fixtures/persistence/images";
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
  const opened = deferredImageSession<ImageImportRequest>();
  const closed = deferredImageSession<void>();
  const dialog = new AbortController();
  const session = new ActiveImageSession({
    model,
    history,
    ownerWindow: window,
    isEnabled: () => true,
    finishText: async () => true,
    selection: () => new Set(),
    select: () => undefined,
    visibleCenter: () => ({ x: 300, y: 300 }),
    onImportImages: (_signal, _window, request) => {
      opened.resolve(request);
      return closed.promise;
    },
    onCommitted: committed,
    onFailed: failed,
  });
  onTestFinished(() => {
    closed.resolve();
    session.dispose();
    history.dispose();
    host.session.dispose();
  });
  const beginImport = async (point?: PointV1) => {
    session.import(point);
    const { submit } = await opened.promise;
    return (resources = [asset]) => submit({ resources, source: "pdf" }, dialog.signal);
  };
  return { asset, host, model, history, beginImport, opened, dialog, committed, failed };
}

function expectUnpublishedImage(f: Awaited<ReturnType<typeof fixture>>, revision: number): void {
  expect(f.model.imageResource!(f.asset.id)).toBeUndefined();
  expect(f.model.imageResources).toEqual([]);
  expect(f.model.revision).toBe(revision);
  expect(f.model.store.size).toBe(0);
  expect(f.history.commandCount).toBe(0);
  expect(f.committed).not.toHaveBeenCalled();
}

it("discards a completed resource preparation when the dialog is cancelled", async () => {
  const f = await fixture();
  const gate = deferredImageSession<void>();
  const ready = deferredImageSession<void>();
  const prepare = f.model.prepareImageResources!.bind(f.model);
  vi.spyOn(f.model, "prepareImageResources").mockImplementation(async (...args) => {
    const token = await prepare(...args);
    expect(token).not.toBeNull();
    ready.resolve();
    await gate.promise;
    return token;
  });
  const submit = await f.beginImport();
  const pending = submit();
  await ready.promise;
  f.dialog.abort();
  gate.resolve();
  expect(await pending).toBe("unavailable");
  expectUnpublishedImage(f, 7);
  expect(f.failed).not.toHaveBeenCalled();
});

it("does not retain an image when append geometry is rejected", async () => {
  const f = await fixture();
  const submit = await f.beginImport({ x: 300, y: 1_000_000 });
  await expect(submit()).rejects.toThrow();
  expectUnpublishedImage(f, 7);
});

it("keeps a staged image private after a revision change and allows a fresh submission", async () => {
  const f = await fixture();
  const gate = deferredImageSession<void>();
  const ready = deferredImageSession<void>();
  const prepare = f.model.prepareElementAppend.bind(f.model);
  vi.spyOn(f.model, "prepareElementAppend").mockImplementationOnce(async (...args) => {
    const result = await prepare(...args);
    expect(result.token).not.toBeNull();
    ready.resolve();
    await gate.promise;
    return result;
  });
  const submit = await f.beginImport();
  const pending = submit();
  await ready.promise;
  f.model.commitPage({ ...f.model.page, activeBufferLines: 4 });
  expect(f.model.revision).toBe(8);
  gate.resolve();
  expect(await pending).toBe("unavailable");
  expectUnpublishedImage(f, 8);
  expect(await submit()).toBe("committed");
  expect(f.history.commandCount).toBe(1);
  expect(f.model.revision).toBe(9);
  expect(f.failed).not.toHaveBeenCalled();
});

it("rejects competing submissions and retains one successful import across undo and redo", async () => {
  const f = await fixture();
  const prepare = vi.spyOn(f.model, "prepareImageResources");
  const submit = await f.beginImport();
  const pending = submit();
  expect(await submit()).toBe("unavailable");
  expect(await pending).toBe("committed");
  expect(await submit()).toBe("unavailable");
  expect(prepare).toHaveBeenCalledOnce();
  expect(f.committed).toHaveBeenCalledOnce();
  expect(f.model.imageResource!(f.asset.id)).toBe(f.asset);
  expect(f.model.revision).toBe(8);
  expect(f.history.commandCount).toBe(1);
  expect(f.model.store.size).toBe(1);
  expect(await f.history.undoAsync()).toBe(true);
  expect(f.model.store.size).toBe(0);
  expect(f.model.imageResource!(f.asset.id)).toBe(f.asset);
  expect((await f.opened.promise).retainedResources?.()).toEqual([f.asset]);
  expect(await f.history.redoAsync()).toBe(true);
  expect(f.model.store.size).toBe(1);
  expect(f.model.imageResource!(f.asset.id)).toBe(f.asset);
  expect(f.failed).not.toHaveBeenCalled();
});

it("checks available document capacity atomically and accepts a smaller retry", async () => {
  const f = await fixture();
  const [retained, first, second] = await Promise.all([
    capacityImageResource(1, 4000),
    capacityImageResource(2, 4000),
    capacityImageResource(3, 4000),
  ]);
  await f.model.addImageResources!([retained]);
  const prepare = vi.spyOn(f.model, "prepareElementAppend");
  const submit = await f.beginImport();
  expect(await submit([first, second])).toBe("capacity");
  expect(prepare).not.toHaveBeenCalled();
  expect(f.model.imageResources).toEqual([retained]);
  expect(f.model.store.size).toBe(0);
  expect(f.model.revision).toBe(7);
  expect(f.history.commandCount).toBe(0);
  expect(f.failed).not.toHaveBeenCalled();
  expect(await submit([first])).toBe("committed");
  expect(prepare).toHaveBeenCalledOnce();
  expect(f.model.imageResources).toEqual([retained, first]);
  expect(f.model.store.size).toBe(1);
  expect(f.model.revision).toBe(8);
  expect(f.history.commandCount).toBe(1);
});
