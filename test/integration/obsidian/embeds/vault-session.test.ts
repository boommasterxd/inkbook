import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import type { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/public";
import type { AppliedElementMutation, ElementMutation } from "../../../../src/domain/store/public";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import type { PastePlan } from "../../../../src/persistence/clipboard/public";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";

import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
} from "../../../../src/persistence/worker/runtime/public";
import {
  documentFromSnapshot,
  emptySnapshot,
  createVaultSessionFactory,
  createReadOnlyVaultSession,
  operation,
  persistenceHarness,
  recoveryCopyVaultHarness,
  rectangle,
  TestTFile,
} from "./vault-session-fixtures";

async function applyElementMutation(
  model: EditableDocumentModel,
  mutation: ElementMutation,
): Promise<AppliedElementMutation | null> {
  const prepared = await model.prepareElementMutation(mutation, { isCancelled: () => false });
  return prepared.token === null ? null : model.commitPreparedElementMutation(prepared.token);
}

function sessionHarness(file: TFile, readBinary: unknown) {
  const factory = createVaultSessionFactory({ getFileByPath: () => file, readBinary });
  const session = factory.create({ documentId: file.path, sessionId: "session-1" });
  return { factory, session };
}

describe("vault-backed document session", () => {
  it("preflights and validates an SVG through the document runtime", async () => {
    const { bytes } = documentFromSnapshot();
    const file = new TestTFile("drawings/ink.svg", bytes.byteLength);
    const readBinary = vi.fn(async () => bytes.buffer.slice(0));
    const { factory, session } = sessionHarness(file, readBinary);

    await expect(session.unlock(operation())).resolves.toMatchObject({ status: "active" });
    expect(session.getSnapshot()).toMatchObject({ confirmedRevision: 7, revision: 7 });
    expect(factory.getDocumentModel("session-1")?.page).toEqual(emptySnapshot().page);
    expect(readBinary).toHaveBeenCalledWith(file);
    session.dispose();
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
  });

  it("does not adopt a fully valid file that changed after the visible preview", async () => {
    const snapshot = emptySnapshot();
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error("The test SVG could not be serialized.");
    const bytes = new TextEncoder().encode(serialized.value.svg);
    const file = new TestTFile("drawings/ink.svg", bytes.byteLength);
    const { factory, session } = sessionHarness(file, async () => bytes.buffer.slice(0));

    await expect(
      session.unlock({
        ...operation(),
        expectedSourceIdentity: { outputHash: "a".repeat(64), revision: snapshot.revision - 1 },
      }),
    ).resolves.toMatchObject({
      actualSourceIdentity: {
        outputHash: serialized.value.hash,
        revision: snapshot.revision,
      },
      status: "source-changed",
    });
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
  });

  it("keeps unload persistence alive through delayed read-back before terminal disposal", async () => {
    const { content, factory, holdProcess, process, session } = persistenceHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")?.commitElement(rectangle());
    const releaseProcess = holdProcess();

    const unload = session.prepareForUnload();
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    releaseProcess();
    await unload;
    const parsed = await parseInkbookDocumentForTest(content());
    expect(parsed.ok && parsed.value.snapshot.revision).toBe(8);
  });

  it("rejects an oversized file before reading bytes", async () => {
    const file = new TestTFile("drawings/ink.svg", 64 * 1024 * 1024 + 1);
    const readBinary = vi.fn();
    const { session } = sessionHarness(file, readBinary);

    await expect(session.unlock(operation())).resolves.toMatchObject({ status: "load-error" });
    expect(readBinary).not.toHaveBeenCalled();
  });

  it("rejects oversized bytes returned after a stale size preflight", async () => {
    const file = new TestTFile("drawings/ink.svg", 1);
    const readBinary = vi.fn(async () => new ArrayBuffer(FILE_SCHEMA_LIMITS.totalInputBytes + 1));
    const { session } = sessionHarness(file, readBinary);

    await expect(session.unlock(operation())).resolves.toMatchObject({ status: "load-error" });
    expect(readBinary).toHaveBeenCalledOnce();
  });

  it("adopts worker batches into the store with scheduler backpressure", async () => {
    const document = documentFromSnapshot({
      ...emptySnapshot(),
      elements: [rectangle()],
    });
    const file = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
    const yieldControl = vi.fn(async () => undefined);
    const factory = createVaultSessionFactory(
      { getFileByPath: () => file, readBinary: async () => document.bytes.buffer.slice(0) },
      undefined,
      (_documentId, isCancelled) => ({
        isCancelled,
        shouldYield: () => true,
        yieldControl,
      }),
    );
    const session = factory.create({ documentId: file.path, sessionId: "session-1" });

    await expect(session.unlock(operation())).resolves.toMatchObject({ status: "active" });
    expect(factory.getDocumentModel("session-1")?.store.get(rectangle().id)?.element).toEqual(
      rectangle(),
    );
    expect(yieldControl).toHaveBeenCalled();
  });
});

