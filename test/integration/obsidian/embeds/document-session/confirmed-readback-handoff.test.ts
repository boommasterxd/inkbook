import { TFile, TFolder, type Vault } from "obsidian";
import { afterEach, expect, it, vi } from "vitest";

import { ObsidianInkbookDocumentRecognition } from "../../../../../src/obsidian/embeds/preview/document-recognition";
import type { PresentationAttachment } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import { createConfirmedPersistenceObserver } from "../../../../../src/obsidian/embeds/document-session/vault-document-model";
import { WorkspaceRuntimeLifecycle } from "../../../../../src/obsidian/embeds/workspace/workspace-runtime-lifecycle";
import { ObsidianVaultFileAdapter } from "../../../../../src/obsidian/vault/file-adapter";
import { notifyConfirmedPersistence } from "../../../../../src/persistence/saving/autosave/confirmed-persistence";
import { saveExistingFile } from "../../../../../src/persistence/saving/save-existing";
import * as preview from "../../../../../src/obsidian/embeds/preview/safe-preview-svg";
import { ChunkedSha256 } from "../../../../../src/persistence/serialization/chunked-output-sha256";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { createSnapshot } from "../../../../unit/persistence/serialization/fixtures";

const path = "drawings/confirmed.svg";
afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function serialized(revision: number) {
  const result = serializeInkbookDocument({ ...createSnapshot(), revision });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function createConfirmation(lifecycle: WorkspaceRuntimeLifecycle) {
  return createConfirmedPersistenceObserver({
    active: () => true,
    documentId: path,
    lockedAspectRatio: () => 4,
    persisted: (event) => lifecycle.handlePersisted(event),
  });
}

function createHarness(currentSave = { settlement: undefined as Promise<void> | undefined }) {
  const base = serialized(1);
  const output = serialized(2);
  let content = base.svg;
  const file = new (TFile as unknown as new (path: string, size: number) => TFile)(
    path,
    content.length,
  );
  const frames: Array<() => void> = [];
  const scheduler = {
    ...immediateWorkScheduler(),
    requestFrame: (callback: FrameRequestCallback) => {
      frames.push(() => callback(0));
      return frames.length;
    },
  };
  const read = vi.fn(async () => content);
  const cachedRead = vi.fn(async () => content);
  const notifyExternalChange = vi.fn(async () => "ignored" as const);
  const loaded: Promise<unknown>[] = [];
  const vault = {
    getFileByPath: () => file,
    getResourcePath: () => "app://vault/drawings/confirmed.svg",
    read,
    cachedRead,
    process: async (_file: TFile, update: (current: string) => string) => {
      content = update(content);
      file.stat.size = content.length;
      file.stat.mtime += 1;
      modified();
      return content;
    },
  } as unknown as Vault;
  const files = new ObsidianVaultFileAdapter(
    vault,
    { file: TFile, folder: TFolder },
    (value) => value,
  );
  const recognition = new ObsidianInkbookDocumentRecognition(vault, { workScheduler: scheduler });
  const attachment = {
    documentId: path,
    root: { getElementsByTagName: () => ({ item: () => null, length: 0 }) },
    setPreviewSource: async (source: string) => {
      const task = recognition.loadPreviewSource(path, source);
      loaded.push(task);
      await task;
    },
  } as unknown as PresentationAttachment;
  const lifecycle = new WorkspaceRuntimeLifecycle({
    activate: vi.fn(),
    fallbackWindow: () => undefined,
    isDisposed: () => false,
    currentSaveSettlement: () => currentSave.settlement,
    notifyExternalChange,
    presentations: () => [{ attachment, scene: undefined }],
    reloadPresentation: vi.fn(),
    vault,
    workScheduler: () => scheduler,
  });
  const accept = vi.fn((output?: { content: string; outputHash: string; signature: string }) => {
    if (output !== undefined)
      recognition.acceptConfirmedOutput(path, output.content, output.outputHash, output.signature);
  });
  lifecycle.setConfirmedOutputReceiver((_path, output) => accept(output));
  function modified() {
    files.noteModification(path);
    recognition.deferRefresh(path);
    lifecycle.handleVaultModification(path, accept);
  }
  const confirm = createConfirmation(lifecycle);
  return {
    base,
    output,
    files,
    currentSave,
    recognition,
    lifecycle,
    read,
    cachedRead,
    accept,
    loaded,
    frames,
    notifyExternalChange,
    modified,
    replace: (next: string) => {
      content = next;
    },
    confirm: (saved: Awaited<ReturnType<typeof saveExistingFile>>) =>
      notifyConfirmedPersistence(
        { confirmed: confirm, statusChanged: () => undefined },
        path,
        { revision: saved.revision, outputHash: saved.outputHash, type: "confirmed" },
        saved.readBack,
      ),
  };
}

function saveHarness(
  h: ReturnType<typeof createHarness>,
  verifier: Parameters<typeof saveExistingFile>[3] = {
    verify: async (content) => content === h.output.svg,
  },
) {
  const pending = saveExistingFile(
    {
      path,
      expectedBase: h.base.svg,
      output: h.output.svg,
      outputHash: h.output.hash,
      revision: 2,
    },
    { currentRevision: () => 2 },
    h.files,
    verifier,
  );
  h.currentSave.settlement = pending.then(h.confirm, () => undefined);
  return pending;
}

it("uses the actual verified read-back for recognition without another read, hash, or safe scan", async () => {
  const h = createHarness();
  const hash = vi.spyOn(ChunkedSha256.prototype, "update");
  const nativeHash = vi.spyOn(crypto.subtle, "digest");
  const scan = vi.spyOn(preview, "inspectPreviewSvg");
  const verifying = deferred();
  const release = deferred();
  const pending = saveHarness(h, {
    verify: async (content) => {
      verifying.resolve();
      await release.promise;
      return content === h.output.svg;
    },
  });
  await verifying.promise;
  h.frames.splice(0).forEach((frame) => frame());
  expect(h.read).toHaveBeenCalledTimes(2);
  release.resolve();
  await pending;
  await h.currentSave.settlement;
  await Promise.all(h.loaded);
  h.frames.forEach((frame) => frame());
  await Promise.resolve();
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.cachedRead).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(hash).not.toHaveBeenCalled();
  expect(nativeHash).not.toHaveBeenCalled();
  expect(h.accept).toHaveBeenCalledOnce();
  expect(h.notifyExternalChange).not.toHaveBeenCalled();
  h.lifecycle.dispose();
  h.recognition.dispose();
});

it("rejects a read-back invalidated by an external write during asynchronous verification", async () => {
  const h = createHarness();
  const verifying = deferred();
  const release = deferred();
  const pending = saveHarness(h, {
    verify: async () => {
      verifying.resolve();
      await release.promise;
      return true;
    },
  });
  await verifying.promise;
  h.frames.splice(0).forEach((frame) => frame());
  expect(h.read).toHaveBeenCalledTimes(2);
  h.replace(serialized(3).svg);
  h.modified();
  release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "read-back-mismatch" });
  await h.currentSave.settlement;
  await Promise.allSettled(h.loaded);
  h.frames.splice(0).forEach((frame) => frame());
  await vi.waitFor(() => expect(h.notifyExternalChange).toHaveBeenCalledOnce());
  expect(h.accept).not.toHaveBeenCalledWith(expect.objectContaining({ outputHash: h.output.hash }));
  h.lifecycle.dispose();
  h.recognition.dispose();
});