describe("vault-backed document executors", () => {
  it("falls back after one bounded native restart when worker construction remains unavailable", async () => {
    const document = documentFromSnapshot();
    const create = vi.fn(async (): Promise<DocumentRuntimePort> => {
      throw new Error("CSP blocked worker construction");
    });
    const { session } = createReadOnlyVaultSession(document, create);

    await expect(session.unlock(operation())).resolves.toMatchObject({
      status: "active",
      workerEpoch: 2,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().workerEpoch).toBe(2);
    await expect(session.unlock({ ...operation(), operationId: 2 })).resolves.toMatchObject({
      status: "load-error",
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("terminates an asynchronously constructed worker when unlock is cancelled", async () => {
    const { bytes } = documentFromSnapshot();
    const file = new TestTFile("drawings/ink.svg", bytes.byteLength);
    const runtime = new DocumentWorkerRuntime({ sessionId: "session-1", workerEpoch: 1 });
    const terminate = vi.spyOn(runtime, "terminate");
    let resolveRuntime: ((runtime: DocumentRuntimePort) => void) | undefined;
    const create = vi.fn(
      () =>
        new Promise<DocumentRuntimePort>((resolve) => {
          resolveRuntime = resolve;
        }),
    );
    const readBinary = vi.fn(async () => bytes.buffer.slice(0));
    const factory = createVaultSessionFactory({ getFileByPath: () => file, readBinary }, create);
    const session = factory.create({ documentId: file.path, sessionId: "session-1" });

    const unlocking = session.unlock(operation());
    session.cancelOperation(operation());
    resolveRuntime?.(runtime);

    await expect(unlocking).resolves.toMatchObject({ status: "load-error" });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(readBinary).not.toHaveBeenCalled();
  });
});

describe("vault-backed document persistence", () => {
  it("applies cut and paste as reversible single-revision mutations", async () => {
    const { factory, session } = persistenceHarness();
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1");
    if (model === undefined) throw new Error("Expected an editable document model.");
    const source = rectangle();
    model.commitElement(source);
    const record = model.store.get(source.id);
    if (record === undefined) throw new Error("Expected the committed source element.");

    const cut = await applyElementMutation(model, {
      bands: { content: [], highlight: [] },
      removeIds: [record.element.id],
    });
    expect(cut).not.toBeNull();
    expect(model.store.size).toBe(0);
    expect(model.revision).toBe(9);
    if (cut === null) throw new Error("Expected an applied cut mutation.");
    expect(await applyElementMutation(model, cut.reverse)).not.toBeNull();
    expect(model.store.size).toBe(1);
    expect(model.revision).toBe(10);

    const pasted = { ...source, id: "00000000-0000-4000-8000-000000000002" };
    const plan: PastePlan = {
      activateTool: "select",
      commandTimestamp: 2,
      contentIds: [pasted.id],
      elements: [pasted],
      highlightIds: [],
      insertAtBandFront: true,
      repeatState: { fingerprint: "test", pasteCount: 1 },
      selectedIds: [pasted.id],
      translation: { x: 0, y: 0 },
    };
    const paste = await applyElementMutation(model, {
      bands: { content: [source.id, ...plan.contentIds], highlight: plan.highlightIds },
      elements: plan.elements,
    });
    expect(paste).not.toBeNull();
    expect(model.store.size).toBe(2);
    expect(model.revision).toBe(11);
    if (paste === null) throw new Error("Expected an applied paste mutation.");
    expect(await applyElementMutation(model, paste.reverse)).not.toBeNull();
    expect(model.store.size).toBe(1);
    expect(model.revision).toBe(12);
    expect(await applyElementMutation(model, paste.forward)).not.toBeNull();
    expect(model.store.size).toBe(2);
    expect(model.revision).toBe(13);
    session.dispose();
  });
});

describe("vault-backed document save verification", () => {
  it("exports an editor commit, processes the exact base, and validates read-back", async () => {
    const { content, factory, process, session } = persistenceHarness();
    await session.unlock(operation());

    const model = factory.getDocumentModel("session-1");
    model?.commitElement(rectangle());
    const encoded = await model?.encodeClipboard(new Set([rectangle().id]));
    expect(encoded?.customText).toContain("inkbook-elements");
    expect(process).not.toHaveBeenCalled();
    if (encoded === null || encoded === undefined) throw new Error("Clipboard encoding failed.");
    const paste = await model?.planClipboardPaste(
      { customText: encoded.customText },
      { kind: "toolbar", visibleCanvasCenter: { x: 500, y: 500 } },
    );
    expect(paste).not.toBeNull();
    if (paste === null || paste === undefined) throw new Error("Clipboard paste planning failed.");
    if (model === undefined) throw new Error("Expected an editable document model.");
    expect(
      await applyElementMutation(model, {
        bands: { content: [rectangle().id, ...paste.contentIds], highlight: paste.highlightIds },
        elements: paste.elements,
      }),
    ).not.toBeNull();
    await expect(
      session.lockLatest({ ...operation(), operationId: 2, workspaceToken: 2 }),
    ).resolves.toMatchObject({ revision: 9, status: "confirmed" });

    expect(process).toHaveBeenCalledOnce();
    const parsed = await parseInkbookDocumentForTest(content());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.snapshot.revision).toBe(9);
      expect(parsed.value.snapshot.elements).toHaveLength(2);
      expect(parsed.value.snapshot.elements[0]).toEqual(rectangle());
    }
    expect(session.getSnapshot()).toMatchObject({ confirmedRevision: 9, dirty: false });
  });

  it("emits the locked-preview propagation hook only after confirmed persistence", async () => {
    const document = documentFromSnapshot();
    let content = document.svg;
    const file = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
    const persisted =
      vi.fn<
        (event: {
          readonly documentId: string;
          readonly outputHash: string;
          readonly revision: number;
        }) => void
      >();
    const copyHarness = recoveryCopyVaultHarness({
      file,
      getContent: () => content,
      getDocument: () => document,
    });
    const process = async (_file: TFile, update: (current: string) => string) => {
      content = update(content);
      file.stat.size = new TextEncoder().encode(content).byteLength;
      return content;
    };
    const factory = createVaultSessionFactory(
      { ...copyHarness.vault, process },
      undefined,
      undefined,
      {
        persisted,
      },
    );
    const session = factory.create({ documentId: file.path, sessionId: "session-1" });
    await session.unlock(operation());
    factory.getDocumentModel("session-1")?.commitElement(rectangle());

    await expect(session.lockLatest({ ...operation(), operationId: 2 })).resolves.toMatchObject({
      status: "confirmed",
    });

    const event = persisted.mock.calls[0]?.[0];
    expect(event?.documentId).toBe(file.path);
    expect(event?.revision).toBe(8);
    expect(event?.outputHash).toMatch(/^[a-f\d]{64}$/u);
  });
});

describe("vault-backed document recovery", () => {
  it("propagates an unchanged persisted identity without reloading the document", async () => {
    const { factory, session } = persistenceHarness();
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1");

    await expect(factory.notifyExternalChange("drawings/ink.svg", operation())).resolves.toBe(
      "unchanged",
    );
    expect(factory.getDocumentModel("session-1")).toBe(model);
  });

  it("exposes clean and dirty external-change outcomes through the factory hook", async () => {
    const { factory, replaceExternal, session } = persistenceHarness();
    await session.unlock(operation());
    replaceExternal(documentFromSnapshot({ ...emptySnapshot(), revision: 12 }));

    await expect(factory.notifyExternalChange("drawings/ink.svg", operation())).resolves.toBe(
      "reloaded",
    );
    expect(factory.getDocumentModel("session-1")?.revision).toBe(12);
    const dirtyHarness = persistenceHarness();
    await dirtyHarness.session.unlock(operation());
    dirtyHarness.factory.getDocumentModel("session-1")?.commitElement(rectangle());
    dirtyHarness.replaceExternal(documentFromSnapshot({ ...emptySnapshot(), revision: 13 }));
    await expect(dirtyHarness.factory.notifyExternalChange("drawings/ink.svg")).resolves.toBe(
      "conflict",
    );
  });

  it("adopts the externally reloaded snapshot and its worker baseline", async () => {
    const { factory, process, replaceExternal, session } = persistenceHarness();
    await session.unlock(operation());

    replaceExternal(
      documentFromSnapshot({
        ...emptySnapshot(),
        elements: [rectangle()],
        revision: 12,
      }),
    );
    await expect(
      session.resolveRecovery("reload-external", { ...operation(), operationId: 2 }),
    ).resolves.toMatchObject({ status: "confirmed" });

    const model = factory.getDocumentModel("session-1");
    expect(model?.revision).toBe(12);
    expect(model?.store.get(rectangle().id)?.element).toEqual(rectangle());
    model?.commitPage({ ...emptySnapshot().page, activeBufferLines: 4 });
    await expect(
      session.lockLatest({ ...operation(), operationId: 3, workspaceToken: 2 }),
    ).resolves.toMatchObject({ revision: 13, status: "confirmed" });
    expect(process).toHaveBeenCalledTimes(1);
  });
});

describe("vault-backed recovery copies", () => {
  it("exports and verifies a recoverable local copy without replacing the conflicted file", async () => {
    const { createdCopies, factory, process, session } = persistenceHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")?.commitElement(rectangle());

    await expect(
      session.resolveRecovery("save-local-copy", {
        ...operation(),
        baseRevision: 8,
        operationId: 2,
      }),
    ).resolves.toMatchObject({
      savedPath: "drawings/ink-recovered-1.svg",
      status: "confirmed",
    });

    expect(process).not.toHaveBeenCalled();
    const saved = createdCopies.get("drawings/ink-recovered-1.svg")?.text;
    expect(saved).toBeDefined();
    const parsed = await parseInkbookDocumentForTest(saved ?? "");
    expect(parsed.ok && parsed.value.snapshot.elements).toEqual([rectangle()]);
  });

  it("trashes an unverified recovery copy instead of retaining it", async () => {
    const { corruptCopyReads, createdCopies, factory, session } = persistenceHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")?.commitElement(rectangle());
    corruptCopyReads();

    await expect(
      session.resolveRecovery("save-local-copy", {
        ...operation(),
        baseRevision: 8,
        operationId: 2,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(createdCopies.has("drawings/ink-recovered-1.svg")).toBe(false);
  });

  it("trashes a stale recovery copy when a newer operation wins during read-back", async () => {
    const { createdCopies, factory, holdCopyRead, session } = persistenceHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")?.commitElement(rectangle());
    const releaseCopyRead = holdCopyRead();
    const recoveryOperation = { ...operation(), baseRevision: 8, operationId: 2 };

    const recovery = session.resolveRecovery("save-local-copy", recoveryOperation);
    await vi.waitFor(() => expect(createdCopies.has("drawings/ink-recovered-1.svg")).toBe(true));
    const newerRecovery = session.resolveRecovery("save-local-copy", {
      ...operation(),
      baseRevision: 8,
      operationId: 3,
    });
    await vi.waitFor(() => expect(createdCopies.has("drawings/ink-recovered-2.svg")).toBe(true));
    releaseCopyRead();

    await expect(recovery).resolves.toMatchObject({ status: "failed" });
    await expect(newerRecovery).resolves.toMatchObject({ status: "confirmed" });
    expect(createdCopies.has("drawings/ink-recovered-1.svg")).toBe(false);
    expect(createdCopies.has("drawings/ink-recovered-2.svg")).toBe(true);
  });
});
